/**
 * Pilot cycle state machine — FindTarget → DrawBoard → Shoot → MoveBoard.
 *
 * The cycle allows jumping from any step to any other; strict 1→2→3→4
 * ordering is NOT enforced. MoveBoard can loop back to Shoot, DrawBoard,
 * or even FindTarget if a root target branch is invalidated.
 *
 * Stop condition flags are checked after every arrow log append.
 */

import type { TargetStore } from './targets.js';
import type { Target, TargetStatus, CycleStep, CycleState, LobsterEvent, TestExecutor } from './types.js';
import type { TargetDiscovery, CandidateTarget } from './discovery.js';
import type { PilotMode } from '../workflow/types.js';
import type { RouterAgent } from '../workflow/router-agent.js';

export interface ReviewFn {
  (target: Target, shotDelta: string, cwd: string): Promise<{ approved: boolean; feedback: string }>;
}

export interface StateMachineConfig {
  project: string;
  targetStore: TargetStore;
  review_enabled?: boolean;
  cwd?: string;
  reviewFn?: ReviewFn;
  /** 可选：测试执行器（用于客观评估前置） */
  testExecutor?: TestExecutor;
  /** 可选：自主目标发现模块 */
  targetDiscovery?: TargetDiscovery;
  /** 可选：PilotMode — 默认 'guard' */
  mode?: PilotMode;
  /** 可选：路由 Agent */
  routerAgent?: RouterAgent;
  onStatusChange?: (targetId: string, oldStatus: TargetStatus, newStatus: TargetStatus) => void;
  onEscalate?: (targetId: string, reason: string) => void;
}

export function createStateMachine(config: StateMachineConfig) {
  const { project, targetStore, onStatusChange, onEscalate, targetDiscovery } = config;

  const state: CycleState = {
    project,
    current_step: 'find_target',
    active_target_id: null,
    wake_ts: new Date().toISOString(),
    last_event: null,
  };

  function transition(step: CycleStep, targetId?: string) {
    state.current_step = step;
    if (targetId !== undefined) state.active_target_id = targetId;
  }

  function checkStopFlags(target: Target): { triggered: string[]; actions: string[] } {
    const sc = target.stop_conditions;
    const triggered: string[] = [];
    const actions: string[] = [];

    if (sc.route_broken.current >= sc.route_broken.n_failed_shots) {
      triggered.push('route_broken');
      actions.push('escalate_to_parent_drawboard');
    }

    if (sc.unreachable.current >= sc.unreachable.m_total_shots
        && sc.unreachable.moveboard_count >= 1) {
      triggered.push('unreachable');
      actions.push('mark_dead_escalate_parent');
    }

    for (const dep of sc.data_missing.depends_on) {
      if (dep.startsWith('!')) {
        triggered.push('data_missing');
        actions.push('pause_for_data');
        break;
      }
    }

    if (sc.human_intervention.irreversible_actions.length > 0
        || sc.human_intervention.auth_needed.length > 0) {
      // Only triggered when actually about to perform the action — not checked here statically.
      // The lobster LLM decides when to pause for human intervention during Shoot.
    }

    return { triggered, actions };
  }

  return {
    getState(): Readonly<CycleState> { return { ...state }; },

    setEvent(event: LobsterEvent) {
      state.last_event = event;
      state.wake_ts = event.ts;
    },

    /**
     * FindTarget: analyze project status to derive or select a root target.
     * Returns all root targets and the recommended next action.
     *
     * E5: 支持 pending_approval 状态的自主发现 target。
     */
    findTarget(): {
      roots: Target[];
      active_roots: Target[];
      pending_approval: Target[];
      suggestion: 'create_root' | 'resume_active' | 'all_complete' | 'review_candidates';
    } {
      transition('find_target');
      const roots = targetStore.list({ type: 'root_target' });
      const active = roots.filter(r => r.status === 'active');
      const pending = roots.filter(r => r.status === 'pending_approval');
      const allComplete = roots.length > 0 && roots.every(r => r.status === 'completed');

      // 如果有 pending_approval 的 target，优先提示用户审核
      if (pending.length > 0) {
        return {
          roots,
          active_roots: active,
          pending_approval: pending,
          suggestion: 'review_candidates',
        };
      }

      return {
        roots,
        active_roots: active,
        pending_approval: [],
        suggestion: allComplete ? 'all_complete' : active.length > 0 ? 'resume_active' : 'create_root',
      };
    },

    /**
     * DrawBoard: recursively decompose a root/test target into child test targets.
     * This returns the current children for LLM to decide what to create.
     */
    drawBoard(targetId: string): {
      target: Target;
      children: Target[];
      leaf_candidates: Target[];
    } {
      transition('draw_board', targetId);
      const target = targetStore.get(targetId);
      if (!target) throw new Error(`Target ${targetId} not found`);

      const children: Target[] = [];
      for (const cid of target.children_ids) {
        const child = targetStore.get(cid);
        if (child) children.push(child);
      }

      const leafCandidates = children.filter(c =>
        c.children_ids.length === 0 && c.status === 'active');

      return { target, children, leaf_candidates: leafCandidates };
    },

    /**
     * Shoot: execute against a leaf target. The caller (runtime) runs the
     * actual test and calls appendArrowLog. This method selects the next
     * leaf to shoot at.
     *
     * Mode-aware selection:
     * - mode='research': prefer research-type steps
     * - mode='assistant': return null (assistant_task handled directly by runtime)
     * - mode='guard' (default): existing least-attempted logic
     */
    selectShootTarget(): Target | null {
      const mode = config.mode ?? 'guard';

      // Assistant mode: no target selection, task handled directly
      if (mode === 'assistant') return null;

      const active = targetStore.list({ status: 'active' });
      const leaves = active.filter(t => t.children_ids.length === 0);
      if (leaves.length === 0) return null;

      // Research mode: prefer research-type targets
      if (mode === 'research') {
        const researchLeaves = leaves.filter(t =>
          t.suggested_pattern === 'research' || t.type === 'test_target');
        const candidates = researchLeaves.length > 0 ? researchLeaves : leaves;
        candidates.sort((a, b) => a.arrow_logs.length - b.arrow_logs.length);
        const leaf = candidates[0]!;
        transition('shoot', leaf.id);
        return leaf;
      }

      // Guard mode (default): prefer leaves with fewer arrow logs
      leaves.sort((a, b) => a.arrow_logs.length - b.arrow_logs.length);
      const leaf = leaves[0]!;

      transition('shoot', leaf.id);
      return leaf;
    },

    /**
     * Process shot result and determine next action based on stop flags.
     *
     * When review_enabled is true (default) and the shot is a hit, an
     * independent review Agent evaluates the result before marking
     * completed. Rejected hits trigger MoveBoard without incrementing
     * route_broken.
     *
     * When the target has a leaf_test field, objective evaluation is
     * performed BEFORE the subjective review. If the test fails, the
     * target is moved directly to MoveBoard without review.
     */
    async processShot(targetId: string, outcome: 'miss' | 'hit', delta: string): Promise<{
      next_step: CycleStep;
      target: Target;
      flags: string[];
    }> {
      const log = {
        ts: new Date().toISOString(),
        outcome,
        delta,
        next_action: outcome === 'hit' ? 'shoot' as const : 'moveboard' as const,
      };
      const target = targetStore.appendArrowLog(targetId, log);

      if (outcome === 'hit') {
        // Step 1: 客观评估前置（如果 target 有 leaf_test）
        const leafTest = target.stop_conditions.completed.leaf_test;
        if (leafTest && config.testExecutor && config.cwd) {
          const testResult = await config.testExecutor.execute(leafTest, config.cwd);

          if (!testResult.passed) {
            // 测试不通过，直接 MoveBoard，跳过 Review
            targetStore.moveBoard(targetId, target.title, `Test failed: ${testResult.output.slice(0, 200)}`);
            return { next_step: 'move_board', target, flags: ['test_failed'] };
          }
        }

        // Step 2: 主观 Review（如果启用）
        const reviewEnabled = config.review_enabled ?? true;

        if (reviewEnabled && config.reviewFn && config.cwd) {
          const review = await config.reviewFn(target, delta, config.cwd);

          if (!review.approved) {
            targetStore.moveBoard(targetId, target.title, `Review rejected: ${review.feedback}`);
            return { next_step: 'move_board', target, flags: ['review_rejected'] };
          }
        }

        // Step 3: 标记完成
        const oldStatus = target.status;
        targetStore.updateStatus(targetId, 'completed');
        targetStore.propagateCompletion(targetId);
        onStatusChange?.(targetId, oldStatus, 'completed');

        const flags = ['completed'];
        if (leafTest) flags.push('test_passed');

        return { next_step: 'draw_board', target, flags };
      }

      const { triggered, actions } = checkStopFlags(target);

      if (triggered.includes('route_broken')) {
        const oldStatus = target.status;
        targetStore.updateStatus(targetId, 'route_broken');
        onStatusChange?.(targetId, oldStatus, 'route_broken');
        onEscalate?.(targetId, `Route broken: ${target.stop_conditions.route_broken.current} consecutive misses`);
        return { next_step: 'draw_board', target, flags: triggered };
      }

      if (triggered.includes('unreachable')) {
        const oldStatus = target.status;
        targetStore.updateStatus(targetId, 'dead');
        onStatusChange?.(targetId, oldStatus, 'dead');
        onEscalate?.(targetId, `Unreachable: ${target.stop_conditions.unreachable.current} total shots with ${target.stop_conditions.unreachable.moveboard_count} moveboards`);
        return { next_step: 'find_target', target, flags: triggered };
      }

      if (triggered.includes('data_missing')) {
        const oldStatus = target.status;
        targetStore.updateStatus(targetId, 'paused_for_data');
        onStatusChange?.(targetId, oldStatus, 'paused_for_data');
        return { next_step: 'find_target', target, flags: triggered };
      }

      return { next_step: 'move_board', target, flags: [] };
    },

    /**
     * MoveBoard: update target after analyzing shot delta.
     * Returns next suggested step.
     */
    moveBoard(targetId: string, newTitle: string, newDescription: string): {
      target: Target;
      next_step: CycleStep;
    } {
      transition('move_board', targetId);
      const target = targetStore.moveBoard(targetId, newTitle, newDescription);
      return { target, next_step: 'shoot' };
    },

    /** Pause a target for human intervention or data. */
    pauseTarget(targetId: string, reason: 'data_missing' | 'human_intervention'): Target {
      const status: TargetStatus = reason === 'data_missing' ? 'paused_for_data' : 'paused_for_human';
      const target = targetStore.updateStatus(targetId, status);
      onStatusChange?.(targetId, 'active', status);
      return target;
    },

    /** Resume a paused target. */
    resumeTarget(targetId: string): Target {
      const target = targetStore.get(targetId);
      if (!target) throw new Error(`Target ${targetId} not found`);
      const oldStatus = target.status;
      const updated = targetStore.updateStatus(targetId, 'active');
      onStatusChange?.(targetId, oldStatus, 'active');
      return updated;
    },

    /** Approve a pending target (E5: 自主目标确认). */
    approveTarget(targetId: string): Target {
      const target = targetStore.get(targetId);
      if (!target) throw new Error(`Target ${targetId} not found`);
      if (target.status !== 'pending_approval') {
        throw new Error(`Target ${targetId} is not pending_approval (status: ${target.status})`);
      }
      const updated = targetStore.updateStatus(targetId, 'active');
      onStatusChange?.(targetId, 'pending_approval', 'active');
      return updated;
    },

    /** Reject a pending target (E5: 自主目标拒绝). */
    rejectTarget(targetId: string, reason: string): Target {
      const target = targetStore.get(targetId);
      if (!target) throw new Error(`Target ${targetId} not found`);
      if (target.status !== 'pending_approval') {
        throw new Error(`Target ${targetId} is not pending_approval (status: ${target.status})`);
      }
      const updated = targetStore.updateStatus(targetId, 'dead');
      onStatusChange?.(targetId, 'pending_approval', 'dead');
      return updated;
    },

    /**
     * Run autonomous target discovery (E5: 自主目标发现).
     * Returns discovered candidates and creates pending_approval targets.
     */
    async runDiscovery(): Promise<CandidateTarget[]> {
      if (!targetDiscovery) {
        console.error('[StateMachine] targetDiscovery not configured');
        return [];
      }

      const candidates = await targetDiscovery.discover(project);

      // 为每个候选创建 pending_approval 状态的 target
      for (const candidate of candidates) {
        const targetId = `discovered-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        targetStore.create({
          id: targetId,
          type: candidate.type,
          title: candidate.title,
          description: candidate.description,
          parent_id: null,
          status: 'pending_approval',
          stop_conditions: {
            route_broken: { n_failed_shots: 3, current: 0 },
            data_missing: { depends_on: [] },
            human_intervention: { irreversible_actions: [], auth_needed: [] },
            unreachable: { m_total_shots: 5, current: 0, moveboard_count: 0 },
            completed: {},
          },
          polaris_feature_ref: null,
        });
      }

      return candidates;
    },
  };
}

export type StateMachine = ReturnType<typeof createStateMachine>;

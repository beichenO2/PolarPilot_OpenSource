/**
 * Pilot Runtime — orchestrates the full lifecycle of a project lobster:
 *
 *  1. lobster_start --project <name> → spawn
 *  2. Alignment 5-step
 *  3. State machine cycle (FindTarget → DrawBoard → Shoot → MoveBoard)
 *  4. Crystallize significant findings
 *  5. Sleep until next event or scheduled health scan
 *
 * Environment variables set by daemon on spawn:
 *   POLAR_USER_ID=project:<name>
 *   LOBSTER_PROJECT=<name>
 *   LOBSTER_EVENT_TS=<iso-ts>   (which event triggered this wake)
 */

import { join } from 'node:path';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createTargetStore, type TargetStore } from './targets.js';
import { createDedup, type Dedup } from './dedup.js';
import { runAlignment, type AlignmentResult } from './align.js';
import { createStateMachine, type StateMachine } from './state-machine.js';
import { extractArrowLogs } from './arrow-log-exporter.js';
import type { PilotRuntimeConfig, LobsterEvent, AssistantTaskDone, AgentName } from './types.js';
import type { PilotMode, AssistantTask } from '../workflow/types.js';
import type { WorkflowCompiler } from '../workflow/compiler.js';
import type { RouterAgent } from '../workflow/router-agent.js';
import type { MemoryManager } from '../workflow/memory.js';
import { Orchestrator, type TargetProvider } from '../core/orchestrator.js';
import { loadConfig } from '../core/config.js';
import { createAgent } from '../core/agents/factory.js';
import { setupRun } from '../core/run.js';
import { getHeadCommit } from '../core/git.js';

export interface PilotRuntimeDeps {
  config: PilotRuntimeConfig;
  onLog?: (level: string, msg: string) => void;
  onCrystallize?: (project: string, finding: string) => void;
  onNotifyUser?: (project: string, reason: string, details: string) => void;
  /** 可选：arrow_logs 导出回调（在 onCrystallize 时触发） */
  onExportArrowLogs?: (project: string, logs: ReturnType<typeof extractArrowLogs>) => void;
  /** 可选：PilotMode — 默认 'guard' */
  mode?: PilotMode;
  /** 可选：路由 Agent */
  routerAgent?: RouterAgent;
  /** 可选：Workflow 编译器 */
  workflowCompiler?: WorkflowCompiler;
  /** 可选：记忆管理器 */
  memoryManager?: MemoryManager;
  /** 可选：来自 PolarClaw 的 assistant 任务 */
  assistantTask?: AssistantTask;
}

export interface PilotRuntimeHandle {
  readonly project: string;
  readonly targetStore: TargetStore;
  readonly dedup: Dedup;
  readonly stateMachine: StateMachine;
  align(): AlignmentResult;
  getStatus(): PilotStatus;
  /** 手动触发 arrow_logs 导出 */
  exportArrowLogs(): void;
  stop(): void;
}

export interface PilotStatus {
  project: string;
  state: string;
  active_target_id: string | null;
  target_counts: { active: number; completed: number; dead: number; paused: number; total: number };
  last_alignment_ts: string | null;
  dedup_tracked: number;
}

export function createPilotRuntime(deps: PilotRuntimeDeps): PilotRuntimeHandle {
  const { config, onLog, onCrystallize, onNotifyUser, onExportArrowLogs } = deps;
  const log = (level: string, msg: string) => {
    onLog?.(level, `[Pilot:${config.project}] ${msg}`);
    console.error(`[Pilot:${config.project}] ${msg}`);
  };

  const polarisorRoot = join(homedir(), 'Polarisor');
  const projectDir = join(polarisorRoot, config.project);

  if (!existsSync(config.targets_dir)) {
    mkdirSync(config.targets_dir, { recursive: true });
    log('info', `Created targets dir: ${config.targets_dir}`);
  }

  const targetStore = createTargetStore({ targetsDir: config.targets_dir });
  const dedup = createDedup({ windowMs: config.dedup_window_ms });

  /** 导出 arrow_logs 到 PolarClaw */
  function exportArrowLogs(): void {
    const logs = extractArrowLogs(targetStore, config.project);
    if (logs.length === 0) return;

    log('info', `Exporting ${logs.length} arrow_logs to PolarClaw`);
    onExportArrowLogs?.(config.project, logs);
  }

  let lastAlignmentTs: string | null = null;

  const stateMachine = createStateMachine({
    project: config.project,
    targetStore,
    mode: deps.mode,
    routerAgent: deps.routerAgent,
    onStatusChange(targetId, oldStatus, newStatus) {
      log('info', `Target ${targetId}: ${oldStatus} → ${newStatus}`);
      if (newStatus === 'paused_for_data' || newStatus === 'paused_for_human') {
        const target = targetStore.get(targetId);
        const reason = newStatus === 'paused_for_data' ? 'data_missing' : 'human_intervention';
        onNotifyUser?.(config.project, reason, `Target "${target?.title ?? targetId}" needs attention`);
        writeEvent({
          ts: new Date().toISOString(),
          type: 'bug',
          source_project: config.project,
          target_project: config.project,
          severity: 'medium',
          payload: { target_id: targetId, reason, old_status: oldStatus, new_status: newStatus },
          dedup_key: `${config.project}:status:${targetId}:${newStatus}`,
        });
      }
    },
    onEscalate(targetId, reason) {
      log('warn', `Escalation: ${targetId} — ${reason}`);
      onCrystallize?.(config.project, `Escalation on target ${targetId}: ${reason}`);
      // 触发 arrow_logs 导出
      exportArrowLogs();
    },
  });

  function writeEvent(event: LobsterEvent): void {
    if (!config.events_path) return;
    try {
      const dir = join(config.events_path, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(config.events_path, JSON.stringify(event) + '\n');
    } catch (err) {
      log('error', `Failed to write event: ${err}`);
    }
  }

  function align(): AlignmentResult {
    const mode = deps.mode ?? 'guard';

    // NOTE: assistant_task should be handled by runAssistantTask(), not align().
    // This fallback exists only for legacy daemon code paths still calling align().
    // After Step 6 (daemon.ts route), this branch is never hit by the daemon.
    if (mode === 'assistant' && deps.assistantTask) {
      log('info', `Assistant mode (legacy fallback): running alignment — ${deps.assistantTask.fundamentalGoal}`);
      const result = runAlignment({
        projectName: config.project,
        projectDir,
        eventsPath: config.events_path,
        targetStore,
      });
      lastAlignmentTs = result.ts;
      return result;
    }

    log('info', 'Running 5-step alignment...');
    const result = runAlignment({
      projectName: config.project,
      projectDir,
      eventsPath: config.events_path,
      targetStore,
    });
    lastAlignmentTs = result.ts;

    // Research mode: log research goal
    if (mode === 'research') {
      log('info', 'Research mode: alignment complete with research goal injection');
    }

    log('info', `Alignment done: ${result.active_targets.length} active targets, ${result.recent_events.length} recent events, branch=${result.git.current_branch}`);
    return result;
  }

  function getStatus(): PilotStatus {
    const all = targetStore.list();
    return {
      project: config.project,
      state: stateMachine.getState().current_step,
      active_target_id: stateMachine.getState().active_target_id,
      target_counts: {
        active: all.filter(t => t.status === 'active').length,
        completed: all.filter(t => t.status === 'completed').length,
        dead: all.filter(t => t.status === 'dead' || t.status === 'route_broken').length,
        paused: all.filter(t => t.status === 'paused_for_data' || t.status === 'paused_for_human').length,
        total: all.length,
      },
      last_alignment_ts: lastAlignmentTs,
      dedup_tracked: dedup.size(),
    };
  }

  function stop() {
    dedup.stop();
    log('info', 'Runtime stopped');
  }

  log('info', `Pilot Runtime initialized for project: ${config.project}`);
  return { project: config.project, targetStore, dedup, stateMachine, align, getStatus, exportArrowLogs, stop };
}

// ── Assistant task direct execution ────────────────────────────
//
// `runAssistantTask` is the canonical entry point for executing an
// `assistant_task` event in PolarPilot. It bypasses the guard-mode
// alignment / state-machine cycle entirely:
//
//   1. Build a one-shot Orchestrator (claude or codex agent).
//   2. Inject a pseudo target whose `goal` = task.fundamentalGoal and
//      `leaf_test` = task.stopCondition.successCriteria so that the
//      orchestrator's stopWhen short-circuits the loop on success.
//   3. After the orchestrator settles (success / failure / abort), emit
//      an `assistant_task_done` event into `eventsPath` (default
//      `SOTAgent/data/lobster-events.jsonl`).
//
// Failure paths (no git repo, agent throws, max-iterations exceeded,
// max-tokens exceeded) all still produce a done event with the
// appropriate status so the upstream PolarClaw side is never left in
// limbo.

export interface RunAssistantTaskOpts {
  project: string;
  task: AssistantTask;
  task_id?: string;
  agent?: AgentName;
  maxIterations?: number;
  maxTokens?: number;
  worktree?: boolean;
  eventsPath: string;
  /** Optional cwd override (defaults to `~/Polarisor/<project>`). */
  cwd?: string;
  /** Optional log sink (default: console.error). */
  onLog?: (level: string, msg: string) => void;
}

function buildAssistantPrompt(task: AssistantTask): string {
  return [
    '# Assistant Task',
    '',
    '## Fundamental Goal',
    task.fundamentalGoal,
    '',
    '## Execution Approach',
    task.executionApproach,
    '',
    '## Stop Conditions',
    `- success: ${task.stopCondition.successCriteria}`,
    `- failure: ${task.stopCondition.failureCriteria}`,
  ].join('\n');
}

function writeDoneEvent(eventsPath: string, done: AssistantTaskDone, sourceProject = 'PolarPilot', targetProject = 'PolarClaw'): void {
  const event: LobsterEvent = {
    ts: done.finished_at,
    type: 'assistant_task_done',
    source_project: sourceProject,
    target_project: targetProject,
    severity: done.status === 'success' ? 'info' : 'medium',
    payload: done as unknown as Record<string, unknown>,
    dedup_key: `assist:${done.task_id}:done`,
  };
  try {
    const dir = join(eventsPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(eventsPath, JSON.stringify(event) + '\n');
  } catch (err) {
    console.error(`[runAssistantTask] failed to append done event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function classifyStatus(lastMessage: string | null, successCount: number, hadError: boolean): AssistantTaskDone['status'] {
  if (hadError) return 'failure';
  if (lastMessage === 'stop condition met') return 'success';
  if (lastMessage && lastMessage.startsWith('max iterations')) return 'timeout';
  if (lastMessage && lastMessage.startsWith('max tokens')) return 'timeout';
  if (lastMessage && lastMessage.startsWith('3 consecutive failures')) return 'failure';
  if (successCount > 0) return 'success';
  return 'failure';
}

export async function runAssistantTask(opts: RunAssistantTaskOpts): Promise<AssistantTaskDone> {
  const task_id = opts.task_id ?? `assist-${Date.now()}`;
  const started_at = new Date().toISOString();
  const log = (level: string, msg: string) => {
    opts.onLog?.(level, msg);
    console.error(`[runAssistantTask:${task_id}] ${msg}`);
  };

  const polarisorRoot = join(homedir(), 'Polarisor');
  const cwd = opts.cwd ?? join(polarisorRoot, opts.project);

  const done: AssistantTaskDone = {
    task_id,
    status: 'failure',
    summary: '',
    artifacts: [],
    iterations: 0,
    tokens_used: 0,
    started_at,
    finished_at: started_at,
  };

  try {
    if (!existsSync(cwd) || !existsSync(join(cwd, '.git'))) {
      throw new Error(`Project cwd is not a git repository: ${cwd}`);
    }

    const config = loadConfig(opts.agent ? { agent: opts.agent } : undefined);
    const baseCommit = getHeadCommit(cwd);
    const runId = `assist-${task_id}-${Date.now()}`;
    const prompt = buildAssistantPrompt(opts.task);
    const runInfo = setupRun(runId, prompt, baseCommit, cwd, {
      stopWhen: opts.task.stopCondition.successCriteria,
    });

    const agent = createAgent(config.agent, config.agentPathOverride[config.agent], config.agentArgsOverride[config.agent]);

    const provider: TargetProvider = {
      getCurrentTarget: () => ({
        id: task_id,
        title: opts.task.fundamentalGoal.slice(0, 80),
        description: opts.task.executionApproach,
      }),
      onShotResult: () => {},
    };

    const orch = new Orchestrator(config, agent, runInfo, prompt, cwd, 0, {
      maxIterations: opts.maxIterations,
      maxTokens: opts.maxTokens,
      stopWhen: opts.task.stopCondition.successCriteria,
      targetProvider: provider,
    });

    const collectedChanges: string[] = [];
    orch.on('iteration:end', (rec) => {
      for (const c of rec.keyChanges) {
        if (!collectedChanges.includes(c)) collectedChanges.push(c);
      }
    });

    log('info', `Starting orchestrator for task: ${opts.task.fundamentalGoal}`);
    await orch.start();

    const state = orch.getState();
    const status = classifyStatus(state.lastMessage, state.successCount, !!state.lastAgentError);

    done.status = status;
    done.summary = state.iterations.length > 0
      ? (state.iterations[state.iterations.length - 1]!.summary ?? '')
      : (state.lastMessage ?? '');
    done.artifacts = collectedChanges;
    done.iterations = state.currentIteration;
    done.tokens_used = state.totalInputTokens + state.totalOutputTokens;
    done.finished_at = new Date().toISOString();
    if (state.lastAgentError) done.error = state.lastAgentError;
    log('info', `Orchestrator finished: status=${status} iterations=${done.iterations} tokens=${done.tokens_used}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    done.status = 'failure';
    done.summary = `Assistant task aborted before orchestrator start: ${msg}`;
    done.error = msg;
    done.finished_at = new Date().toISOString();
    log('error', `runAssistantTask failed: ${msg}`);
  }

  writeDoneEvent(opts.eventsPath, done);
  return done;
}

/**
 * Pilot Runtime — Shared types for the "找目标→画靶子→射箭→挪靶子" cycle.
 *
 * Pilot is PolarClaw's autonomous project evolution system. Each managed project
 * gets a project lobster identity (PolarUser.project) running inside PolarClaw,
 * NOT a separate Pilot copied into each project.
 */

// ── Target node (靶子) ──────────────────────────────────

export type TargetType = 'root_target' | 'test_target';

export type TargetStatus =
  | 'active'
  | 'completed'
  | 'route_broken'
  | 'paused_for_data'
  | 'paused_for_human'
  | 'pending_approval'  // 自主发现的 target 待确认
  | 'dead';

export interface StopConditions {
  route_broken: {
    n_failed_shots: number;
    current: number;
  };
  data_missing: {
    depends_on: string[];
  };
  human_intervention: {
    irreversible_actions: string[];
    auth_needed: string[];
  };
  unreachable: {
    m_total_shots: number;
    current: number;
    moveboard_count: number;
  };
  completed: {
    leaf_test?: string;
  };
}

export interface ArrowLog {
  ts: string;
  outcome: 'miss' | 'hit';
  delta: string;
  next_action: 'shoot' | 'moveboard' | 'escalate';
}

export interface Target {
  id: string;
  type: TargetType;
  title: string;
  description: string;
  parent_id: string | null;
  children_ids: string[];
  status: TargetStatus;
  stop_conditions: StopConditions;
  polaris_feature_ref: string | null;
  arrow_logs: ArrowLog[];
  created_at: string;
  updated_at: string;
  suggested_pattern?: string;
}

// ── Lobster event (from lobster-events.jsonl) ───────────

export type LobsterEventType =
  | 'bug'
  | 'digist_report'
  | 'contract_red'
  | 'git_push_main'
  | 'scheduled_health_scan'
  | 'assistant_task'
  | 'assistant_task_done'
  | 'custom';

export type LobsterEventSeverity = 'low' | 'medium' | 'high' | 'critical' | 'info';

export interface LobsterEvent {
  ts: string;
  type: LobsterEventType;
  source_project: string;
  target_project: string;
  severity: LobsterEventSeverity;
  payload: Record<string, unknown>;
  dedup_key: string;
}

// ── Assistant task result (assistant_task_done payload) ─

export interface AssistantTaskDone {
  task_id: string;
  status: 'success' | 'failure' | 'timeout' | 'aborted';
  summary: string;
  artifacts: string[];
  iterations: number;
  tokens_used: number;
  started_at: string;
  finished_at: string;
  error?: string;
}

// ── State machine cycle ─────────────────────────────────

export type CycleStep = 'find_target' | 'draw_board' | 'shoot' | 'move_board';

export interface CycleState {
  project: string;
  current_step: CycleStep;
  active_target_id: string | null;
  wake_ts: string;
  last_event: LobsterEvent | null;
}

// ── Test execution (objective evaluation) ─────────────────

export interface TestResult {
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface TestExecutor {
  execute(testCommand: string, cwd: string): Promise<TestResult>;
}

// ── Runtime configuration ───────────────────────────────

export interface PilotRuntimeConfig {
  project: string;
  events_path: string;
  targets_dir: string;
  dedup_window_ms: number;
  health_scan_cron: string;
  route_broken_n: number;
  unreachable_m: number;
  review_enabled?: boolean;
  review_agent?: AgentName;
  /** 可选：测试执行器（用于客观评估前置） */
  test_executor?: TestExecutor;
  /** 可选：工作目录（用于测试执行） */
  cwd?: string;
}

export type AgentName = 'claude' | 'codex';

export const DEFAULT_PILOT_CONFIG: Omit<PilotRuntimeConfig, 'project' | 'targets_dir'> = {
  events_path: '',
  dedup_window_ms: 10 * 60 * 1000,
  health_scan_cron: '0 3 * * *',
  route_broken_n: 3,
  unreachable_m: 5,
  review_enabled: true,
};

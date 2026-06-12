export type PilotMode = 'guard' | 'research' | 'assistant';

export type BlockType = 'entity' | 'preference' | 'fact' | 'goal' | 'relationship' | 'event' | 'concept' | 'procedure' | 'emotion' | 'decision' | 'skill' | 'context' | 'meta';
export type BlockSource = 'conversation' | 'wiki' | 'agent_written' | 'user_explicit';

export interface PilotConfig {
  mode: PilotMode;
  healthScanCron?: string;
  discoveryEnabled?: boolean;
  researchGoal?: string;
  deliverables?: string[];
  taskFromClaw?: string;
  reportInterval?: number;
}

export interface CompiledWorkflow {
  id: string;
  name: string;
  steps: Map<string, StepDef>;
  edges: Edge[];
  entry_point: string;
  terminal_points: string[];
}

export interface StepDef {
  id: string;
  name: string;
  type: 'research' | 'design' | 'implement' | 'test' | 'review' | 'terminal';
  agent: string;
  input: string[];
  output: string[];
  timeout?: string;
  on_failure?: { action: string; max_retry?: number };
  leaf_test?: string;
}

export interface Edge {
  from: string;
  to: string;
  condition: 'success' | 'failure' | 'always' | 'all_done' | 'custom';
  custom_condition?: string;
}

export interface WorkflowPlan {
  chains: TaskChain[];
  parallelGroups: string[][];
}

export interface TaskChain {
  id: string;
  tasks: string[];
  loop?: {
    target: string;
    maxIterations: number;
    convergenceCondition: string;
  };
}

export interface ComplexityJudgment {
  action: 'direct_execute' | 'split_and_race';
  reason: string;
  initialSplit?: WorkflowPlan;
}

export interface StepInput {
  step_id: string;
  task: string;
  context: string;
  constraints: string[];
  input_files?: string[];
}

export interface StepOutput {
  step_id: string;
  result: 'success' | 'failure' | 'need_retry';
  summary: string;
  artifacts: string[];
  learnings: string[];
  next_hint?: string;
}

export interface Block {
  label: string;
  value: string;
  tokens: number;
  read_only: boolean;
  source_wiki: string;
  created_at: string;
  updated_at: string;
  type?: BlockType;
  temporal?: {
    valid_from?: string;
    valid_until?: string;
    recurrence?: string;
  };
  confidence?: number;
  source?: BlockSource;
  entity_refs?: string[];
}

export interface BlockSearchResult {
  blocks: Block[];
  total: number;
  query: string;
}

export interface Checkpoint {
  workflow_id: string;
  current_step: string;
  completed_steps: string[];
  global_learnings: string[];
  artifacts: Record<string, string>;
  updated_at: string;
}

export interface AssistantTask {
  fundamentalGoal: string;
  executionApproach: string;
  stopCondition: {
    successCriteria: string;
    failureCriteria: string;
  };
}

export type {
  CompiledWorkflow,
  StepDef,
  Edge,
  PilotMode,
  PilotConfig,
  WorkflowPlan,
  TaskChain,
  ComplexityJudgment,
  StepInput,
  StepOutput,
  Block,
  BlockSearchResult,
  Checkpoint,
  AssistantTask,
} from './types.js';
export { createWorkflowCompiler, fetchKnowledgeEnrichment, type WorkflowCompiler, type WorkflowCompilerConfig } from './compiler.js';
export { createMemoryManager, type MemoryManager, type MemoryManagerConfig } from './memory.js';
export { createRouterAgent, type RouterAgent, type RouterAgentConfig } from './router-agent.js';
export {
  createKnowLeverClient,
  type KnowLeverClient,
  type KnowLeverClientConfig,
  type KnowLeverSearchResult,
  type KnowLeverSearchResponse,
  type KnowLeverIngestDocument,
  type KnowLeverIngestResponse,
  type KnowLeverCompileResponse,
} from './knowlever-client.js';
export {
  createFourLayerMemoryManager,
  type FourLayerMemoryManager,
  type FourLayerMemoryConfig,
  type SoulLayerData,
  type LongTermLayerData,
  type ContextLayerData,
  type ScratchLayerData,
  type LayerData,
  LAYER_SOUL,
  LAYER_LONG_TERM,
  LAYER_CONTEXT,
  LAYER_SCRATCH,
  CLEAN_MEMORY_CLAUSE,
  validateMemoryWrite,
  sanitizeForLongTerm,
  recordViolation,
  getMemoryBoundaryReport,
  clearViolations,
  type LayerNumber,
  type MemoryBoundaryViolation,
  deduplicateKnowLeverResults,
} from './four-layer-memory.js';

// ── Workflow execution layer (Step 7) ───────────────────────────
//
// `executeWorkflow` is the canonical entry point for running a compiled
// research workflow. It traverses `compiled.edges` from `entry_point`
// to the first `terminal_points` step, launching one Orchestrator per
// step. Parallel execution is **not** implemented in this version —
// even `all_done` edges are treated as serial (see below).
//
// Edge condition dispatch:
//   - 'success'  → take this edge when the step output marks success.
//   - 'failure'  → take this edge when the step output marks failure.
//                  If no failure edge is present, the workflow fails fast.
//   - 'always'   → always take this edge (regardless of step outcome).
//   - 'all_done' → equivalent to 'success' in the serial implementation.
//   - 'custom'   → throws `WorkflowFeatureNotImplemented` (logged as
//                  follow-up in the task token).

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { CompiledWorkflow, StepDef, StepOutput, AssistantTask } from './types.js';
import { runAssistantTask, type RunAssistantTaskOpts } from '../pilot/runtime.js';
import type { AgentName } from '../pilot/types.js';
import { fetchKnowledgeEnrichment, type WorkflowCompilerConfig } from './compiler.js';

export class WorkflowFeatureNotImplemented extends Error {
  constructor(feature: string) {
    super(`Workflow feature not implemented: ${feature}`);
    this.name = 'WorkflowFeatureNotImplemented';
  }
}

export interface WorkflowExecutionCtx {
  project: string;
  agent?: AgentName;
  maxIterationsPerStep?: number;
  maxTokensTotal?: number;
  eventsPath: string;
  worktree?: boolean;
  /** Optional global goal injection (CLI promptArg). */
  goal?: string;
  /** Optional cwd override (defaults to `~/Polarisor/<project>`). */
  cwd?: string;
  /** When set, knowledge enrichment is fetched between steps and injected into context. */
  compilerConfig?: WorkflowCompilerConfig;
  onStepStart?: (step: StepDef) => void;
  onStepEnd?: (step: StepDef, output: StepOutput) => void;
  onLog?: (level: string, msg: string) => void;
}

export interface WorkflowExecutionResult {
  workflow_id: string;
  status: 'success' | 'failure';
  completed_steps: string[];
  failed_step?: string;
  failed_reason?: string;
  artifacts: Record<string, string>;
  step_outputs: StepOutput[];
  duration_ms: number;
}

function pickNextStep(
  compiled: CompiledWorkflow,
  currentStepId: string,
  outcome: 'success' | 'failure',
): { nextId: string | null; takenCondition?: string } {
  const out = compiled.edges.filter(e => e.from === currentStepId);
  if (out.length === 0) return { nextId: null };

  // 1. Priority: matching success/failure
  if (outcome === 'success') {
    const succ = out.find(e => e.condition === 'success' || e.condition === 'all_done');
    if (succ) return { nextId: succ.to, takenCondition: succ.condition };
  } else {
    const fail = out.find(e => e.condition === 'failure');
    if (fail) return { nextId: fail.to, takenCondition: fail.condition };
  }
  // 2. 'always' edge applies regardless of outcome
  const always = out.find(e => e.condition === 'always');
  if (always) return { nextId: always.to, takenCondition: always.condition };
  // 3. 'custom' is not supported in this version
  const custom = out.find(e => e.condition === 'custom');
  if (custom) throw new WorkflowFeatureNotImplemented(`custom edge (${currentStepId} → ${custom.to})`);
  return { nextId: null };
}

function buildStepTask(step: StepDef, ctx: WorkflowExecutionCtx, globalGoal: string | undefined, enrichment?: string): AssistantTask {
  const inputDesc = step.input.length > 0 ? `Inputs: ${step.input.join(', ')}` : '';
  const outputDesc = step.output.length > 0 ? `Expected outputs: ${step.output.join(', ')}` : '';
  const fundamentalGoal = [
    globalGoal ? `Overall workflow goal: ${globalGoal}` : '',
    `Step [${step.id}] ${step.name} (type=${step.type}).`,
    inputDesc,
    outputDesc,
    enrichment ?? '',
  ].filter(Boolean).join('\n');
  return {
    fundamentalGoal,
    executionApproach: `Workflow step ${step.id} via agent=${step.agent}`,
    stopCondition: {
      successCriteria: step.leaf_test ?? `Step ${step.id} completed and outputs produced.`,
      failureCriteria: step.on_failure?.action ?? `Step ${step.id} reports failure.`,
    },
  };
}

export async function executeWorkflow(
  compiled: CompiledWorkflow,
  ctx: WorkflowExecutionCtx,
): Promise<WorkflowExecutionResult> {
  const startedAt = Date.now();
  const log = (level: string, msg: string) => {
    ctx.onLog?.(level, msg);
    console.error(`[executeWorkflow:${compiled.id}] ${msg}`);
  };

  const result: WorkflowExecutionResult = {
    workflow_id: compiled.id,
    status: 'failure',
    completed_steps: [],
    artifacts: {},
    step_outputs: [],
    duration_ms: 0,
  };

  if (!compiled.entry_point) {
    result.failed_reason = 'workflow has no entry point';
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  const cwd = ctx.cwd ?? join(homedir(), 'Polarisor', ctx.project);
  let tokensRemaining = ctx.maxTokensTotal;

  let currentId: string | null = compiled.entry_point;
  const visited = new Set<string>();
  let pendingEnrichment: string | undefined;

  while (currentId !== null) {
    if (visited.has(currentId)) {
      result.failed_reason = `cycle detected at ${currentId}`;
      result.failed_step = currentId;
      break;
    }
    visited.add(currentId);

    const step = compiled.steps.get(currentId);
    if (!step) {
      result.failed_reason = `step not found: ${currentId}`;
      result.failed_step = currentId;
      break;
    }

    if (step.type === 'terminal') {
      log('info', `Reached terminal step: ${step.id}`);
      result.completed_steps.push(step.id);
      result.status = 'success';
      break;
    }

    log('info', `Starting step ${step.id} (${step.name})`);
    ctx.onStepStart?.(step);

    const task = buildStepTask(step, ctx, ctx.goal, pendingEnrichment);
    pendingEnrichment = undefined;
    const stepStarted = new Date().toISOString();

    const runOpts: RunAssistantTaskOpts = {
      project: ctx.project,
      task,
      task_id: `workflow-${compiled.id}-${step.id}-${Date.now()}`,
      eventsPath: ctx.eventsPath,
      cwd,
    };
    if (ctx.agent !== undefined) runOpts.agent = ctx.agent;
    if (ctx.maxIterationsPerStep !== undefined) runOpts.maxIterations = ctx.maxIterationsPerStep;
    if (tokensRemaining !== undefined) runOpts.maxTokens = tokensRemaining;
    if (ctx.worktree !== undefined) runOpts.worktree = ctx.worktree;

    const done = await runAssistantTask(runOpts);

    if (typeof tokensRemaining === 'number') {
      tokensRemaining = Math.max(0, tokensRemaining - done.tokens_used);
    }

    const stepOutput: StepOutput = {
      step_id: step.id,
      result: done.status === 'success' ? 'success' : (done.status === 'failure' ? 'failure' : 'need_retry'),
      summary: done.summary,
      artifacts: done.artifacts,
      learnings: [],
      next_hint: done.error,
    };
    result.step_outputs.push(stepOutput);
    for (const out of step.output) {
      result.artifacts[out] = done.artifacts.join(',') || `(step ${step.id} produced no artifact for ${out})`;
    }

    log('info', `Step ${step.id} finished: ${done.status}`);
    ctx.onStepEnd?.(step, stepOutput);

    // Fetch knowledge enrichment for the next step based on this step's output
    if (ctx.compilerConfig?.enableKnowledgeEnrichment && ctx.compilerConfig.knowleverClient) {
      const enrichmentQuery = `${step.name}: ${stepOutput.summary}`;
      try {
        pendingEnrichment = await fetchKnowledgeEnrichment(enrichmentQuery, ctx.compilerConfig);
        if (pendingEnrichment) {
          log('info', `Knowledge enrichment fetched for next step`);
        }
      } catch {
        log('warn', `Knowledge enrichment fetch failed for step ${step.id}`);
      }
    }

    result.completed_steps.push(step.id);

    const outcome: 'success' | 'failure' = done.status === 'success' ? 'success' : 'failure';
    const { nextId } = pickNextStep(compiled, currentId, outcome);

    if (!nextId) {
      // No applicable outgoing edge — workflow ends here.
      if (outcome === 'failure') {
        result.failed_step = step.id;
        result.failed_reason = done.error ?? `step ${step.id} failed without a failure / always edge`;
        result.status = 'failure';
      } else {
        result.status = 'success';
      }
      break;
    }
    currentId = nextId;
  }

  result.duration_ms = Date.now() - startedAt;
  return result;
}

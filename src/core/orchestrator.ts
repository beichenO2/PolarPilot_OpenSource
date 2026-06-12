import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PermanentAgentError, type Agent, type AgentOutput, type TokenUsage } from "./agents/types.js";
import type { Config } from "./config.js";
import type { RunInfo } from "./run.js";
import { appendNotes, toStringArray } from "./run.js";
import { appendDebugLog, serializeError } from "./debug-log.js";
import { commitAll, getBranchCommitCount, getCurrentBranch, getHeadCommit, resetHard } from "./git.js";
import { getInterruptDisposition, getInterruptHint, type InterruptDisposition, type InterruptHint } from "./interrupt-state.js";
import { buildCommitMessage, type CommitMessageConfig } from "./commit-message.js";
import { buildIterationPrompt } from "../templates/iteration-prompt.js";

export interface TargetProvider {
  getCurrentTarget(): { id: string; title: string; description: string } | null;
  onShotResult(result: ShotResult): void;
}

export interface ShotResult { iteration: number; success: boolean; summary: string; shotOutcome?: "hit" | "miss"; shotDelta?: string }
export interface IterationRecord { number: number; success: boolean; summary: string; keyChanges: string[]; keyLearnings: string[]; timestamp: Date }
export type { InterruptDisposition, InterruptHint } from "./interrupt-state.js";

export interface OrchestratorState {
  status: "running" | "waiting" | "aborted" | "stopped";
  gracefulStopRequested: boolean;
  interruptHint: InterruptHint;
  currentIteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  commitCount: number;
  iterations: IterationRecord[];
  successCount: number;
  failCount: number;
  consecutiveFailures: number;
  consecutiveErrors: number;
  startTime: Date;
  waitingUntil: Date | null;
  lastMessage: string | null;
  lastAgentError?: string | null;
}

export interface OrchestratorEvents {
  state: [OrchestratorState];
  "iteration:start": [number];
  "iteration:end": [IterationRecord];
  abort: [string];
  stopped: [];
}

export interface OrchestratorOptions {
  maxIterations?: number;
  maxTokens?: number;
  stopWhen?: string;
  targetProvider?: TargetProvider;
  commitMessage?: CommitMessageConfig;
}

type IterResult = { type: "completed"; record: IterationRecord; shouldFullyStop: boolean } | { type: "stopped" } | { type: "aborted"; reason: string };

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private config: Config;
  private agent: Agent;
  private runInfo: RunInfo;
  private cwd: string;
  private prompt: string;
  private options: OrchestratorOptions;
  private stopRequested = false;
  private stopPromise: Promise<void> | null = null;
  private activeIter: Promise<IterResult> | null = null;
  private ac: AbortController | null = null;
  private pendingAbort: string | null = null;
  private loopDone = false;
  private stoppedEmitted = false;
  private state: Omit<OrchestratorState, "interruptHint"> = {
    status: "running", gracefulStopRequested: false, currentIteration: 0,
    totalInputTokens: 0, totalOutputTokens: 0, commitCount: 0,
    iterations: [], successCount: 0, failCount: 0,
    consecutiveFailures: 0, consecutiveErrors: 0, startTime: new Date(),
    waitingUntil: null, lastMessage: null, lastAgentError: null,
  };

  constructor(config: Config, agent: Agent, runInfo: RunInfo, prompt: string, cwd: string, startIteration = 0, options: OrchestratorOptions = {}) {
    super();
    this.config = config; this.agent = agent; this.runInfo = runInfo;
    this.prompt = prompt; this.cwd = cwd; this.options = options;
    this.state.currentIteration = startIteration;
    this.state.commitCount = getBranchCommitCount(this.runInfo.baseCommit, this.cwd);
  }

  getState(): OrchestratorState { return { ...this.state, interruptHint: getInterruptHint(this.state) }; }

  requestGracefulStop(): void {
    if (this.stopRequested || this.state.gracefulStopRequested || this.loopDone) return;
    this.state.gracefulStopRequested = true;
    this.emit("state", this.getState());
    if (this.state.status === "waiting") this.ac?.abort();
  }

  handleInterrupt(): InterruptDisposition {
    const d = getInterruptDisposition(this.state);
    if (d === "request-graceful-stop") this.requestGracefulStop();
    else if (d === "force-stop") this.stop();
    return d;
  }

  stop(): void {
    this.stopRequested = true; this.ac?.abort(); this.state.gracefulStopRequested = false;
    if (this.loopDone) { this.emitStopped(); return; }
    if (this.stopPromise) return;
    this.stopPromise = (async () => {
      if (this.activeIter) {
        const p = this.activeIter.catch(() => undefined);
        await new Promise<void>((r) => { const t = setTimeout(r, 250); t.unref?.(); void p.finally(r); });
        await this.closeAgent(); await p;
      } else { await this.closeAgent(); }
      resetHard(this.cwd); this.state.status = "stopped";
      this.emit("state", this.getState()); this.emitStopped();
    })();
  }

  async start(): Promise<void> {
    this.state.startTime = new Date(); this.state.status = "running";
    this.emit("state", this.getState());
    appendDebugLog("orchestrator:start", { agent: this.agent.name, runId: this.runInfo.runId, startIteration: this.state.currentIteration });

    try {
      while (!this.stopRequested) {
        if (this.options.maxIterations !== undefined && this.state.currentIteration >= this.options.maxIterations) { this.doAbort(`max iterations (${this.options.maxIterations})`); break; }
        const tokAbort = this.tokenAbort(); if (tokAbort) { this.doAbort(tokAbort); break; }
        if (this.state.gracefulStopRequested) { this.state.status = "stopped"; this.state.gracefulStopRequested = false; this.emit("state", this.getState()); break; }

        this.state.currentIteration++; this.state.status = "running";
        this.emit("iteration:start", this.state.currentIteration); this.emit("state", this.getState());

        const target = this.options.targetProvider?.getCurrentTarget() ?? undefined;
        const iterPrompt = buildIterationPrompt({ n: this.state.currentIteration, runId: this.runInfo.runId, prompt: this.prompt, stopWhen: this.options.stopWhen, commitMessage: this.options.commitMessage, target: target ?? undefined });

        const t0 = Date.now();
        this.activeIter = this.runIter(iterPrompt);
        const result = await this.activeIter;
        this.activeIter = null;

        if (result.type === "stopped") break;
        if (result.type === "aborted") { this.doAbort(result.reason); break; }

        this.state.iterations.push(result.record);
        this.emit("iteration:end", result.record); this.emit("state", this.getState());
        appendDebugLog("iteration:end", { iteration: result.record.number, elapsedMs: Date.now() - t0, success: result.record.success });

        if (this.state.gracefulStopRequested) { this.state.status = "stopped"; this.state.gracefulStopRequested = false; this.emit("state", this.getState()); break; }
        if (this.options.stopWhen !== undefined && result.shouldFullyStop) { this.doAbort("stop condition met"); break; }
        if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) { this.doAbort(`${this.config.maxConsecutiveFailures} consecutive failures`); break; }

        if (this.state.consecutiveErrors > 0 && !this.stopRequested) {
          const ms = Math.min(60_000 * Math.pow(2, this.state.consecutiveErrors - 1), 15 * 60_000);
          this.state.status = "waiting"; this.state.waitingUntil = new Date(Date.now() + ms); this.emit("state", this.getState());
          await this.sleepInterruptible(ms);
          this.state.waitingUntil = null;
          if (!this.stopRequested) { if (this.state.gracefulStopRequested) { this.state.status = "stopped"; break; } this.state.status = "running"; this.emit("state", this.getState()); }
        }
      }
    } catch (err) { appendDebugLog("orchestrator:loop-error", { error: serializeError(err) }); throw err; }
    finally {
      this.activeIter = null;
      if (this.stopPromise) await this.stopPromise; else await this.closeAgent();
      this.loopDone = true;
      if (!this.stopPromise && this.state.status === "stopped") this.emitStopped();
      appendDebugLog("orchestrator:end", { status: this.state.status, iterations: this.state.currentIteration, successCount: this.state.successCount, failCount: this.state.failCount, commitCount: this.state.commitCount });
    }
  }

  private async runIter(prompt: string): Promise<IterResult> {
    const bIn = this.state.totalInputTokens; const bOut = this.state.totalOutputTokens;
    this.ac = new AbortController(); this.pendingAbort = null;
    const onUsage = (u: TokenUsage) => {
      this.state.totalInputTokens = bIn + u.inputTokens; this.state.totalOutputTokens = bOut + u.outputTokens;
      this.emit("state", this.getState());
      const r = this.tokenAbort(); if (r && this.ac && !this.ac.signal.aborted) { this.pendingAbort = r; this.ac.abort(); }
    };
    const onMessage = (t: string) => { this.state.lastMessage = t; this.emit("state", this.getState()); };
    const logPath = join(this.runInfo.runDir, `iteration-${this.state.currentIteration}.jsonl`);

    try {
      const result = await this.agent.run(prompt, this.cwd, { onUsage, onMessage, signal: this.ac.signal, logPath });
      if (this.stopRequested) return { type: "stopped" };
      const stop = result.output.should_fully_stop === true;
      this.options.targetProvider?.onShotResult({ iteration: this.state.currentIteration, success: result.output.success, summary: result.output.summary, shotOutcome: result.output.shot_outcome, shotDelta: result.output.shot_delta });
      if (result.output.success) return { type: "completed", record: this.recSuccess(result.output), shouldFullyStop: stop };
      return { type: "completed", record: this.recFail(`[FAIL] ${result.output.summary}`, result.output.summary, toStringArray(result.output.key_learnings), "reported"), shouldFullyStop: stop };
    } catch (err) {
      if (this.pendingAbort && err instanceof Error && err.message === "Agent was aborted") { resetHard(this.cwd); return { type: "aborted", reason: this.pendingAbort }; }
      if (this.stopRequested) return { type: "stopped" };
      appendDebugLog("agent:run:error", { error: serializeError(err) });
      if (err instanceof PermanentAgentError) { resetHard(this.cwd); this.state.lastAgentError = err.detail; return { type: "aborted", reason: err.message }; }
      const s = err instanceof Error ? err.message : String(err);
      return { type: "completed", record: this.recFail(`[ERROR] ${s}`, s, [], "error"), shouldFullyStop: false };
    } finally { this.ac = null; this.pendingAbort = null; }
  }

  private recSuccess(o: AgentOutput): IterationRecord {
    appendNotes(this.runInfo.notesPath, this.state.currentIteration, o.summary, toStringArray(o.key_changes_made), toStringArray(o.key_learnings));
    commitAll(buildCommitMessage(this.options.commitMessage, o, { iteration: this.state.currentIteration }), this.cwd);
    this.state.commitCount = getBranchCommitCount(this.runInfo.baseCommit, this.cwd);
    this.state.successCount++; this.state.consecutiveFailures = 0; this.state.consecutiveErrors = 0; this.state.lastAgentError = null;
    return { number: this.state.currentIteration, success: true, summary: o.summary, keyChanges: toStringArray(o.key_changes_made), keyLearnings: toStringArray(o.key_learnings), timestamp: new Date() };
  }

  private recFail(noteSum: string, recSum: string, learnings: string[], kind: "reported" | "error"): IterationRecord {
    appendNotes(this.runInfo.notesPath, this.state.currentIteration, noteSum, [], learnings);
    resetHard(this.cwd); this.state.failCount++; this.state.consecutiveFailures++;
    if (kind === "error") { this.state.consecutiveErrors++; this.state.lastAgentError = recSum; }
    else { this.state.consecutiveErrors = 0; this.state.lastAgentError = null; }
    return { number: this.state.currentIteration, success: false, summary: recSum, keyChanges: [], keyLearnings: learnings, timestamp: new Date() };
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((r) => {
      this.ac = new AbortController();
      const t = setTimeout(() => { this.ac = null; r(); }, ms);
      this.ac.signal.addEventListener("abort", () => { clearTimeout(t); this.ac = null; r(); });
    });
  }

  private tokenAbort(): string | null {
    if (this.options.maxTokens === undefined) return null;
    const total = this.state.totalInputTokens + this.state.totalOutputTokens;
    return total >= this.options.maxTokens ? `max tokens (${total}/${this.options.maxTokens})` : null;
  }

  private doAbort(reason: string): void {
    this.state.status = "aborted"; this.state.gracefulStopRequested = false; this.state.lastMessage = reason; this.state.waitingUntil = null;
    appendDebugLog("orchestrator:abort", { reason }); this.emit("abort", reason); this.emit("state", this.getState());
  }

  private async closeAgent(): Promise<void> { try { await this.agent.close?.(); } catch (e) { appendDebugLog("agent:close:error", { error: serializeError(e) }); } }
  private emitStopped(): void { if (this.stoppedEmitted) return; this.stoppedEmitted = true; this.emit("stopped"); }
}

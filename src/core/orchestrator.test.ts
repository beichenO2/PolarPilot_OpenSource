import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { Agent, AgentResult, AgentRunOptions } from "./agents/types.js";
import type { Config } from "./config.js";
import type { RunInfo } from "./run.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

function createTmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t.com", "commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function createMockAgent(results: AgentResult[]): Agent {
  let idx = 0;
  return {
    name: "mock",
    async run(_prompt: string, _cwd: string, opts?: AgentRunOptions): Promise<AgentResult> {
      const r = results[idx % results.length]!;
      idx++;
      opts?.onUsage?.(r.usage);
      return r;
    },
  };
}

function createRunInfo(cwd: string): RunInfo {
  const runDir = join(cwd, ".polarpilot", "runs", "test-run");
  mkdirSync(runDir, { recursive: true });
  const notesPath = join(runDir, "notes.md");
  writeFileSync(notesPath, "# Test\n", "utf-8");
  writeFileSync(join(runDir, "prompt.md"), "test", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t.com", "commit", "-m", "setup run"], { cwd, stdio: "pipe" });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
  return {
    runId: "test-run",
    runDir,
    promptPath: join(runDir, "prompt.md"),
    notesPath,
    schemaPath: join(runDir, "schema.json"),
    logPath: join(runDir, "test.log"),
    baseCommit,
    baseCommitPath: join(runDir, "base-commit"),
    stopWhen: undefined,
  };
}

const DEFAULT_CONFIG: Config = {
  agent: "claude",
  agentPathOverride: {},
  agentArgsOverride: {},
  maxConsecutiveFailures: 3,
  preventSleep: false,
};

describe("Orchestrator", () => {
  let cwd: string;
  let runInfo: RunInfo;

  beforeEach(() => {
    cwd = createTmpGitRepo();
    runInfo = createRunInfo(cwd);
  });

  it("runs basic iteration loop with success", async () => {
    const agent = createMockAgent([{
      output: { success: true, summary: "did work", key_changes_made: ["change1"], key_learnings: ["learned1"] },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }]);

    const orch = new Orchestrator(DEFAULT_CONFIG, agent, runInfo, "test prompt", cwd, 0, { maxIterations: 3 });
    const records: unknown[] = [];
    orch.on("iteration:end", (r) => records.push(r));
    await orch.start();

    const state = orch.getState();
    expect(state.successCount).toBe(3);
    expect(state.failCount).toBe(0);
    expect(state.currentIteration).toBe(3);
    expect(state.status).toBe("aborted");
    expect(records).toHaveLength(3);
  });

  it("handles reported failure and retry without backoff", async () => {
    let callCount = 0;
    const agent: Agent = {
      name: "mock",
      async run() {
        callCount++;
        if (callCount <= 2) {
          return {
            output: { success: false, summary: "failed", key_changes_made: [], key_learnings: ["retry needed"] },
            usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
          };
        }
        return {
          output: { success: true, summary: "recovered", key_changes_made: [], key_learnings: [] },
          usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      },
    };

    const orch = new Orchestrator(DEFAULT_CONFIG, agent, runInfo, "test", cwd, 0, { maxIterations: 4 });
    await orch.start();

    const state = orch.getState();
    expect(state.failCount).toBe(2);
    expect(state.successCount).toBeGreaterThanOrEqual(1);
  });

  it("aborts on max-tokens", async () => {
    const agent = createMockAgent([{
      output: { success: true, summary: "used tokens", key_changes_made: [], key_learnings: [] },
      usage: { inputTokens: 600, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }]);

    const orch = new Orchestrator(DEFAULT_CONFIG, agent, runInfo, "test", cwd, 0, { maxTokens: 1000 });
    await orch.start();

    const state = orch.getState();
    expect(state.status).toBe("aborted");
    expect(state.totalInputTokens + state.totalOutputTokens).toBeGreaterThanOrEqual(1000);
  });

  it("graceful interrupt stops after current iteration", async () => {
    let callCount = 0;
    const agent: Agent = {
      name: "mock",
      async run() {
        callCount++;
        return {
          output: { success: true, summary: `iter ${callCount}`, key_changes_made: [], key_learnings: [] },
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      },
    };

    const orch = new Orchestrator(DEFAULT_CONFIG, agent, runInfo, "test", cwd, 0, { maxIterations: 100 });
    orch.on("iteration:end", () => {
      if (callCount >= 2) orch.requestGracefulStop();
    });
    await orch.start();

    const state = orch.getState();
    expect(state.status).toBe("stopped");
    expect(state.currentIteration).toBeLessThanOrEqual(3);
  });

  it("tracks TargetProvider callbacks", async () => {
    const shotResults: unknown[] = [];
    const provider = {
      getCurrentTarget: () => ({ id: "t1", title: "Test Target", description: "desc" }),
      onShotResult: (r: unknown) => shotResults.push(r),
    };

    const agent = createMockAgent([{
      output: { success: true, summary: "hit", key_changes_made: [], key_learnings: [], shot_outcome: "hit" as const, shot_delta: "on target" },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }]);

    const orch = new Orchestrator(DEFAULT_CONFIG, agent, runInfo, "test", cwd, 0, { maxIterations: 1, targetProvider: provider });
    await orch.start();

    expect(shotResults).toHaveLength(1);
    expect((shotResults[0] as { shotOutcome: string }).shotOutcome).toBe("hit");
  });

  it("aborts on consecutive failures", async () => {
    const agent = createMockAgent([{
      output: { success: false, summary: "fail", key_changes_made: [], key_learnings: [] },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }]);

    const orch = new Orchestrator(DEFAULT_CONFIG, agent, runInfo, "test", cwd, 0, { maxIterations: 100 });
    await orch.start();

    const state = orch.getState();
    expect(state.status).toBe("aborted");
    expect(state.consecutiveFailures).toBe(3);
  });
});

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { buildAgentOutputSchema, type Agent, type AgentOutput, type AgentOutputSchema, type AgentResult, type AgentRunOptions, type TokenUsage } from "./types.js";
import { setupAbortHandler } from "./stream-utils.js";

export class CodexAgent implements Agent {
  name = "codex";
  private bin: string;
  private extraArgs?: string[];
  private schema: AgentOutputSchema;

  constructor(opts: { bin?: string; extraArgs?: string[]; schema?: AgentOutputSchema } = {}) {
    this.bin = opts.bin ?? "codex";
    this.extraArgs = opts.extraArgs;
    this.schema = opts.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  run(prompt: string, cwd: string, options?: AgentRunOptions): Promise<AgentResult> {
    const { onUsage, signal, logPath } = options ?? {};
    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;
      const ua = this.extraArgs ?? [];
      const hasAuto = ua.some((a) => a === "--full-auto" || a === "-a");
      const args = ["exec", ...ua, ...(hasAuto ? [] : ["--full-auto"]), "--json", "--output-schema", JSON.stringify(this.schema), "--color", "false", prompt];
      const child = spawn(this.bin, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env });
      if (setupAbortHandler(signal, child, reject, () => child.kill("SIGTERM"))) return;
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); logStream?.write(d); });
      child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err) => reject(new Error(`Failed to spawn codex: ${err.message}`)));
      child.on("close", (code) => {
        logStream?.end();
        if (code !== 0) { reject(new Error(`codex exited with code ${code}: ${stderr}`)); return; }
        try {
          const p = JSON.parse(stdout) as { output?: AgentOutput; usage?: { input_tokens?: number; output_tokens?: number } };
          const output: AgentOutput = p.output ?? { success: false, summary: "codex no output", key_changes_made: [], key_learnings: [] };
          const usage: TokenUsage = { inputTokens: p.usage?.input_tokens ?? 0, outputTokens: p.usage?.output_tokens ?? 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
          onUsage?.(usage);
          resolve({ output, usage });
        } catch { reject(new Error("Failed to parse codex output")); }
      });
    });
  }
}

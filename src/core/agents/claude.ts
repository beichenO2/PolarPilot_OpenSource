import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { buildAgentOutputSchema, PermanentAgentError, type Agent, type AgentOutput, type AgentOutputSchema, type AgentResult, type AgentRunOptions, type TokenUsage } from "./types.js";
import { shutdownChildProcess } from "./managed-process.js";
import { parseJSONLStream, setupAbortHandler } from "./stream-utils.js";

interface AssistantEv { type: "assistant"; message: { id?: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } }
interface ResultEv { type: "result"; subtype: string; is_error?: boolean; usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number }; structured_output: AgentOutput | null }
type Ev = AssistantEv | ResultEv | { type: string };

function toUsage(u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): TokenUsage {
  return { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0 };
}

export class ClaudeAgent implements Agent {
  name = "claude";
  private bin: string;
  private extraArgs?: string[];
  private schema: AgentOutputSchema;

  constructor(opts: { bin?: string; extraArgs?: string[]; schema?: AgentOutputSchema } = {}) {
    this.bin = opts.bin ?? "claude";
    this.extraArgs = opts.extraArgs;
    this.schema = opts.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  run(prompt: string, cwd: string, options?: AgentRunOptions): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};
    return new Promise((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;
      const ua = this.extraArgs ?? [];
      const hasPerm = ua.some((a) => a === "--dangerously-skip-permissions" || a.startsWith("--permission-mode"));
      const args = [...ua, "-p", prompt, "--verbose", "--output-format", "stream-json", "--json-schema", JSON.stringify(this.schema), ...(hasPerm ? [] : ["--dangerously-skip-permissions"])];
      const child = spawn(this.bin, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: process.env });
      const term = () => { if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); return; } catch { /* */ } } child.kill("SIGTERM"); };
      if (setupAbortHandler(signal, child, reject, term)) return;

      let resEv: ResultEv | null = null;
      let finalRes: ResultEv | null = null;
      let latestUsage: ResultEv["usage"] | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closedCleanup = false;
      let stderr = "";
      const cum: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      const byId = new Map<string, TokenUsage>();
      let anon = 0;

      child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err) => reject(new Error(`Failed to spawn claude: ${err.message}`)));

      parseJSONLStream<Ev>(child.stdout!, logStream, (event) => {
        if (event.type === "assistant") {
          const msg = (event as AssistantEv).message;
          const nu = toUsage(msg.usage);
          const mid = msg.id ?? `a-${anon++}`;
          const prev = byId.get(mid);
          if (prev) { cum.inputTokens += nu.inputTokens - prev.inputTokens; cum.outputTokens += nu.outputTokens - prev.outputTokens; cum.cacheReadTokens += nu.cacheReadTokens - prev.cacheReadTokens; cum.cacheCreationTokens += nu.cacheCreationTokens - prev.cacheCreationTokens; }
          else { cum.inputTokens += nu.inputTokens; cum.outputTokens += nu.outputTokens; cum.cacheReadTokens += nu.cacheReadTokens; cum.cacheCreationTokens += nu.cacheCreationTokens; }
          byId.set(mid, nu);
          onUsage?.({ ...cum });
          if (onMessage) { const c = (msg as Record<string, unknown>).content; if (Array.isArray(c)) for (const b of c) if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) onMessage(b.text.trim()); }
        }
        if (event.type === "result") {
          const r = event as ResultEv;
          latestUsage = r.usage;
          if (!r.is_error && r.subtype === "success" && r.structured_output) {
            finalRes = r;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { closedCleanup = true; void shutdownChildProcess(child, { detached: true }); }, 15_000);
          } else if (!finalRes) resEv = r;
        }
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        logStream?.end();
        if (code !== 0 && !closedCleanup) {
          const detail = `claude exited with code ${code}: ${stderr}`;
          reject(/credit balance\s+is\s+too\s+low/i.test(stderr) ? new PermanentAgentError("claude credit balance too low", detail) : new Error(detail));
          return;
        }
        const t = finalRes ?? resEv;
        if (!t) { reject(new Error("claude returned no result")); return; }
        if (t.is_error || t.subtype !== "success") { reject(new Error(`claude error: ${JSON.stringify(t)}`)); return; }
        if (!t.structured_output) { reject(new Error("claude no structured_output")); return; }
        const u = toUsage(latestUsage ?? t.usage);
        onUsage?.(u);
        resolve({ output: t.structured_output, usage: u });
      });
    });
  }
}

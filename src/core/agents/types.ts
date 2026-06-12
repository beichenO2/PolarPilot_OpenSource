export interface AgentOutput {
  success: boolean;
  summary: string;
  key_changes_made: unknown;
  key_learnings: unknown;
  should_fully_stop?: boolean;
  shot_outcome?: "hit" | "miss";
  shot_delta?: string;
}

export interface AgentOutputSchema {
  type: "object";
  additionalProperties: false;
  properties: Record<string, { type: string; items?: { type: string }; enum?: string[] }>;
  required: string[];
}

export interface AgentOutputCommitField {
  name: string;
  allowed?: string[];
}

export function buildAgentOutputSchema(opts: {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
}): AgentOutputSchema {
  const p: AgentOutputSchema["properties"] = {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  };
  const r = ["success", "summary", "key_changes_made", "key_learnings"];
  for (const f of opts.commitFields ?? []) {
    p[f.name] = { type: "string", ...(f.allowed ? { enum: f.allowed } : {}) };
    r.push(f.name);
  }
  if (opts.includeStopField) {
    p.should_fully_stop = { type: "boolean" };
    r.push("should_fully_stop");
  }
  p.shot_outcome = { type: "string", enum: ["hit", "miss"] };
  p.shot_delta = { type: "string" };
  return { type: "object", additionalProperties: false, properties: p, required: r };
}

export function validateAgentOutput(v: unknown): AgentOutput {
  if (typeof v !== "object" || v === null) throw new Error("expected object");
  return v as AgentOutput;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AgentResult {
  output: AgentOutput;
  usage: TokenUsage;
}

export class PermanentAgentError extends Error {
  detail: string;
  constructor(m: string, d: string) {
    super(m, { cause: d });
    this.name = "PermanentAgentError";
    this.detail = d;
  }
}

export type OnUsage = (usage: TokenUsage) => void;
export type OnMessage = (text: string) => void;

export interface AgentRunOptions {
  onUsage?: OnUsage;
  onMessage?: OnMessage;
  signal?: AbortSignal;
  logPath?: string;
}

export interface Agent {
  name: string;
  close?(): Promise<void> | void;
  run(prompt: string, cwd: string, options?: AgentRunOptions): Promise<AgentResult>;
}

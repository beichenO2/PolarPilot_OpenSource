import type { AgentOutput, AgentOutputCommitField } from './agents/types';

export type CommitMessagePreset = "conventional";
export interface CommitMessageConfig { preset: CommitMessagePreset }
export interface CommitMessageContext { iteration: number }
export interface CommitMessagePromptField { name: string; description: string; allowed?: string[]; default: string }

export const CONVENTIONAL_COMMIT_MESSAGE: CommitMessageConfig = { preset: "conventional" };

const TYPES = ["build", "ci", "docs", "feat", "fix", "perf", "refactor", "test", "chore"];
const FIELDS: CommitMessagePromptField[] = [
  { name: "type", description: "Commit type", allowed: TYPES, default: "chore" },
  { name: "scope", description: "Commit scope", default: "" },
];

export function getCommitMessageSchemaFields(c: CommitMessageConfig | undefined): AgentOutputCommitField[] {
  if (!c) return [];
  return FIELDS.map((f) => ({ name: f.name, ...(f.allowed ? { allowed: f.allowed } : {}) }));
}

export function getCommitMessagePromptFields(c: CommitMessageConfig | undefined): CommitMessagePromptField[] {
  if (!c) return [];
  return FIELDS;
}

type W = AgentOutput & { type?: unknown; scope?: unknown };

export function buildCommitMessage(c: CommitMessageConfig | undefined, o: AgentOutput, ctx: CommitMessageContext): string {
  const col = (s: string) => s.replace(/\s+/g, " ").trim();
  if (!c) return col(`polarpilot #${ctx.iteration}: ${o.summary}`);
  const w = o as W;
  const t = typeof w.type === "string" && TYPES.includes(w.type) ? w.type : "chore";
  const rs = typeof w.scope === "string" ? w.scope.trim() : "";
  const sc = rs ? `(${rs})` : "";
  return col(`${t}${sc}: ${o.summary}`);
}

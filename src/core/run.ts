import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { buildAgentOutputSchema } from './agents/types';
import { getHeadCommit } from './git';

export interface RunInfo {
  runId: string;
  runDir: string;
  promptPath: string;
  notesPath: string;
  schemaPath: string;
  logPath: string;
  baseCommit: string;
  baseCommitPath: string;
  stopWhen: string | undefined;
}

function ensureIgnored(cwd: string): void {
  try {
    const ep = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf-8" }).trim();
    const rp = isAbsolute(ep) ? ep : join(cwd, ep);
    const entry = ".polarpilot/runs/";
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    if (existsSync(rp)) {
      const c = readFileSync(rp, "utf-8");
      if (c.split("\n").some((l) => l.trim() === entry)) return;
      appendFileSync(rp, `${c.endsWith("\n") ? "" : "\n"}${entry}\n`, "utf-8");
    } else {
      writeFileSync(rp, `${entry}\n`, "utf-8");
    }
  } catch { /* best-effort */ }
}

export function setupRun(runId: string, prompt: string, baseCommit: string, cwd: string, opts?: { stopWhen?: string }): RunInfo {
  ensureIgnored(cwd);
  const rd = join(cwd, ".polarpilot", "runs", runId);
  mkdirSync(rd, { recursive: true });
  const pp = join(rd, "prompt.md");
  writeFileSync(pp, prompt, "utf-8");
  const np = join(rd, "notes.md");
  if (!existsSync(np)) writeFileSync(np, `# PolarPilot run: ${runId}\n\nObjective: see prompt.md\n\n## Iteration Log\n`, "utf-8");
  const sp = join(rd, "output-schema.json");
  writeFileSync(sp, JSON.stringify(buildAgentOutputSchema({ includeStopField: opts?.stopWhen !== undefined }), null, 2), "utf-8");
  const lp = join(rd, "polarpilot.log");
  const bp = join(rd, "base-commit");
  const rbc = existsSync(bp) ? readFileSync(bp, "utf-8").trim() : baseCommit;
  if (!existsSync(bp)) writeFileSync(bp, `${baseCommit}\n`, "utf-8");
  return { runId, runDir: rd, promptPath: pp, notesPath: np, schemaPath: sp, logPath: lp, baseCommit: rbc, baseCommitPath: bp, stopWhen: opts?.stopWhen };
}

export function resumeRun(runId: string, cwd: string): RunInfo {
  const rd = join(cwd, ".polarpilot", "runs", runId);
  if (!existsSync(rd)) throw new Error(`Not found: ${rd}`);
  const bp = join(rd, "base-commit");
  const bc = existsSync(bp) ? readFileSync(bp, "utf-8").trim() : getHeadCommit(cwd);
  return { runId, runDir: rd, promptPath: join(rd, "prompt.md"), notesPath: join(rd, "notes.md"), schemaPath: join(rd, "output-schema.json"), logPath: join(rd, "polarpilot.log"), baseCommit: bc, baseCommitPath: bp, stopWhen: undefined };
}

export function getLastIterationNumber(ri: RunInfo): number {
  let m = 0;
  for (const f of readdirSync(ri.runDir)) {
    const x = f.match(/^iteration-(\d+)\.jsonl$/);
    if (x) { const n = parseInt(x[1]!, 10); if (n > m) m = n; }
  }
  return m;
}

export function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") { try { const p = JSON.parse(v); if (Array.isArray(p)) return p.filter((x): x is string => typeof x === "string"); } catch { /* not JSON */ } return [v]; }
  return [];
}

export function appendNotes(np: string, iter: number, summary: string, changes: string[], learnings: string[]): void {
  const fmt = (t: string, is: string[]) => is.length === 0 ? "" : `**${t}:**\n${is.map((i) => `- ${i}`).join("\n")}\n`;
  appendFileSync(np, [`\n### Iteration ${iter}\n`, `**Summary:** ${summary}\n`, fmt("Changes", changes), fmt("Learnings", learnings)].join("\n"), "utf-8");
}

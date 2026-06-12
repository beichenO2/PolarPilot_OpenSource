import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";

export const AGENT_NAMES = ["claude", "codex"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export interface Config {
  agent: AgentName;
  agentPathOverride: Partial<Record<AgentName, string>>;
  agentArgsOverride: Partial<Record<AgentName, string[]>>;
  maxConsecutiveFailures: number;
  preventSleep: boolean;
}

const DEFAULTS: Config = { agent: "claude", agentPathOverride: {}, agentArgsOverride: {}, maxConsecutiveFailures: 3, preventSleep: true };

export function loadConfig(overrides?: Partial<Config>): Config {
  const dir = join(homedir(), ".polarpilot");
  const path = join(dir, "config.yml");
  let file: Partial<Config> = {};
  let bootstrap = false;

  try {
    const raw = readFileSync(path, "utf-8");
    file = (yaml.load(raw) as Partial<Config>) ?? {};
    if (file.agentPathOverride && typeof file.agentPathOverride === "object") {
      const r: Partial<Record<AgentName, string>> = {};
      for (const [k, v] of Object.entries(file.agentPathOverride)) {
        if (typeof v === "string") {
          let e = v;
          if (e.startsWith("~/")) e = join(homedir(), e.slice(2));
          r[k as AgentName] = resolve(dir, e);
        }
      }
      file.agentPathOverride = r;
    }
  } catch (e) {
    if (e instanceof Error && ("code" in e ? (e as { code?: string }).code === "ENOENT" : e.message.includes("ENOENT")))
      bootstrap = true;
  }

  const cfg: Config = { ...DEFAULTS, ...file, ...(overrides ?? {}) };

  if (bootstrap) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `agent: ${cfg.agent}\nmaxConsecutiveFailures: ${cfg.maxConsecutiveFailures}\npreventSleep: ${cfg.preventSleep}\n`, "utf-8");
    } catch { /* best-effort */ }
  }

  return cfg;
}

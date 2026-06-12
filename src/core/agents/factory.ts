import type { AgentName } from "../config.js";
import type { Agent, AgentOutputSchema } from "./types.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";

export function createAgent(agentType: AgentName, binOverride?: string, extraArgs?: string[], schema?: AgentOutputSchema): Agent {
  switch (agentType) {
    case "claude": return new ClaudeAgent({ bin: binOverride, extraArgs, schema });
    case "codex": return new CodexAgent({ bin: binOverride, extraArgs, schema });
    default: throw new Error(`Unknown agent: ${agentType}`);
  }
}

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { Command, InvalidArgumentError } from "commander";
import { createDaemon } from "./pilot/daemon.js";
import { runAssistantTask } from "./pilot/runtime.js";
import { createWorkflowCompiler } from "./workflow/compiler.js";
import { executeWorkflow } from "./workflow/index.js";
import type { LobsterEvent } from "./pilot/types.js";
import type { AssistantTask } from "./workflow/types.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a safe positive integer");
  }
  return parsed;
}

const AGENT_NAMES = ["claude", "codex"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

function isAgentName(name: string): name is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(name);
}

const PILOT_MODES = ["guard", "research", "assistant"] as const;
type PilotMode = (typeof PILOT_MODES)[number];

function isPilotMode(name: string): name is PilotMode {
  return (PILOT_MODES as readonly string[]).includes(name);
}

function parseAssistantTaskInput(input: string): AssistantTask {
  let raw: string;
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    raw = trimmed;
  } else {
    const resolved = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
    if (!existsSync(resolved)) {
      throw new InvalidArgumentError(`assistant-task path not found: ${resolved}`);
    }
    raw = readFileSync(resolved, "utf-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidArgumentError(
      `--assistant-task could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidArgumentError("--assistant-task must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const sc = obj.stopCondition;
  if (
    typeof obj.fundamentalGoal !== "string" ||
    typeof obj.executionApproach !== "string" ||
    typeof sc !== "object" || sc === null
  ) {
    throw new InvalidArgumentError(
      "--assistant-task must contain {fundamentalGoal, executionApproach, stopCondition:{successCriteria, failureCriteria}}",
    );
  }
  const scObj = sc as Record<string, unknown>;
  if (typeof scObj.successCriteria !== "string" || typeof scObj.failureCriteria !== "string") {
    throw new InvalidArgumentError("--assistant-task stopCondition must have string successCriteria and failureCriteria");
  }
  return {
    fundamentalGoal: obj.fundamentalGoal,
    executionApproach: obj.executionApproach,
    stopCondition: {
      successCriteria: scObj.successCriteria,
      failureCriteria: scObj.failureCriteria,
    },
  };
}

type PilotStatusResponse = {
  project_id: string;
  state: "dormant" | "active" | "error" | "unknown";
  current_node?: string;
  last_active_at?: string;
  active_targets: number;
  completed_targets: number;
  pending_events: number;
};

function parseEvents(eventsPath: string): LobsterEvent[] {
  if (!existsSync(eventsPath)) return [];
  const raw = readFileSync(eventsPath, "utf-8");
  const out: LobsterEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LobsterEvent);
    } catch {
      // ignore malformed event lines
    }
  }
  return out;
}

function readTargets(projectRoot: string): Array<Record<string, unknown>> {
  const targetsDir = join(projectRoot, "lobster", "targets");
  if (!existsSync(targetsDir)) return [];
  const indexPath = join(targetsDir, "index.json");
  if (!existsSync(indexPath)) return [];
  const files = readFileSync(indexPath, "utf-8");
  try {
    const ids = JSON.parse(files) as string[];
    return ids.flatMap((id) => {
      const filePath = join(targetsDir, `${id}.json`);
      if (!existsSync(filePath)) return [];
      try {
        return [JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function buildStatus(project: string, polarisorRoot: string, eventsPath: string): PilotStatusResponse {
  const projectRoot = join(polarisorRoot, project);
  const targets = readTargets(projectRoot);
  const activeTargets = targets.filter((t) => {
    const status = String(t.status ?? "");
    return status === "active" || status === "moved";
  }).length;
  const completedTargets = targets.filter((t) => String(t.status ?? "") === "hit").length;
  const events = parseEvents(eventsPath);
  const projectEvents = events.filter((e) => e.target_project === project || e.source_project === project);
  const state: PilotStatusResponse["state"] = activeTargets > 0 ? "active" : "dormant";
  const lastActiveAt = projectEvents.length > 0 ? projectEvents[projectEvents.length - 1]?.ts : undefined;
  return {
    project_id: project,
    state,
    current_node: activeTargets > 0 ? "find_target" : undefined,
    last_active_at: lastActiveAt,
    active_targets: activeTargets,
    completed_targets: completedTargets,
    pending_events: projectEvents.length,
  };
}

function sendJson(res: import("node:http").ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

const program = new Command();

program
  .name("polarpilot")
  .description("PolarPilot — autonomous project evolution CLI")
  .version(packageVersion)
  .argument("[prompt]", "The objective for the pilot agent")
  .option("--project <name>", "Target project name")
  .option("--agent <agent>", "Agent to use (claude, codex)")
  .option("--max-iterations <n>", "Abort after N total iterations", parsePositiveInteger)
  .option("--max-tokens <n>", "Abort after N total input+output tokens", parsePositiveInteger)
  .option("--worktree", "Run in a separate git worktree", false)
  .option("--daemon", "Run as daemon watching lobster events", false)
  .option("--mode <mode>", "guard | research | assistant (required for non-daemon)")
  .option("--workflow <path>", "Path to workflow.md (required for --mode research)")
  .option("--assistant-task <pathOrJson>", "Path to assistant-task.json or inline JSON (required for --mode assistant)")
  .action(async (promptArg: string | undefined, options: { project?: string; agent?: string; maxIterations?: number; maxTokens?: number; worktree: boolean; daemon: boolean; mode?: string; workflow?: string; assistantTask?: string; }) => {
    if (options.agent !== undefined && !isAgentName(options.agent)) {
      console.error("Unknown agent: " + options.agent + ". Use claude, codex.");
      process.exit(1);
    }
    if (options.mode !== undefined && !isPilotMode(options.mode)) {
      console.error(`Unknown mode: ${options.mode}. Use guard | research | assistant.`);
      process.exit(1);
    }
    if (options.daemon) {
      if (!options.project) {
        console.error("--daemon requires --project <name>");
        process.exit(1);
      }

      const polarisorRoot = join(homedir(), "Polarisor");
      const eventsPath = join(polarisorRoot, "SOTAgent", "data", "lobster-events.jsonl");
      const startAt = Date.now();
      let lastScanAt: string | undefined;

      const daemon = createDaemon({
        eventsPath,
        polarisorRoot,
        dedupWindowMs: 10 * 60 * 1000,
        healthScanHour: 3,
        managedProjects: [options.project],
      });
      daemon.start();
      lastScanAt = new Date().toISOString();

      const server = createServer((req, res) => {
        const host = req.headers.host ?? "127.0.0.1";
        const url = new URL(req.url ?? "/", `http://${host}`);
        const path = url.pathname;
        const projectIdMatch = path.match(/^\/api\/pilot\/status\/([^/]+)$/);
        const targetsMatch = path.match(/^\/api\/pilot\/targets\/([^/]+)$/);
        const targetByIdMatch = path.match(/^\/api\/pilot\/targets\/([^/]+)\/([^/]+)$/);

        if (req.method === "GET" && path === "/api/pilot/health") {
          sendJson(res, 200, {
            healthy: true,
            uptime_ms: Date.now() - startAt,
            projects_monitored: 1,
            last_scan_at: lastScanAt,
          });
          return;
        }
        if (req.method === "GET" && path === "/api/pilot/status") {
          sendJson(res, 200, [buildStatus(options.project!, polarisorRoot, eventsPath)]);
          return;
        }
        if (req.method === "GET" && projectIdMatch) {
          sendJson(res, 200, buildStatus(decodeURIComponent(projectIdMatch[1]!), polarisorRoot, eventsPath));
          return;
        }
        if (req.method === "GET" && targetsMatch) {
          const project = decodeURIComponent(targetsMatch[1]!);
          const projectRoot = join(polarisorRoot, project);
          sendJson(res, 200, readTargets(projectRoot));
          return;
        }
        if (req.method === "GET" && targetByIdMatch) {
          const project = decodeURIComponent(targetByIdMatch[1]!);
          const targetId = decodeURIComponent(targetByIdMatch[2]!);
          const projectRoot = join(polarisorRoot, project);
          const target = readTargets(projectRoot).find((t) => String(t.id ?? "") === targetId);
          if (!target) {
            sendJson(res, 404, { error: "not_found", target_id: targetId });
            return;
          }
          sendJson(res, 200, target);
          return;
        }
        if (req.method === "GET" && path === "/api/pilot/events") {
          const project = url.searchParams.get("project") ?? undefined;
          const since = url.searchParams.get("since") ?? undefined;
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
          const events = parseEvents(eventsPath)
            .filter((e) => !project || e.target_project === project || e.source_project === project)
            .filter((e) => !since || e.ts >= since)
            .slice(-Math.max(1, Number.isFinite(limit) ? limit : 50));
          sendJson(res, 200, events);
          return;
        }
        if (req.method === "POST" && path === "/api/pilot/events") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Partial<LobsterEvent>;
              const event: LobsterEvent = {
                ts: payload.ts ?? new Date().toISOString(),
                type: (payload.type as LobsterEvent["type"]) ?? "custom",
                source_project: payload.source_project ?? "PolarClaw",
                target_project: payload.target_project ?? options.project!,
                severity: (payload.severity as LobsterEvent["severity"]) ?? "info",
                payload: payload.payload ?? {},
                dedup_key: payload.dedup_key ?? `manual:${Date.now()}`,
              };
              appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
              sendJson(res, 200, { accepted: true, event_id: `${Date.now()}`, dedup_skipped: false });
            } catch (err) {
              sendJson(res, 400, { error: "invalid_json", message: err instanceof Error ? err.message : String(err) });
            }
          });
          return;
        }

        sendJson(res, 404, { error: "not_found", path });
      });

      const port = Number.parseInt(process.env.POLARPILOT_PORT ?? "4900", 10);
      server.listen(port, "127.0.0.1", () => {
        console.log(`PolarPilot daemon listening at http://127.0.0.1:${port}`);
      });

      const shutdown = () => {
        daemon.stop();
        server.close(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      await new Promise(() => {});
      return;
    }

    // ── Non-daemon mode dispatch ──────────────────────────────
    if (!options.mode) {
      console.error("--mode is required when not running in --daemon mode (guard | research | assistant).");
      process.exit(1);
    }
    if (!options.project) {
      console.error("--project <name> is required.");
      process.exit(1);
    }

    const polarisorRoot = join(homedir(), "Polarisor");
    const eventsPath = join(polarisorRoot, "SOTAgent", "data", "lobster-events.jsonl");

    if (options.mode === "guard") {
      console.error("--mode guard is only meaningful in --daemon mode. Use `polarpilot --daemon --project <name>`.");
      process.exit(1);
    }

    if (options.mode === "assistant") {
      if (!options.assistantTask) {
        console.error("--mode assistant requires --assistant-task <pathOrJson>.");
        process.exit(1);
      }
      let task: AssistantTask;
      try {
        task = parseAssistantTaskInput(options.assistantTask);
      } catch (err) {
        console.error(`polarpilot: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
      }
      const done = await runAssistantTask({
        project: options.project,
        task,
        eventsPath,
        ...(options.agent ? { agent: options.agent as AgentName } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.worktree ? { worktree: true } : {}),
      });
      console.log(JSON.stringify(done, null, 2));
      process.exit(done.status === "success" ? 0 : 1);
      return;
    }

    if (options.mode === "research") {
      if (!options.workflow) {
        console.error("--mode research requires --workflow <path>.");
        process.exit(1);
      }
      const wfPath = isAbsolute(options.workflow) ? options.workflow : resolve(process.cwd(), options.workflow);
      if (!existsSync(wfPath)) {
        console.error(`polarpilot: workflow path not found: ${wfPath}`);
        process.exit(1);
      }
      const compiler = createWorkflowCompiler();
      const compiled = compiler.compile(wfPath);
      const result = await executeWorkflow(compiled, {
        project: options.project,
        eventsPath,
        ...(promptArg ? { goal: promptArg } : {}),
        ...(options.agent ? { agent: options.agent as AgentName } : {}),
        ...(options.maxIterations !== undefined ? { maxIterationsPerStep: options.maxIterations } : {}),
        ...(options.maxTokens !== undefined ? { maxTokensTotal: options.maxTokens } : {}),
        ...(options.worktree ? { worktree: true } : {}),
        onStepStart: (step) => console.error(`[step:start] ${step.id} (${step.name})`),
        onStepEnd: (step, output) => console.error(`[step:end] ${step.id} → ${output.result}`),
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === "success" ? 0 : 1);
      return;
    }
  });

try { program.parse(); } catch (err) {
  console.error("polarpilot: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}

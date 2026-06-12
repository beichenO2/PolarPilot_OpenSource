# PolarPilot

Autonomous project evolution CLI — target-driven iterative coding with YOLO kernel.

PolarPilot is the standalone successor to PolarClaw's embedded Pilot daemon, providing fault-isolated, independently-versioned project evolution capabilities.

## Installation

```bash
npm install
npm run build
```

## CLI Usage

PolarPilot supports three execution modes (`guard` / `research` / `assistant`).
For non-daemon runs the `--mode` flag is required.

```bash
# Show version
npx polarpilot --version

# 1) Guard mode (event-driven daemon, exposes HTTP API on 127.0.0.1:4900)
npx polarpilot --daemon --project MyProject

# 2) Research mode (compile + execute a workflow.md serially)
npx polarpilot "research goal" --mode research --project MyProject \
  --workflow examples/research-workflow.md

# 3) Assistant mode (one-shot orchestrator iteration with stop condition)
npx polarpilot --mode assistant --project MyProject \
  --assistant-task contracts/examples/assistant-task.example.json

# Inline JSON form
npx polarpilot --mode assistant --project MyProject \
  --assistant-task '{"fundamentalGoal":"echo hello","executionApproach":"shell","stopCondition":{"successCriteria":"output contains hello","failureCriteria":"shell error"}}'

# Use git worktree for isolation (research/assistant)
npx polarpilot --mode research --project MyProject \
  --workflow examples/research-workflow.md --worktree
```

### Options

| Flag | Description |
|------|-------------|
| `[prompt]` | Optional objective; in research mode this is injected as the workflow's overall goal |
| `--project <name>` | Target project name (required) |
| `--mode <mode>` | `guard` (daemon only) / `research` / `assistant` (required for non-daemon) |
| `--workflow <path>` | Path to workflow.md (required for `--mode research`); see [`examples/research-workflow.md`](examples/research-workflow.md) |
| `--assistant-task <pathOrJson>` | Path to a JSON file **or** inline JSON conforming to [`contracts/assistant-task.schema.json`](contracts/assistant-task.schema.json); see [`contracts/examples/assistant-task.example.json`](contracts/examples/assistant-task.example.json) |
| `--agent <type>` | Agent type: `claude` or `codex` |
| `--max-iterations <n>` | Maximum iterations (per assistant task; per step in research mode) |
| `--max-tokens <n>` | Maximum total input+output tokens |
| `--worktree` | Run in a separate git worktree |
| `--daemon` | Run as event-driven daemon (guard mode) |
| `--version` | Output version number |

Exit codes: `0` on success, `1` on any failure (invalid args, workflow step failure, assistant task aborted).

## Architecture

PolarPilot uses a target-tree based cycle:

1. **FindTarget** — analyze project status, derive root targets
2. **DrawBoard** — decompose targets into test-driven subtargets
3. **Shoot** — execute against leaf targets, record outcomes
4. **MoveBoard** — adjust targets based on shot deltas

### Module Structure

- `src/cli.ts` — CLI entry point (commander-based)
- `src/pilot/` — Migrated pilot modules (target tree, state machine, runtime, daemon)
- `src/core/` — Core orchestrator (placeholder, implemented by PolarPilot_1_1)
- `src/templates/` — Iteration prompts (placeholder, implemented by PolarPilot_1_1)
- `src/workflow/` — Workflow engine (compiler, memory, router-agent, types)

## Workflow Engine

PolarPilot includes a Workflow engine that compiles ASCII diagram workflows and executes them automatically.

### Quick Start

1. Write a workflow.md (see [`examples/research-workflow.md`](examples/research-workflow.md))
2. Run PolarPilot: `npx polarpilot "<goal>" --mode research --project <name> --workflow path/to/workflow.md`
3. The CLI compiles the workflow, executes steps serially via the orchestrator, and prints the final `WorkflowExecutionResult` JSON to stdout.

In daemon mode the same engine handles `assistant_task` events received over `POST /api/pilot/events`; status is observable via `GET /api/pilot/status`.

### PilotMode

| Mode | Description | Trigger |
|------|-------------|---------|
| guard | Event-driven daemon (FindTarget → DrawBoard → Shoot → MoveBoard) | `--daemon --project <name>` |
| research | Serial workflow execution from compiled workflow.md | `--mode research --workflow <path> --project <name>` |
| assistant | One-shot orchestrator iteration with stop condition | CLI: `--mode assistant --assistant-task <pathOrJson>`; Daemon: receives `assistant_task` LobsterEvent and writes `assistant_task_done` back to `lobster-events.jsonl` |

## Contracts

PolarPilot exposes JSON Schemas for cross-project consumers in [`contracts/`](contracts/):

- [`contracts/assistant-task.schema.json`](contracts/assistant-task.schema.json) — PolarClaw → PolarPilot assistant task payload
- [`contracts/assistant-task-done.schema.json`](contracts/assistant-task-done.schema.json) — PolarPilot → PolarClaw completion payload
- [`contracts/examples/`](contracts/examples/) — minimal example payloads
- [`tests/contracts/assistant-task.contract.test.ts`](tests/contracts/assistant-task.contract.test.ts) — ajv-based contract tests wired into `npm test`

See [`contracts/README.md`](contracts/README.md) for the change log and L1 check coverage.

### Clean Memory

PolarPilot uses a four-layer memory architecture:
- Layer 0: Soul (PolarSoul.md, read-only)
- Layer 1: Long-term memory (PolarMemory semantic retrieval)
- Layer 2: Context (checkpoint.json, refreshed each step)
- Layer 3: Scratch (step_input/output.json, discarded after use)

## Development

```bash
npm run dev        # Watch mode
npm run build      # Production build
npm run typecheck  # TypeScript checking
npm test           # Run tests
```

## Relationship to PolarClaw

PolarPilot was extracted from PolarClaw to achieve:
- **Fault isolation** — Pilot crashes no longer affect the bot/web server
- **Independent lifecycle** — Separate versioning, deployment, restart
- **Clean architecture** — Single-responsibility CLI process

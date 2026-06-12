# PolarPilot Contracts

> 沙箱外契约入口。任何跨项目调用方（PolarClaw、PolarMemory 等）都应基于本目录的 schema + example 接入 PolarPilot。

## 目录结构

```
contracts/
├── README.md                              # 本文件（契约总览与变更历史）
├── assistant-task.schema.json             # JSON Schema (draft-07)：PolarClaw → PolarPilot 下发 assistant 任务的 payload 契约
├── assistant-task-done.schema.json        # JSON Schema (draft-07)：PolarPilot → PolarClaw 通过 lobster-events.jsonl 写回的 done 事件 payload 契约
└── examples/
    ├── assistant-task.example.json        # 最小合法的 assistant 任务示例
    └── assistant-task-done.example.json   # 最小合法的 done 事件示例
```

## 契约说明

### `assistant-task.schema.json`

- **调用方向**：PolarClaw → PolarPilot
- **传输通道**：HTTP `POST /api/pilot/events`，其中 `event.type = "assistant_task"`，`event.payload` 必须满足本 schema。
- **对应 TypeScript 类型**：`src/workflow/types.ts:AssistantTask`。
- **核心字段**：
  - `fundamentalGoal`（string，必填）：任务的根本目标，用作 Orchestrator 的迭代 prompt。
  - `executionApproach`（string，必填）：执行策略提示。
  - `stopCondition.successCriteria` / `stopCondition.failureCriteria`（string，必填）：用于 Orchestrator `stopWhen`。

### `assistant-task-done.schema.json`

- **调用方向**：PolarPilot → PolarClaw（异步消费）
- **传输通道**：append-write to `SOTAgent/data/lobster-events.jsonl`，其中 `event.type = "assistant_task_done"`，`event.payload` 满足本 schema。
- **对应 TypeScript 类型**：`src/pilot/types.ts:AssistantTaskDone`。
- **核心字段**：`task_id` / `status`（`success|failure|timeout|aborted`）/ `summary` / `artifacts[]` / `iterations` / `tokens_used` / `started_at` / `finished_at` / 可选 `error`。

## 契约测试

`tests/contracts/assistant-task.contract.test.ts`（vitest + ajv）执行 5 项 L1 检查：

1. Schema 一致性（ajv compile 不报错）。
2. Example payload 通过 schema 校验。
3. Done event example 通过 schema 校验。
4. Runtime 实际产出的 done event payload（mock）通过 schema 校验。
5. Breaking change 检测：`LobsterEvent.type` 联合新增 `'assistant_task'` / `'assistant_task_done'` 时，既有 type（`bug` / `digist_report` / ...）仍可正常构造与序列化。

## 变更历史

- **2026-05-12**：首次建立。
  - 新增 `assistant-task.schema.json` / `assistant-task-done.schema.json` / 两份 example。
  - 配套 `tests/contracts/assistant-task.contract.test.ts` 落地。
  - 同步新增 `ajv` 到 devDependencies。
  - 来源任务包：`任务书/260512_compiled/PolarPilot.md` Step 2。

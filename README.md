# PolarPilot

**PolarPilot 是面向软件项目的自主规划-执行引擎**——将模糊需求拆解为可测试的 Target 树，在 Plan → Execute → Verify 循环中自动推进编码、审查与交付，解决「Agent 只会聊天、不会闭环落地」的核心问题。

[![GitHub](https://img.shields.io/badge/GitHub-beichenO2%2FPolarPilot-blue)](https://github.com/beichenO2/PolarPilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-170%20passed-brightgreen)](#快速开始)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](#安装)

---

## 安装

### Polarisor 生态内安装

PolarPilot 是 [Polarisor](https://github.com/beichenO2/Polarisor) 生态的服务层组件，被 [PolarClaw](https://github.com/beichenO2/PolarClaw) 作为 Skill 调用，通过 `lobster-events.jsonl` 事件总线协作。

```bash
# 克隆 Polarisor 主仓（含子模块）
git clone --recurse-submodules https://github.com/beichenO2/Polarisor.git
cd Polarisor/PolarPilot

npm ci && npm run build
```

### 独立安装

无需完整 Polarisor 即可运行 CLI 与 Workflow 引擎；Guard 模式的 daemon 自愈与事件订阅需配合 PolarClaw / SOTAgent 使用。

```bash
git clone https://github.com/beichenO2/PolarPilot.git
cd PolarPilot

npm ci && npm run build
npx polarpilot --version   # → 0.1.0
```

**环境要求**：Node.js ≥ 20 · TypeScript 5.8 · 默认监听 `127.0.0.1:4900`（`POLARPILOT_PORT` 可覆盖）

---

## 设计思考

### 为什么用 Target 树，而不是扁平任务列表？

层级化 Target 可分解、可测试、可追踪——每个叶节点绑定 `leaf_test`，失败时沿树向上 escalate，而非在无限 todo 列表里迷失方向。

### 为什么 Review 用独立 Agent 上下文，而不是执行者自审？

`reviewShot` 通过 AgentFactory 创建全新上下文审查代码，prompt 明确要求「第一次看这段代码」，避免执行 Agent 的自证循环盲区。

### 为什么先跑客观测试，再进入主观 Review？

`test-executor` 在 Review 前执行 `leaf_test`：测试不通过直接 MoveBoard 重试，测试通过才进入 Review——用客观指标替代纯 LLM 主观判断。

### 为什么 Daemon 修复代码，而不是像 Watchdog 只重启进程？

PolarPilot Daemon 监听恶性 bug 信号（编译失败、测试大面积 failing 等），触发机械化自愈 → LLM Agentic Healer 升级路径；SOTAgent Watchdog 只管进程存活，PolarPilot 管应用层代码健康。

---

## 核心亮点

| 维度 | 数据 |
|------|------|
| 执行循环 | **4 步状态机**：FindTarget → DrawBoard → Shoot → MoveBoard |
| 执行模式 | **3 种**：`guard`（守护）· `research`（工作流）· `assistant`（一次性编排） |
| 思维模板 | **12 个** JSON 模式（test-first、refactor-safety、architecture-analysis 等）自动路由 |
| Agent 适配 | **2 种**后端：Claude · Codex |
| HTTP 契约 API | **7 个**端点（health / status / targets / events） |
| 测试覆盖 | **170** 用例 · **18** 测试文件 · 全绿 |
| 源码规模 | **61** 个 TypeScript 文件 · **~8,600** 行 |
| 需求完成度 | **R1–R7** 全部 100%（7 大模块） |
| 自愈机制 | 整点扫描 · **10 min** 事件去重 · **60 min** 解锁保护 · **2 h** 加锁窗口 |
| 记忆架构 | **4 层**（Soul / 长期 / Context / Scratch）+ Clean Memory 条款 |

---

## 页面预览

Guard 模式 daemon 启动后，可通过 HTTP API 查看运行状态：

![PolarPilot 运行状态](screenshots/polarpilot-status.png)

```bash
curl -s http://127.0.0.1:4900/api/pilot/health
# {"healthy":true,"uptime_ms":...,"projects_monitored":1,"last_scan_at":"..."}
```

---

## 架构

```
PolarPilot/
├── src/
│   ├── cli.ts                    # Commander CLI 入口（--daemon / --mode / --workflow）
│   ├── core/                     # 编排器 + Agent 工厂 + 运行时工具集
│   │   ├── orchestrator.ts       # TargetProvider + 迭代循环
│   │   ├── agents/               # Claude / Codex 适配器
│   │   ├── git.ts · run.ts       # Git 交付管道 · 子进程执行
│   │   └── learning-tools.ts     # arrow_logs → 思考模板自动注入
│   ├── pilot/                    # 循环引擎 + Daemon + 自愈
│   │   ├── state-machine.ts      # FindTarget → DrawBoard → Shoot → MoveBoard
│   │   ├── runtime.ts            # 完整生命周期编排
│   │   ├── daemon.ts             # chokidar 事件订阅 + 整点自愈扫描
│   │   ├── review.ts             # 独立上下文 Review
│   │   ├── discovery.ts          # 自主目标发现
│   │   ├── test-executor.ts      # 客观评估前置
│   │   ├── agentic-healer.ts     # LLM 自愈升级路径
│   │   └── targets.ts            # Target 树存储与校验
│   ├── workflow/                 # Workflow 引擎 + 记忆
│   │   ├── compiler.ts           # workflow.md ASCII 框图 → CompiledWorkflow
│   │   ├── router-agent.ts       # 快模型路由决策
│   │   ├── four-layer-memory.ts  # 四层记忆 + KnowLever RAG 融合
│   │   ├── knowlever-client.ts   # KnowLever 知识增强
│   │   └── clean-memory-clause.ts
│   ├── templates/
│   │   ├── pattern-router.ts     # 12 模式自动匹配
│   │   └── patterns/*.json       # 思维模式模板库
│   ├── sdk/llm-proxy.ts          # PolarPrivate LLM 代理
│   └── rules/runtime-inject.ts
├── contracts/                    # 跨项目契约（assistant-task JSON Schema）
├── examples/research-workflow.md # Research 模式示例
├── tests/                        # 单元 + 集成 + 契约测试（170 用例）
├── capabilities.json             # 能力注册表
├── polaris.json                  # SSoT 需求与特性追踪
└── PolarSoul.md                  # 设计灵魂文档
```

**与 PolarClaw 的协作关系**：

```
用户 ──→ PolarClaw（主动任务 / YOLO 对齐 / Skill 调用）
              │
              ▼  POST /api/pilot/events
         PolarPilot Daemon（被动守护 / 自主循环 / 自愈）
              │
              ▼  lobster-events.jsonl
         PolarClaw LearningStore（arrow_logs 自学习）
```

---

## 快速开始

```bash
# 构建
npm ci && npm run build

# ── Guard 模式：事件驱动守护进程 ──
npx polarpilot --daemon --project MyProject
# → http://127.0.0.1:4900/api/pilot/health

# ── Research 模式：编译并串行执行 workflow.md ──
npx polarpilot "research goal" \
  --mode research \
  --project MyProject \
  --workflow examples/research-workflow.md

# ── Assistant 模式：PolarClaw 下发的一次性编排任务 ──
npx polarpilot \
  --mode assistant \
  --project MyProject \
  --assistant-task contracts/examples/assistant-task.example.json

# ── 可选参数 ──
#   --agent claude|codex
#   --max-iterations 50
#   --max-tokens 500000
#   --worktree          # 在独立 git worktree 中运行

# 开发 & 验证
npm run dev           # Watch 模式构建
npm test              # 170 用例全量回归
npm run typecheck     # TypeScript 类型检查
```

---

## 生态依赖

| 项目 | 角色 | 必须 |
|------|------|:----:|
| [PolarClaw](https://github.com/beichenO2/PolarClaw) | Lobster 事件通道 · `assistant_task` 契约 · 项目加锁 | 推荐 |
| [Agent_core](https://github.com/beichenO2/Agent_core) | 原则协议 · `thinking-pattern.schema.json` 契约 | 是 |
| [SOTAgent](https://github.com/beichenO2/SOTAgent) | `lobster-events.jsonl` 事件总线 | Guard 模式需要 |
| [PolarPrivate](https://github.com/beichenO2/PolarPrivate) | LLM Proxy · Agentic Healer 密钥路由 | 自愈需要 |
| [PolarMemory](https://github.com/beichenO2/PolarMemory) | Layer 1 语义记忆 · `/api/blocks/search` | 否 |
| [KnowLever](https://github.com/beichenO2/KnowLever) | RAG 知识增强 · 步骤间 enrichment 注入 | 否 |

---

## License

MIT

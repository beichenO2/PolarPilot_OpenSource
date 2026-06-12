# PolarSoul — PolarPilot 设计灵魂

## 设计哲学

PolarPilot 是 PolarClaw 的自主规划-执行 Skill，负责将需求拆解为可执行步骤并自动推进。

- **Target-driven not task-driven**: 层级化 Target 树（可测试叶节点），而非扁平任务列表
- **Receipt-based accountability**: 每次执行产出 Receipt（结果收据），可审计可恢复
- **Independent review**: Review 使用全新 Agent 上下文，避免"自己审自己"盲区
- **Pattern-driven thinking**: 不同编码任务需要不同思维模式（12+ 模式模板自动路由）
- **Self-evolving**: arrow_logs 反馈到 PolarClaw 学习系统，发现模式并自动生成技能
- **Clean Memory Clause (non-negotiable)**: 记忆文件每次刷新，无关记忆丢弃，无上下文污染，继承通过显式 checkpoint 文件

## 功能介绍

**生态位**: PolarClaw 的"大脑"，通过 workflow compiler + state machine + target system 实现自主任务管理

**承担功能**:

- **R1**: 项目骨架 + 从 PolarClaw 迁移（11 文件迁移，Commander CLI 入口）
- **R2**: Cycle 引擎核心 — Agent 工厂（claude/codex）、编排器、迭代 Prompt、运行时工具、独立上下文 Review、思维模式路由（12 JSON 模板）、arrow_logs 自学习、E3 自动注入循环
- **R3**: YOLO 内核 + 状态机融合（Receipt/Failure/Ledger 数据结构、编排器、processShot 消费 Receipt、Runtime 集成）
- **R4**: 进攻性自愈 Daemon（`lobster_start --project <name>`，不只是汇报错误，而是主动修复恶性 bug；项目被锁时停止工作，整点扫描触发，有 60min 窗口保护）
- **R5**: 自发现能力（Discovery 模块、状态机扩展、客观评估前端、完整自发现循环）
- **R6**: Workflow 引擎 + 路由决策（compiler、router-agent、memory、types、PilotMode 支持、executeWorkflow、runAssistantTask、CLI 路由）
- **R7**: 干净记忆 + PolarMemory 集成（四层记忆管理器、/api/blocks/search、checkpoint 刷新、PolarSoul 干净记忆条款）— pending

## 与 PolarClaw 的关系

- **PolarPilot 是 PolarClaw 的一个 Skill**，通过 daemon 事件订阅与 PolarClaw 交互
- 因复杂度高单拎为独立项目，但本质上是 PolarClaw 的内置能力
- 记忆功能由 PolarClaw 的 PolarMemory 模块提供，PolarPilot R7 集成调用
- arrow_logs 导出回 PolarClaw 的 LearningStore 用于自学习
- **CareEngine 是 PolarClaw 的特殊用户代理**：不是工作流链路组件，而是独立的主动关怀触发器，负责在空闲/日程触发时提醒 Agent 主动与用户交互（而不是被动等待用户消息）

## 关键设计决策

- **Why target-tree not task-list**: 层级化目标可分解、可测试、可追踪
- **Why YOLO needs alignment**: 自主执行前必须对齐，防止偏离用户意图
- **Why self-discovery**: 项目状态变化时自动感知并调整策略
- **Why objective evaluation first**: Review 前先跑测试，用客观指标代替主观判断
- **Why thinking pattern routing**: 不同任务类型需要不同思维框架

## SelfHealer 自愈机制

### 实现状态

`callSelfHealer` 已在 `src/pilot/daemon.ts` 完整实现（lines 175-267），不再是 stub。

### 核心流程

1. **触发条件**：HourlyScanner 每小时整点扫描，检测恶性 bug 触发信号
2. **加锁检查**：项目被锁或 2 小时内刚解锁 → 跳过
3. **执行自愈**：spawn `scripts/self-heal.sh`，通过 stdin 发送 bug signal JSON
4. **结果处理**：
   - 成功 → 写 `healing_completed` 事件到 lobster-events.jsonl
   - 失败 → 写 `healing_failed` 事件
   - Rate limit 耗尽 → 写 `healing_failed` + `reason: rate_limit_exhausted`
5. **Rate Limit Retry**：429 响应时等待 5 分钟重试，最多 3 次

### 事件 Schema

自愈完成后发布的事件格式：

```json
{
  "type": "healing_completed",
  "project": "<projectId>",
  "payload": {
    "bugType": "<triggerId>",
    "file": "<triggerFile>",
    "result": {
      "success": true,
      "message": "...",
      "fixedFiles": ["..."]
    }
  },
  "timestamp": "ISO 8601"
}
```

失败事件：

```json
{
  "type": "healing_failed",
  "project": "<projectId>",
  "payload": {
    "bugType": "<triggerId>",
    "file": "<triggerFile>",
    "reason": "rate_limit_exhausted" | "script_error",
    "attempts": 3
  },
  "timestamp": "ISO 8601"
}
```

## Daemon 进攻性自愈设计哲学

### 核心定位

PolarPilot Daemon（`lobster_start --project <name>`）是**独立于 PolarClaw 之外的自修复守护进程**，不是工作流链路中的一环。每个项目有自己专属的 Daemon 实例，优先级低于 PolarClaw。

### 与 PolarClaw 的关系

- PolarClaw 负责**主动发起任务**（用户交互、YOLO 对齐、技能调用）
- Daemon 负责**被动守护**（监控项目健康、自愈恶性 bug）
- 两者通过 `lobster-events.jsonl` 事件总线解耦，无直接调用

### 加锁机制（项目保护）

当 PolarClaw 在项目上执行 YOLO 任务时，会对项目加锁：
- 加锁期间 Daemon **完全停止工作**（不扫描、不触发、不自愈）
- 解锁后**等待 60 分钟**才恢复触发式启动
- 目的：防止 Daemon 和 PolarClaw 同时操作同一项目造成冲突

### 整点扫描触发机制

- 每小时整点，Daemon 扫描所有管辖项目的「触发信号」
- 必须同时满足：**有触发信号** + **过去 2 小时内项目未被加锁**
- 满足则触发自愈程序
- 自愈**不需要很快**（1 小时的扫描粒度足够），把探测切成大块减少设计复杂度

### 恶性 Bug 定义（本土化）

每个项目的「恶性 bug」定义各不相同，需要 Daemon 部署到项目后进行本土化配置：

```
恶性 Bug 示例（通用基线）：
- 编译失败（语法错误、导入错误）
- 测试套件整体失败（>50% 测试 failing）
- 进程崩溃循环（5min 内崩溃 3 次）

本土化扩展（项目级配置）：
- 每个项目在 lobster/daemon-config.json 定义自己的恶性 Bug 判定规则
- 例如：KnowLever 可能定义「OCR hallucination 检测失败」为恶性
- 例如：AutoOffice 可能定义「PDF 导出为空」为恶性
```

### 自愈能力范围

Daemon 尝试自动修复的边界：
- **可修复**：配置错误、依赖缺失、临时端口占用、测试 fixture 损坏
- **不可修复**（需人工）：架构设计错误、数据结构变更、API breaking change
- **修复策略**：发现恶性 bug → 分析错误类型 → 选择修复策略 → 执行 → 验证

### 触发式启动条件

```
整点扫描（每小时）
    ↓
检查项目是否有「触发信号」（恶性 bug 标志文件、错误日志关键字）
    ↓
    ├── 无触发信号 → 跳过该项目
    └── 有触发信号
            ↓
        检查「过去 2 小时是否有加锁记录」
            ↓
            ├── 有加锁记录（PolarClaw 正在工作）→ 跳过（即使有 bug）
            └── 无加锁记录
                    ↓
                触发自愈程序
```

### 与 Watchdog 的区别

| | SOTAgent Watchdog | PolarPilot Daemon |
|---|---|---|
| 职责 | 服务进程存活 | 项目代码健康 |
| 触发 | 进程退出/健康检查失败 | 恶性 bug 信号 |
| 动作 | 重启进程 | 尝试修复代码 |
| 范围 | 系统层（端口、进程） | 应用层（编译、测试、逻辑） |

## 依赖与被依赖

- **依赖**: PolarPrivate, PolarClaw (SDK adapter)
- **被依赖**: 所有 Polarisor 项目（项目龙虾守护）

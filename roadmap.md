# PolarPilot Roadmap

> 进度视图：当前阶段、完成情况、下一步。事实源是 `polaris.json`，本文件只做进度摘要。

## 当前状态

| 维度 | 状态 |
| --- | --- |
| 版本 | 0.1.0 |
| 项目状态 | active |

## Requirement 完成情况

| ID | 名称 | 完成度 | 说明 |
| --- | --- | --- | --- |
| R1 | 项目骨架与从 PolarClaw 迁移 | 100% | 全部 done |
| R2 | 循环引擎核心（FindTarget → DrawBoard → Shoot → MoveBoard） | 100% | 7/7 done |
| R3 | YOLO 内核与状态机融合 | 100% | 全部 done |
| R4 | 事件驱动 daemon HTTP 服务 + 进攻性自愈 | 100% | 全部 done |
| R5 | 自主发现能力 | 100% | 全部 done |
| R6 | Workflow 引擎与路由决策 | 100% | 全部 done |
| R7 | 干净记忆与 PolarMemory + KnowLever 集成 | 100% | 7/7 done |

## 已知阻塞项

无。

## 下一步

1. PilotRuntime 与 PolarClaw ReAct 循环深度集成。
2. Arrow Logs 可视化面板完善。
3. 多 Pilot 实例并行调度。

## 更新记录

| 日期 | 更新内容 |
| --- | --- |
| 2026-06-10 | 初始创建：从 polaris.json 提取进度信息 |

# PolarPilot — 使用指南

> 循环引擎：FindTarget→DrawBoard→Shoot→MoveBoard + YOLO + Workflow + 记忆集成

## 核心信息

| 维度 | 值 |
|---|---|
| 健康端点 | 端口 4900（/api/pilot/health） |
| 启动命令 | `node dist/cli.mjs --daemon` |
| 安装命令 | `npm ci` |
| 技术栈 | Node.js v22+, TypeScript, daemon 模式 |

## 快速启动

```bash
cd ~/Polarisor/PolarPilot
npm ci
node dist/cli.mjs --daemon
```

## 健康检查

```bash
curl -s http://127.0.0.1:4900/api/pilot/health
```

## 依赖服务

- PolarMemory (记忆)
- KnowLever (知识)
- PolarClaw (宿主框架)

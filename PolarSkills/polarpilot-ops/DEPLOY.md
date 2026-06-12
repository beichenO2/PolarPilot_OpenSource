# PolarPilot — 部署指南

> 循环引擎：FindTarget→DrawBoard→Shoot→MoveBoard + YOLO + Workflow + 记忆集成

## 环境要求

- 技术栈：Node.js v22+, TypeScript, daemon 模式
- 安装：`npm ci`

## 安装步骤

```bash
cd ~/Polarisor/PolarPilot
npm ci
```

## 启动方式

```bash
cd ~/Polarisor/PolarPilot
node dist/cli.mjs --daemon
```

## 端口分配

| 端口 | 用途 |
|---|---|
| 4900 | 主服务 |

## 健康检查确认

```bash
curl -s http://127.0.0.1:4900/api/pilot/health
```

## 回滚方式

```bash
cd ~/Polarisor/PolarPilot
git log --oneline -5
git checkout <previous-commit>
npm ci
node dist/cli.mjs --daemon
```

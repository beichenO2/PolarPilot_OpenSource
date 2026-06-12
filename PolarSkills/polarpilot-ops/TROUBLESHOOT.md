# PolarPilot — 故障排查

> 循环引擎：FindTarget→DrawBoard→Shoot→MoveBoard + YOLO + Workflow + 记忆集成

## 健康检查

```bash
# 进程存活
pgrep -f "PolarPilot" || echo "NOT RUNNING"

# HTTP 端点
curl -s http://127.0.0.1:4900/api/pilot/health
```

## 关键端口

| 端口 | 说明 |
|---|---|
| 4900 | PolarPilot 主服务 |

## 常见故障

### 1. daemon 进程退出

**修复**：`查看日志: cat logs/pilot.log`

### 2. Workflow 路由失败

**修复**：`检查 workflow 定义 JSON`

### 3. 记忆检索超时

**修复**：`确认 PolarMemory 服务可用`

## 依赖服务

- PolarMemory (记忆)
- KnowLever (知识)
- PolarClaw (宿主框架)

## 紧急恢复

```bash
cd ~/Polarisor/PolarPilot
node dist/cli.mjs --daemon
curl -s http://127.0.0.1:4900/api/pilot/health && echo 'OK' || echo 'BROKEN'
```

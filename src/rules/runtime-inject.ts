/**
 * 运行时规则注入 — PolarPilot daemon 消费 Agent_core/rules
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(import.meta.url))

function polarisorRoot(): string {
  return process.env.POLARISOR_ROOT ?? join(homedir(), 'Polarisor')
}

type RuntimeInject = typeof import('../../../Agent_core/rules/engine/runtime-inject.mjs')

let _mod: RuntimeInject | null = null

function mod(): RuntimeInject {
  if (!_mod) {
    _mod = require(join(polarisorRoot(), 'Agent_core/rules/engine/runtime-inject.mjs')) as RuntimeInject
  }
  return _mod
}

export function buildHealerSystemPrompt(eventText: string, taskBody: string): string {
  return mod().buildPilotSystem(eventText, taskBody)
}

/**
 * agentic-healer.ts — LLM-powered error analysis and fix generation.
 *
 * When mechanical self-healing (self-healer.ts) fails, this module
 * uses PolarPrivate LLM to analyze errors, generate fix plans,
 * and attempt automated repair.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const execAsync = promisify(exec)

import { getLLMClient } from '../sdk/llm-proxy.js'
const HEALER_KNOWLEDGE_PATH = join(
  process.env.HOME ?? '~',
  '.polarcop',
  'healer-knowledge.json'
)

export interface AgenticHealRequest {
  type: string
  sourceProject: string
  payload: Record<string, unknown>
}

export interface AgenticHealResult {
  success: boolean
  analysis: string
  fixApplied: string | null
  error: string | null
}

export async function agenticHeal(req: AgenticHealRequest): Promise<AgenticHealResult> {
  const polarisorRoot = join(process.env.HOME ?? '~', 'Polarisor')
  const projectDir = join(polarisorRoot, req.sourceProject)

  let polarisJson = '{}'
  try {
    polarisJson = readFileSync(join(projectDir, 'polaris.json'), 'utf-8')
  } catch { /* project may not have polaris.json */ }

  let recentLogs = ''
  try {
    const { stdout } = await execAsync('git log --oneline -3', { cwd: projectDir, timeout: 10_000 })
    recentLogs = stdout.trim()
  } catch { /* git may not be available */ }

  const priorKnowledge = loadKnowledge(req.sourceProject)

  const prompt = buildAnalysisPrompt(req, polarisJson, recentLogs, priorKnowledge)

  try {
    const eventText = `${req.type} ${req.sourceProject} ${JSON.stringify(req.payload)}`
    const analysis = await callLLM(prompt, eventText)
    const fixCommand = extractFixCommand(analysis)

    if (!fixCommand) {
      return { success: false, analysis, fixApplied: null, error: 'LLM did not produce an actionable fix command' }
    }

    try {
      await execAsync(fixCommand, { cwd: projectDir, timeout: 60_000 })
    } catch (err) {
      return {
        success: false,
        analysis,
        fixApplied: fixCommand,
        error: `Fix command failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const verified = await verifyFix(req, projectDir)
    if (verified) {
      saveKnowledge(req.sourceProject, req.type, fixCommand, analysis)
      await commitFix(projectDir, req)
    }

    return { success: verified, analysis, fixApplied: fixCommand, error: verified ? null : 'Fix applied but verification failed' }
  } catch (err) {
    return { success: false, analysis: '', fixApplied: null, error: `Agentic heal failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function buildAnalysisPrompt(
  req: AgenticHealRequest,
  polarisJson: string,
  recentLogs: string,
  priorKnowledge: string
): string {
  return `You are a self-healing agent for the ${req.sourceProject} project.

ERROR EVENT:
Type: ${req.type}
Payload: ${JSON.stringify(req.payload, null, 2)}

PROJECT CONTEXT (polaris.json):
${polarisJson.slice(0, 2000)}

RECENT GIT LOG:
${recentLogs}

${priorKnowledge ? `PRIOR SUCCESSFUL FIXES:\n${priorKnowledge}\n` : ''}

TASK:
1. Analyze the root cause of this error
2. Generate a single shell command that can fix it (must be safe, no destructive operations)
3. The command will run in the project directory

OUTPUT FORMAT:
<analysis>your analysis here</analysis>
<fix_command>the shell command to run</fix_command>

If you cannot determine a safe fix, output <fix_command>NONE</fix_command>`
}

async function callLLM(prompt: string, eventText: string): Promise<string> {
  let system = ''
  try {
    const { buildHealerSystemPrompt } = await import('../rules/runtime-inject.js')
    system = buildHealerSystemPrompt(
      eventText,
      '你是 Polarisor 生态的自愈 Agent（Slave）。分析错误并给出单一可执行 shell 修复命令。禁止破坏性操作。'
    )
  } catch {
    system = '你是 Polarisor 生态的自愈 Agent。分析错误并给出单一可执行 shell 修复命令。'
  }
  const messages = system
    ? [{ role: 'system' as const, content: system }, { role: 'user' as const, content: prompt }]
    : [{ role: 'user' as const, content: prompt }]
  return getLLMClient().chat('GLM-5.1', messages, { temperature: 0.3 })
}

function extractFixCommand(analysis: string): string | null {
  const match = analysis.match(/<fix_command>([\s\S]*?)<\/fix_command>/)
  if (!match) return null
  const cmd = match[1].trim()
  if (cmd === 'NONE' || !cmd) return null
  return cmd
}

async function verifyFix(req: AgenticHealRequest, projectDir: string): Promise<boolean> {
  const polarisPath = join(projectDir, 'polaris.json')
  if (!existsSync(polarisPath)) return true
  try {
    const polaris = JSON.parse(readFileSync(polarisPath, 'utf-8'))
    const healthEndpoint = polaris.service_management?.health_endpoint
    if (!healthEndpoint) return true
    const res = await fetch(healthEndpoint, { signal: AbortSignal.timeout(5_000) })
    return res.ok
  } catch {
    return false
  }
}

async function commitFix(projectDir: string, req: AgenticHealRequest): Promise<void> {
  try {
    await execAsync('git add -A && git commit -m "fix(auto-heal): ' + req.type.replace(/"/g, '\\"') + '"', {
      cwd: projectDir,
      timeout: 30_000,
    })
    await execAsync('git push', { cwd: projectDir, timeout: 30_000 })
  } catch { /* best effort */ }
}

function loadKnowledge(project: string): string {
  try {
    const data = JSON.parse(readFileSync(HEALER_KNOWLEDGE_PATH, 'utf-8'))
    const entries = (data[project] || []) as { type: string; fix: string; analysis: string }[]
    return entries.slice(-3).map(e => `- ${e.type}: ${e.fix}`).join('\n')
  } catch {
    return ''
  }
}

function saveKnowledge(project: string, type: string, fix: string, analysis: string): void {
  let data: Record<string, unknown[]> = {}
  try { data = JSON.parse(readFileSync(HEALER_KNOWLEDGE_PATH, 'utf-8')) } catch { /* fresh */ }
  if (!data[project]) data[project] = []
  ;(data[project] as unknown[]).push({ type, fix, analysis: analysis.slice(0, 500), timestamp: new Date().toISOString() })
  try { writeFileSync(HEALER_KNOWLEDGE_PATH, JSON.stringify(data, null, 2)) } catch { /* best effort */ }
}

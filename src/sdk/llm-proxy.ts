/**
 * PolarPrivate LLM Proxy SDK（PolarPilot）
 * 唯一信源：http://127.0.0.1:12790
 */

export const LLM_PROXY_BASE = 'http://127.0.0.1:12790'
const LLM_PROXY_V1 = `${LLM_PROXY_BASE}/v1`

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function toModelId(model: string, tier: 'cloud' | 'local' = 'cloud'): string {
  const m = (model ?? '').trim().toUpperCase()
  if (m === 'L000' || m === 'L100' || m === 'L101') return m
  if (m === 'E000') return 'E000'
  if (/^[01]{3}$/.test(m)) return tier === 'local' ? `L${m}` : m
  throw new Error(`Unknown model code "${m}". Local: L000, L100, L101.`)
}

export function createLLMClient() {
  return {
    async chat(
      model: string,
      messages: ChatMessage[],
      opts: { temperature?: number; timeoutMs?: number; tier?: 'cloud' | 'local' } = {},
    ): Promise<string> {
      const modelId = toModelId(model, opts.tier ?? 'cloud')
      const res = await fetch(`${LLM_PROXY_V1}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: opts.temperature ?? 0.3,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      })
      if (!res.ok) throw new Error(`LLM Proxy ${res.status}`)
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      return data.choices?.[0]?.message?.content ?? ''
    },
  }
}

let _client: ReturnType<typeof createLLMClient> | null = null

export function getLLMClient() {
  if (!_client) _client = createLLMClient()
  return _client
}

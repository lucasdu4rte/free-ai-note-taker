import Anthropic from '@anthropic-ai/sdk'

export async function completeWithClaude(config, system, text) {
  // Built per call so it picks up the global fetch that main.js points at Electron's proxy-aware net.fetch.
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL || undefined, maxRetries: config.retries, timeout: config.timeoutMs })
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content: text }],
  })
  if (response.stop_reason === 'refusal') {
    throw new Error(`O Claude recusou o pedido (${response.stop_details?.category ?? 'sem categoria'}).`)
  }
  // A truncated cleanup would silently drop part of the meeting.
  if (response.stop_reason === 'max_tokens') throw new Error('A resposta do Claude foi cortada no limite de tokens.')
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

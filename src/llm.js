import { completeWithClaude } from './anthropic.js'

const CLEANUP_PROMPT = `Você recebe um trecho de transcrição automática de uma reunião, com marcações de tempo [mm:ss].
Corrija pontuação, maiúsculas, palavras reconhecidas errado (pelo contexto) e remova vícios de linguagem e repetições.
Não resuma, não acrescente nada e não mude o sentido. Mantenha as marcações de tempo e o idioma original.
Responda apenas com o texto corrigido.`

const SUMMARY_PROMPT = `Você escreve atas de reunião. A partir da transcrição, escreva em Markdown, no idioma da reunião:

# Título curto da reunião (até 6 palavras)

## Resumo
3 a 6 frases com o objetivo e as conclusões.

## Decisões
- uma decisão por item

## Próximos passos
- [ ] tarefa — responsável, prazo (quando mencionados)

## Tópicos discutidos
- tópico: pontos principais

Use só o que está na transcrição. Omita seções sem conteúdo.`

const NOTES_PROMPT = `Você recebe uma parte da transcrição de uma reunião longa, com marcações de tempo [mm:ss].
Anote em Markdown, no idioma da reunião, só o que aparece nesta parte: assuntos, decisões, tarefas (com responsável e prazo quando mencionados) e números citados.
Seja breve, sem título nem introdução.`

const CLEANUP_BLOCK_CHARS = 6000
// About 15 minutes of talk: keeps every request under Groq's free per-minute token cap, small local context windows and the 30 s default limit.
const SUMMARY_BLOCK_CHARS = 12_000
const MAX_RETRIES = 3
// The settings test should answer fast with the real error instead of sitting through rate-limit retries.
const TEST_LIMITS = { retries: 0, timeoutMs: 30_000 }

export async function cleanTranscript(transcript, complete, onStatus) {
  const blocks = splitIntoBlocks(transcript, CLEANUP_BLOCK_CHARS)
  const cleaned = []
  for (const [i, block] of blocks.entries()) {
    cleaned.push(await complete(CLEANUP_PROMPT, block, `Revisando o texto ${i + 1}/${blocks.length}`, onStatus))
  }
  return cleaned.join('\n')
}

export async function summarize(transcript, complete, onStatus) {
  const blocks = splitIntoBlocks(transcript, SUMMARY_BLOCK_CHARS)
  if (blocks.length <= 1) return complete(SUMMARY_PROMPT, transcript, 'Gerando o resumo', onStatus)
  const notes = []
  for (const [i, block] of blocks.entries()) {
    notes.push(await complete(NOTES_PROMPT, block, `Resumindo a parte ${i + 1}/${blocks.length}`, onStatus))
  }
  return complete(SUMMARY_PROMPT, notes.join('\n\n'), 'Juntando o resumo', onStatus)
}

// The meeting stays on the service that answered, so a service that is down is not tried again for every block.
export function completeWithFallback(configs) {
  let active = 0
  const failures = []
  return async (system, text, label, onStatus = () => {}) => {
    for (; active < configs.length; active++) {
      const config = configs[active]
      const isLast = active === configs.length - 1
      onStatus(`${label} · ${config.model}${active ? ' (reserva)' : ''}`)
      try {
        return await complete(withRequestLimits(config, isLast), system, text)
      } catch (error) {
        failures.push(`${config.model}: ${error.message}`)
        if (isLast) throw new Error(failures.join(' · '))
      }
    }
  }
}

// With a reserve next in line, a failing service hands over at once instead of ~60 s of backoff.
export const withRequestLimits = (config, isLast) => ({
  ...config,
  retries: isLast ? MAX_RETRIES : 0,
  timeoutMs: Number(config.timeoutSeconds) * 1000 || undefined,
})

export const withTestLimits = (config) => ({ ...config, ...TEST_LIMITS })

export function testLlm(config) {
  return complete(withTestLimits(config), 'Responda apenas com a palavra OK.', 'Teste de conexão.')
}

const ANTHROPIC_API_PROVIDERS = ['anthropic', 'anthropic-compatible']

function complete(config, system, text) {
  if (ANTHROPIC_API_PROVIDERS.includes(config.provider)) return completeWithClaude(config, system, text)
  return chat(config, [{ role: 'system', content: system }, { role: 'user', content: text }])
}

export function splitIntoBlocks(text, maxChars) {
  const blocks = []
  let current = ''
  for (const line of text.split('\n')) {
    if (current && current.length + line.length > maxChars) {
      blocks.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }
  if (current) blocks.push(current)
  return blocks
}

export async function chat(config, messages) {
  const data = await postJson(`${config.baseURL}/chat/completions`, config.apiKey, JSON.stringify({ model: config.model, messages }), config)
  // Reasoning models served by Ollama/Groq may inline their thinking.
  return data.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

// Free tiers (Gemini, Groq) answer 429 often, so rate limits and server errors are retried with backoff.
export async function postJson(url, apiKey, body, { retries = MAX_RETRIES, timeoutMs } = {}) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  if (typeof body === 'string') headers['Content-Type'] = 'application/json'
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetch(url, { method: 'POST', headers, body, signal }).catch((error) => {
    if (!signal?.aborted) throw error
    throw new Error(`${new URL(url).host} não respondeu em ${timeoutMs / 1000} s.`)
  })
  const data = await res.json().catch(() => null)
  if (res.ok) return data

  const retryable = res.status === 429 || res.status >= 500
  if (retryable && retries > 0) {
    const attempt = MAX_RETRIES - retries + 1
    const retryAfterSeconds = Number(res.headers.get('retry-after')) || 10 * attempt
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000))
    return postJson(url, apiKey, body, { retries: retries - 1, timeoutMs })
  }
  const detail = data?.error?.message ?? data?.[0]?.error?.message ?? JSON.stringify(data)
  throw new Error(`${new URL(url).host} respondeu HTTP ${res.status}: ${detail}`)
}

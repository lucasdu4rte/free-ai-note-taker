const CLEANUP_PROMPT = `Você recebe um trecho de transcrição automática de uma reunião, com marcações de tempo [mm:ss].
Corrija pontuação, maiúsculas, palavras reconhecidas errado (pelo contexto) e remova vícios de linguagem e repetições.
Não resuma, não acrescente nada e não mude o sentido. Mantenha as marcações de tempo e o idioma original.
Responda apenas com o texto corrigido.`

const SUMMARY_PROMPT = `Você escreve atas de reunião. A partir da transcrição, escreva em Markdown, no idioma da reunião:

## Resumo
3 a 6 frases com o objetivo e as conclusões.

## Decisões
- uma decisão por item

## Próximos passos
- [ ] tarefa — responsável, prazo (quando mencionados)

## Tópicos discutidos
- tópico: pontos principais

Use só o que está na transcrição. Omita seções sem conteúdo.`

const CLEANUP_BLOCK_CHARS = 6000
const MAX_ATTEMPTS = 4

export async function cleanTranscript(transcript, config, onStatus) {
  const blocks = splitIntoBlocks(transcript, CLEANUP_BLOCK_CHARS)
  const cleaned = []
  for (const [i, block] of blocks.entries()) {
    onStatus(`Revisando o texto ${i + 1}/${blocks.length}`)
    cleaned.push(await chat(config, [{ role: 'system', content: CLEANUP_PROMPT }, { role: 'user', content: block }]))
  }
  return cleaned.join('\n')
}

export function summarize(transcript, config) {
  return chat(config, [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: transcript }])
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
  const data = await postJson(`${config.baseURL}/chat/completions`, config.apiKey, JSON.stringify({ model: config.model, messages }))
  // Reasoning models served by Ollama/Groq may inline their thinking.
  return data.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

// Free tiers (Gemini, Groq) answer 429 often, so rate limits and server errors are retried with backoff.
export async function postJson(url, apiKey, body, attempt = 1) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  if (typeof body === 'string') headers['Content-Type'] = 'application/json'
  const res = await fetch(url, { method: 'POST', headers, body })
  const data = await res.json().catch(() => null)
  if (res.ok) return data

  const retryable = res.status === 429 || res.status >= 500
  if (retryable && attempt < MAX_ATTEMPTS) {
    const retryAfterSeconds = Number(res.headers.get('retry-after')) || 10 * attempt
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000))
    return postJson(url, apiKey, body, attempt + 1)
  }
  const detail = data?.error?.message ?? data?.[0]?.error?.message ?? JSON.stringify(data)
  throw new Error(`${new URL(url).host} respondeu HTTP ${res.status}: ${detail}`)
}

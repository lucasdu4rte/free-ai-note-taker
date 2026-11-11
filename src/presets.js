const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const GROQ_URL = 'https://api.groq.com/openai/v1'
const OPENAI_URL = 'https://api.openai.com/v1'

// mode 'transcriptions' = OpenAI-style /audio/transcriptions; 'chat-audio' = audio sent to /chat/completions.
export const TRANSCRIPTION_PRESETS = {
  local: { label: 'Local: NVIDIA Parakeet v3 (grátis, offline)' },
  groq: { label: 'Groq: Whisper (plano grátis)', baseURL: GROQ_URL, model: 'whisper-large-v3-turbo', mode: 'transcriptions' },
  gemini: { label: 'Google Gemini (plano grátis)', baseURL: GEMINI_URL, model: 'gemini-3.8-flash', mode: 'chat-audio' },
  openai: { label: 'OpenAI', baseURL: OPENAI_URL, model: 'gpt-4o-mini-transcribe', mode: 'transcriptions' },
  custom: { label: 'OpenAI Compatível', baseURL: '', model: '', mode: 'transcriptions' },
}

export const LLM_PRESETS = {
  gemini: { label: 'Google Gemini', baseURL: GEMINI_URL, model: 'gemini-3.8-flash' },
  anthropic: { label: 'Anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
  // A model running on the CPU can take minutes per block.
  ollama: { label: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'gemma3:4b', timeoutSeconds: '0' },
  groq: { label: 'Groq', baseURL: GROQ_URL, model: 'openai/gpt-oss-120b' },
  openai: { label: 'OpenAI', baseURL: OPENAI_URL, model: 'gpt-5.4-mini' },
  custom: { label: 'OpenAI Compatível', baseURL: '', model: '' },
  'anthropic-compatible': { label: 'Anthropic Compatível', baseURL: '', model: '' },
}

export function fromPreset(presets, provider) {
  const { label, ...config } = presets[provider]
  return { provider, apiKey: '', ...config }
}

// timeoutSeconds '0' means no limit. A saved provider missing from the presets must not stop the settings from loading.
const withTimeout = (config) => ({ timeoutSeconds: LLM_PRESETS[config.provider]?.timeoutSeconds ?? '30', ...config })

export const llmFromPreset = (provider) => withTimeout(fromPreset(LLM_PRESETS, provider))

export const DEFAULT_SETTINGS = {
  transcription: fromPreset(TRANSCRIPTION_PRESETS, 'local'),
  llm: llmFromPreset('gemini'),
  llmFallbacks: [],
  llmProfiles: {},
}

// Settings saved before reserves existed have neither reserves nor a time limit.
// llmProfiles keeps the last config of every AI provider, so switching away and back loses nothing.
export function withSettingsDefaults(saved) {
  const llm = withTimeout(saved.llm)
  const llmFallbacks = (saved.llmFallbacks ?? []).map(withTimeout)
  const llmProfiles = Object.fromEntries(Object.entries(saved.llmProfiles ?? {}).map(([provider, config]) => [provider, withTimeout(config)]))
  // Copies, not the same objects: saving encrypts each config's key once, and a shared object would be encrypted twice.
  for (const config of [llm, ...llmFallbacks]) llmProfiles[config.provider] = { ...config }
  return { ...saved, llm, llmFallbacks, llmProfiles }
}

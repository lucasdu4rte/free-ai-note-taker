const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const GROQ_URL = 'https://api.groq.com/openai/v1'
const OPENAI_URL = 'https://api.openai.com/v1'

// mode 'transcriptions' = OpenAI-style /audio/transcriptions; 'chat-audio' = audio sent to /chat/completions.
export const TRANSCRIPTION_PRESETS = {
  local: { label: 'Local: NVIDIA Parakeet v3 (grátis, offline)' },
  groq: { label: 'Groq: Whisper (plano grátis)', baseURL: GROQ_URL, model: 'whisper-large-v3-turbo', mode: 'transcriptions' },
  gemini: { label: 'Google Gemini (plano grátis)', baseURL: GEMINI_URL, model: 'gemini-3.8-flash', mode: 'chat-audio' },
  openai: { label: 'OpenAI', baseURL: OPENAI_URL, model: 'gpt-4o-mini-transcribe', mode: 'transcriptions' },
  custom: { label: 'Outro compatível com OpenAI', baseURL: '', model: '', mode: 'transcriptions' },
}

export const LLM_PRESETS = {
  gemini: { label: 'Google Gemini (plano grátis)', baseURL: GEMINI_URL, model: 'gemini-3.8-flash' },
  ollama: { label: 'Ollama (local, grátis)', baseURL: 'http://localhost:11434/v1', model: 'gemma3:4b' },
  groq: { label: 'Groq (plano grátis, limite baixo)', baseURL: GROQ_URL, model: 'openai/gpt-oss-120b' },
  openai: { label: 'OpenAI', baseURL: OPENAI_URL, model: 'gpt-5.4-mini' },
  custom: { label: 'Outro compatível com OpenAI', baseURL: '', model: '' },
}

export function fromPreset(presets, provider) {
  const { label, ...config } = presets[provider]
  return { provider, apiKey: '', ...config }
}

export const DEFAULT_SETTINGS = {
  transcription: fromPreset(TRANSCRIPTION_PRESETS, 'local'),
  llm: fromPreset(LLM_PRESETS, 'gemini'),
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sherpa from 'sherpa-onnx-node'
import { LOCAL_ASR_MODELS, VAD_MODEL, ensureModels } from './models.js'
import { speechSegments, transcribeCloud, transcribeLocal } from './transcribe.js'
import { cleanTranscript, completeWithFallback, summarize, withTestLimits } from './llm.js'
import { repairWavHeader } from './wav.js'
import { STEPS } from './notes.js'

export const FILES = {
  audio: 'audio.wav',
  rawTranscript: 'transcricao-bruta.md',
  transcript: 'transcricao.md',
  summary: 'resumo.md',
  title: 'titulo.txt',
}

const SAMPLE_AUDIO = path.join(import.meta.dirname, 'sample.wav')

const STEP_OUTPUTS = { transcribe: FILES.rawTranscript, clean: FILES.transcript, summarize: FILES.summary }

export const completedSteps = (dir) => STEPS.filter((step) => fs.existsSync(path.join(dir, STEP_OUTPUTS[step])))

// Starting at `from` reuses the earlier outputs, so retrying a failed LLM step (e.g. a free-tier quota) never redoes the transcription.
export async function processMeeting(dir, settings, modelsDir, onProgress = () => {}, from = STEPS[0]) {
  if (!STEPS.includes(from)) throw new Error(`Etapa inválida: ${from}`)
  const file = (name) => path.join(dir, name)
  const read = (step) => fs.readFileSync(file(STEP_OUTPUTS[step]), 'utf8')
  const complete = completeWithFallback([settings.llm, ...settings.llmFallbacks])
  const run = {
    transcribe: async (report) => {
      const raw = await transcribe(file(FILES.audio), settings.transcription, modelsDir, report)
      if (!raw) throw new Error('Nenhuma fala foi detectada no áudio.')
      return raw
    },
    clean: (report) => cleanTranscript(read('transcribe'), complete, report),
    summarize: (report) => summarize(read('clean'), complete, report),
  }
  for (const step of STEPS.slice(STEPS.indexOf(from))) {
    onProgress(step)
    fs.writeFileSync(file(STEP_OUTPUTS[step]), await run[step]((detail) => onProgress(step, detail)))
  }
}

export async function testTranscription(config, modelsDir, onStatus = () => {}) {
  // The packaged sample sits inside app.asar, which sherpa-onnx's native file reader cannot open.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-taker-test-'))
  const audioPath = path.join(dir, FILES.audio)
  fs.writeFileSync(audioPath, fs.readFileSync(SAMPLE_AUDIO))
  try {
    const transcript = await transcribe(audioPath, withTestLimits(config), modelsDir, onStatus)
    if (!transcript) throw new Error('Nenhuma fala foi reconhecida no áudio de teste.')
    return transcript.replace(/^\[[\d:]+\] /gm, '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function transcribe(audioPath, config, modelsDir, onStatus) {
  const local = config.provider === 'local'
  const models = await ensureModels(modelsDir, local ? LOCAL_ASR_MODELS : VAD_MODEL, onStatus)

  repairWavHeader(audioPath)
  // Electron forbids external (native-owned) buffers, so ask sherpa-onnx for a copied one.
  const { samples } = sherpa.readWave(audioPath, false)
  onStatus('Detectando trechos de fala')
  const segments = await speechSegments(samples, models.vad)

  const lines = local ? await transcribeLocal(segments, models, onStatus) : await transcribeCloud(segments, config, onStatus)
  return lines.map(({ start, text }) => `[${formatTime(start)}] ${text}`).join('\n')
}

export function formatTime(seconds) {
  const s = Math.floor(seconds)
  const hh = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
}

export function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sherpa from 'sherpa-onnx-node'
import { LOCAL_ASR_MODELS, VAD_MODEL, ensureModels } from './models.js'
import { speechSegments, transcribeCloud, transcribeLocal } from './transcribe.js'
import { cleanTranscript, summarize, withTestLimits } from './llm.js'
import { repairWavHeader } from './wav.js'

export const FILES = {
  audio: 'audio.wav',
  rawTranscript: 'transcricao-bruta.md',
  transcript: 'transcricao.md',
  summary: 'resumo.md',
  title: 'titulo.txt',
}

const SAMPLE_AUDIO = path.join(import.meta.dirname, 'sample.wav')

export async function processMeeting(dir, settings, modelsDir, onStatus = () => {}) {
  const file = (name) => path.join(dir, name)

  // Reprocessing after an LLM failure (e.g. a free-tier quota) reuses the transcript instead of redoing it.
  let raw = readIfExists(file(FILES.rawTranscript))
  if (!raw) {
    raw = await transcribe(file(FILES.audio), settings.transcription, modelsDir, onStatus)
    if (!raw) throw new Error('Nenhuma fala foi detectada no áudio.')
    fs.writeFileSync(file(FILES.rawTranscript), raw)
  }

  const transcript = await cleanTranscript(raw, settings.llm, onStatus)
  fs.writeFileSync(file(FILES.transcript), transcript)

  onStatus('Gerando o resumo')
  fs.writeFileSync(file(FILES.summary), await summarize(transcript, settings.llm))
  onStatus('Pronto')
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

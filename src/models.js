import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const PARAKEET_V3 = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/'

const MODEL_URLS = {
  vad: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  encoder: PARAKEET_V3 + 'encoder.int8.onnx',
  decoder: PARAKEET_V3 + 'decoder.int8.onnx',
  joiner: PARAKEET_V3 + 'joiner.int8.onnx',
  tokens: PARAKEET_V3 + 'tokens.txt',
}

const DOWNLOAD_ATTEMPTS = 4

export const VAD_MODEL = ['vad']
export const LOCAL_ASR_MODELS = ['vad', 'encoder', 'decoder', 'joiner', 'tokens']

export async function ensureModels(dir, names, onStatus = () => {}) {
  fs.mkdirSync(dir, { recursive: true })
  const paths = {}
  for (const name of names) {
    const url = MODEL_URLS[name]
    const file = path.join(dir, path.basename(url))
    paths[name] = file
    if (fs.existsSync(file)) continue
    await downloadFile(url, file, (pct) => onStatus(`Baixando modelo ${path.basename(file)}: ${pct}%`))
  }
  return paths
}

// GitHub and Hugging Face downloads fail with the odd 5xx or dropped connection; the user should not have to retry by hand.
export async function downloadFile(url, file, onProgress, attempt = 1) {
  try {
    await download(url, file, onProgress)
  } catch (error) {
    const retryable = error.status === undefined || error.status === 429 || error.status >= 500
    if (!retryable || attempt >= DOWNLOAD_ATTEMPTS) throw error
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
    await downloadFile(url, file, onProgress, attempt + 1)
  }
}

async function download(url, file, onProgress) {
  const res = await fetch(url)
  if (!res.ok) throw Object.assign(new Error(`Falha ao baixar ${url}: HTTP ${res.status}`), { status: res.status })
  const total = Number(res.headers.get('content-length'))
  let received = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body)
  body.on('data', (chunk) => {
    received += chunk.length
    const pct = total ? Math.floor((received * 100) / total) : 0
    if (pct !== lastPct) onProgress((lastPct = pct))
  })
  // The .part file keeps an interrupted download from being mistaken for a complete model.
  await pipeline(body, fs.createWriteStream(file + '.part'))
  fs.renameSync(file + '.part', file)
}

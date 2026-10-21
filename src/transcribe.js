import os from 'node:os'
import sherpa from 'sherpa-onnx-node'
import { SAMPLE_RATE, encodeWav } from './wav.js'
import { chat, postJson } from './llm.js'

const VAD_WINDOW = 512
// Each chunk becomes a ~9.6 MB WAV: under OpenAI's 25 MB upload limit and Gemini's 20 MB inline request limit.
const CLOUD_CHUNK_SECONDS = 300

export async function speechSegments(samples, vadModel) {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadModel,
        threshold: 0.5,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: VAD_WINDOW,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
    },
    60,
  )
  const segments = []
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      segments.push({ start: segment.start / SAMPLE_RATE, samples: segment.samples })
      vad.pop()
    }
  }
  for (let i = 0; i < samples.length; i += VAD_WINDOW) {
    vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW))
    drain()
    // Yield every ~30 s of audio so the Electron main process keeps the window responsive.
    if (i % (SAMPLE_RATE * 30) < VAD_WINDOW) await new Promise(setImmediate)
  }
  vad.flush()
  drain()
  return segments
}

export async function transcribeLocal(segments, models, onStatus) {
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: models.encoder, decoder: models.decoder, joiner: models.joiner },
      tokens: models.tokens,
      modelType: 'nemo_transducer',
      numThreads: Math.min(4, os.availableParallelism()),
      provider: 'cpu',
    },
  })
  const lines = []
  for (const [i, segment] of segments.entries()) {
    onStatus(`Transcrevendo (local) ${i + 1}/${segments.length}`)
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: segment.samples, sampleRate: SAMPLE_RATE })
    const { text } = await recognizer.decodeAsync(stream)
    if (text.trim()) lines.push({ start: segment.start, text: text.trim() })
  }
  return lines
}

export async function transcribeCloud(segments, config, onStatus) {
  const chunks = groupSegments(segments, CLOUD_CHUNK_SECONDS)
  const lines = []
  for (const [i, chunk] of chunks.entries()) {
    onStatus(`Transcrevendo (nuvem) ${i + 1}/${chunks.length}`)
    const wav = encodeWav(chunk.samples)
    const text = config.mode === 'chat-audio' ? await transcribeWithChat(wav, config) : await transcribeWithApi(wav, config)
    if (text.trim()) lines.push({ start: chunk.start, text: text.trim() })
  }
  return lines
}

export function groupSegments(segments, maxSeconds) {
  const chunks = []
  let current
  for (const segment of segments) {
    if (!current || current.length + segment.samples.length > maxSeconds * SAMPLE_RATE) {
      current = { start: segment.start, parts: [], length: 0 }
      chunks.push(current)
    }
    current.parts.push(segment.samples)
    current.length += segment.samples.length
  }
  return chunks.map(({ start, parts, length }) => {
    const samples = new Float32Array(length)
    let offset = 0
    for (const part of parts) {
      samples.set(part, offset)
      offset += part.length
    }
    return { start, samples }
  })
}

async function transcribeWithApi(wav, config) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', config.model)
  const data = await postJson(`${config.baseURL}/audio/transcriptions`, config.apiKey, form)
  return data.text
}

function transcribeWithChat(wav, config) {
  return chat(config, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Transcreva este áudio literalmente, no idioma falado. Responda apenas com a transcrição.' },
        { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } },
      ],
    },
  ])
}

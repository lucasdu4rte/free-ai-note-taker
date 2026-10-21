import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sherpa from 'sherpa-onnx-node'
import { LOCAL_ASR_MODELS, ensureModels } from '../src/models.js'
import { FILES, formatTime, processMeeting } from '../src/pipeline.js'
import { groupSegments, speechSegments, transcribeLocal } from '../src/transcribe.js'
import { postJson, splitIntoBlocks } from '../src/llm.js'
import { encodeWav, repairWavHeader, wavHeader } from '../src/wav.js'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'fala.wav')
// Set MODELS_DIR to the app's models folder to also run the local Parakeet test without re-downloading 650 MB.
const MODELS_DIR = process.env.MODELS_DIR ?? path.join(os.tmpdir(), 'free-ai-note-taker-models')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'note-taker-'))

test('a recording cut short by a crash is readable after repairing its header', () => {
  const file = path.join(tmp(), FILES.audio)
  const samples = new Float32Array(16000).map((_, i) => Math.sin(i / 10) / 2)
  fs.writeFileSync(file, Buffer.concat([wavHeader(0), encodeWav(samples).subarray(44)]))

  repairWavHeader(file)

  const wave = sherpa.readWave(file)
  assert.equal(wave.sampleRate, 16000)
  assert.equal(wave.samples.length, samples.length)
  assert.ok(Math.abs(wave.samples[100] - samples[100]) < 1e-3)
})

test('speech segments are grouped into chunks no longer than the limit', () => {
  const second = (start) => ({ start, samples: new Float32Array(16000).fill(start) })
  const chunks = groupSegments([second(0), second(5), second(9), second(20)], 2)

  assert.deepEqual(chunks.map((c) => [c.start, c.samples.length]), [[0, 32000], [9, 32000]])
  assert.equal(chunks[0].samples[16000], 5)
})

test('long transcripts are split on line boundaries', () => {
  const blocks = splitIntoBlocks('aaaa\nbbbb\ncccc', 9)
  assert.deepEqual(blocks, ['aaaa\nbbbb', 'cccc'])
})

test('timestamps show hours only when needed', () => {
  assert.equal(formatTime(65.7), '01:05')
  assert.equal(formatTime(3725), '1:02:05')
})

test('rate-limited requests are retried', async () => {
  let calls = 0
  const server = await fakeApi((_req, res) => {
    if (++calls === 1) return res.writeHead(429, { 'retry-after': '0.1' }).end('{}')
    res.end(JSON.stringify({ ok: true }))
  })
  assert.deepEqual(await postJson(`${server.url}/x`, 'key', '{}'), { ok: true })
  assert.equal(calls, 2)
  server.close()
})

test('a meeting goes from audio to transcript and summary with cloud providers', async () => {
  const requests = []
  const server = await fakeApi(async (req, res) => {
    const body = await readBody(req)
    requests.push({ url: req.url, auth: req.headers.authorization, body })
    if (req.url === '/audio/transcriptions') return res.end(JSON.stringify({ text: 'bom dia pessoal' }))
    const { messages } = JSON.parse(body)
    const isSummary = messages[0].content.includes('atas de reunião')
    res.end(JSON.stringify({ choices: [{ message: { content: isSummary ? '## Resumo\nReunião curta.' : 'Bom dia, pessoal.' } }] }))
  })
  const dir = tmp()
  fs.copyFileSync(FIXTURE, path.join(dir, FILES.audio))
  const provider = { provider: 'custom', baseURL: server.url, apiKey: 'secret', model: 'm', mode: 'transcriptions' }

  await processMeeting(dir, { transcription: provider, llm: provider }, MODELS_DIR)

  assert.match(fs.readFileSync(path.join(dir, FILES.rawTranscript), 'utf8'), /^\[00:0\d\] bom dia pessoal$/)
  assert.equal(fs.readFileSync(path.join(dir, FILES.transcript), 'utf8'), 'Bom dia, pessoal.')
  assert.equal(fs.readFileSync(path.join(dir, FILES.summary), 'utf8'), '## Resumo\nReunião curta.')
  assert.deepEqual(requests.map((r) => r.url), ['/audio/transcriptions', '/chat/completions', '/chat/completions'])
  assert.ok(requests.every((r) => r.auth === 'Bearer secret'))
  assert.match(requests[0].body, /RIFF/)
  server.close()
})

const hasLocalModel = fs.existsSync(path.join(MODELS_DIR, 'encoder.int8.onnx'))

test('the local NVIDIA Parakeet model transcribes Portuguese', { skip: !hasLocalModel && 'set MODELS_DIR' }, async () => {
  const models = await ensureModels(MODELS_DIR, LOCAL_ASR_MODELS)
  const segments = await speechSegments(sherpa.readWave(FIXTURE).samples, models.vad)
  const lines = await transcribeLocal(segments, models, () => {})
  assert.match(lines.map((l) => l.text).join(' ').toLowerCase(), /bom dia.*reunião de planejamento/)
})

async function fakeApi(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  server.url = `http://127.0.0.1:${server.address().port}`
  return server
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sherpa from 'sherpa-onnx-node'
import { LOCAL_ASR_MODELS, downloadFile, ensureModels } from '../src/models.js'
import { FILES, completedSteps, formatTime, processMeeting, testTranscription } from '../src/pipeline.js'
import { STEPS } from '../src/notes.js'
import { groupSegments, speechSegments, transcribeLocal } from '../src/transcribe.js'
import { cleanTranscript, completeWithFallback, postJson, splitIntoBlocks, summarize, testLlm, withRequestLimits } from '../src/llm.js'
import { encodeWav, repairWavHeader, wavHeader } from '../src/wav.js'

const FIXTURE = path.join(import.meta.dirname, '..', 'src', 'sample.wav')
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

test('model downloads are retried when the server has a hiccup', async () => {
  let calls = 0
  const server = await fakeApi((_req, res) => {
    if (++calls === 1) return res.writeHead(504).end()
    res.end('model')
  })
  const file = path.join(tmp(), 'model.onnx')
  await downloadFile(`${server.url}/model.onnx`, file, () => {})
  assert.equal(fs.readFileSync(file, 'utf8'), 'model')
  assert.equal(calls, 2)
  server.close()
})

test('a missing model file is not retried', async () => {
  let calls = 0
  const server = await fakeApi((_req, res) => {
    calls++
    res.writeHead(404).end()
  })
  await assert.rejects(downloadFile(`${server.url}/x.onnx`, path.join(tmp(), 'x.onnx'), () => {}), /HTTP 404/)
  assert.equal(calls, 1)
  server.close()
})

test('the connection test reports a rate limit at once instead of retrying', async () => {
  let calls = 0
  const server = await fakeApi((_req, res) => {
    calls++
    res.writeHead(429).end(JSON.stringify({ error: { message: 'quota exceeded' } }))
  })
  await assert.rejects(testLlm({ provider: 'custom', baseURL: server.url, model: 'm' }), /HTTP 429: quota exceeded/)
  assert.equal(calls, 1)
  server.close()
})

test('a request that never answers gives up after its timeout', async () => {
  const server = await fakeApi(() => {})
  await assert.rejects(postJson(`${server.url}/x`, '', '{}', { timeoutMs: 100 }), /não respondeu em 0.1 s/)
  server.closeAllConnections()
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

  const reportedSteps = new Set()
  await processMeeting(dir, { transcription: provider, llm: provider, llmFallbacks: [] }, MODELS_DIR, (step) => reportedSteps.add(step))

  assert.match(fs.readFileSync(path.join(dir, FILES.rawTranscript), 'utf8'), /^\[00:0\d\] bom dia pessoal$/)
  assert.equal(fs.readFileSync(path.join(dir, FILES.transcript), 'utf8'), 'Bom dia, pessoal.')
  assert.equal(fs.readFileSync(path.join(dir, FILES.summary), 'utf8'), '## Resumo\nReunião curta.')
  assert.deepEqual(requests.map((r) => r.url), ['/audio/transcriptions', '/chat/completions', '/chat/completions'])
  assert.ok(requests.every((r) => r.auth === 'Bearer secret'))
  assert.match(requests[0].body, /RIFF/)
  assert.deepEqual([...reportedSteps], STEPS)
  assert.deepEqual(completedSteps(dir), STEPS)
  server.close()
})

test('a failed step can be retried on its own', async () => {
  let summaryFails = true
  const calls = []
  const server = await fakeApi(async (req, res) => {
    const isSummary = JSON.parse(await readBody(req)).messages[0].content.includes('atas de reunião')
    calls.push(isSummary ? 'summarize' : 'clean')
    if (isSummary && summaryFails) return res.writeHead(400).end(JSON.stringify({ error: { message: 'high demand' } }))
    res.end(JSON.stringify({ choices: [{ message: { content: isSummary ? '## Resumo\nNovo.' : 'Bom dia.' } }] }))
  })
  const dir = tmp()
  fs.writeFileSync(path.join(dir, FILES.rawTranscript), '[00:01] bom dia')
  const settings = { llm: { provider: 'custom', baseURL: server.url, model: 'm' }, llmFallbacks: [] }

  await assert.rejects(processMeeting(dir, settings, MODELS_DIR, () => {}, 'clean'), /HTTP 400: high demand/)
  assert.deepEqual(completedSteps(dir), ['transcribe', 'clean'])

  summaryFails = false
  const reportedSteps = new Set()
  await processMeeting(dir, settings, MODELS_DIR, (step) => reportedSteps.add(step), 'summarize')

  assert.deepEqual(calls, ['clean', 'summarize', 'summarize'])
  assert.deepEqual([...reportedSteps], ['summarize'])
  assert.equal(fs.readFileSync(path.join(dir, FILES.summary), 'utf8'), '## Resumo\nNovo.')
  server.close()
})

test('an unknown step is rejected', async () => {
  let calls = 0
  const server = await fakeApi((_req, res) => {
    calls++
    res.end('{}')
  })
  const provider = { provider: 'custom', baseURL: server.url, model: 'm' }

  await assert.rejects(processMeeting(tmp(), { transcription: provider, llm: provider }, MODELS_DIR, () => {}, 'x'), /Etapa inválida: x/)
  assert.equal(calls, 0)
  server.close()
})

test('the connection test transcribes the bundled sample and checks the AI', async () => {
  const server = await fakeApi(async (req, res) => {
    await readBody(req)
    if (req.url === '/audio/transcriptions') return res.end(JSON.stringify({ text: 'bom dia pessoal' }))
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
  })
  const provider = { provider: 'custom', baseURL: server.url, apiKey: 'secret', model: 'm', mode: 'transcriptions' }

  assert.equal(await testTranscription(provider, MODELS_DIR), 'bom dia pessoal')
  assert.equal(await testLlm(provider), 'OK')
  server.close()
})

test('summaries can be written by Claude through the Anthropic API', async () => {
  let request
  const server = await fakeApi(async (req, res) => {
    request = { url: req.url, headers: req.headers, body: JSON.parse(await readBody(req)) }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(claudeMessage([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '## Resumo\nOk.' }])))
  })
  const config = { provider: 'anthropic', baseURL: server.url, apiKey: 'sk-ant-test', model: 'claude-haiku-5-5' }

  assert.equal(await summarize('[00:01] bom dia', completeWithFallback([config])), '## Resumo\nOk.')

  assert.equal(request.url, '/v1/messages')
  assert.ok([request.headers.authorization, request.headers['x-api-key']].some((h) => h?.includes('sk-ant-test')))
  assert.ok(request.headers['anthropic-version'])
  assert.equal(request.body.model, 'claude-haiku-5-5')
  assert.match(request.body.system, /atas de reunião/)
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '[00:01] bom dia' }])
  server.close()
})

test('an Anthropic-compatible server gets the Messages API without Claude-only options', async () => {
  let request
  const server = await fakeApi(async (req, res) => {
    request = { url: req.url, body: JSON.parse(await readBody(req)) }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(claudeMessage([{ type: 'text', text: 'OK' }])))
  })
  const config = { provider: 'anthropic-compatible', baseURL: server.url, apiKey: 'k', model: 'deepseek-chat' }

  assert.equal(await testLlm(config), 'OK')
  assert.equal(request.url, '/v1/messages')
  assert.equal(request.body.max_tokens, 8192)
  assert.equal(request.body.output_config, undefined)
  server.close()
})

test('a Claude refusal is reported instead of saved as a summary', async () => {
  const server = await fakeApi((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ...claudeMessage([]), stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }))
  })
  const config = { provider: 'anthropic', baseURL: server.url, apiKey: 'k', model: 'claude-haiku-5-5' }

  await assert.rejects(summarize('texto', completeWithFallback([config])), /recusou.*cyber/)
  server.close()
})

test('a failing service hands the rest of the meeting to the reserve', async () => {
  let primaryCalls = 0
  const primary = await fakeApi((_req, res) => {
    primaryCalls++
    res.writeHead(503).end(JSON.stringify({ error: { message: 'high demand' } }))
  })
  const reserve = await fakeApi(async (req, res) => {
    await readBody(req)
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  const complete = completeWithFallback([
    { provider: 'custom', baseURL: primary.url, model: 'principal' },
    { provider: 'custom', baseURL: reserve.url, model: 'reserva' },
  ])
  const statuses = []

  const twoBlocks = `${'a'.repeat(4000)}\n${'b'.repeat(4000)}`
  assert.equal(await cleanTranscript(twoBlocks, complete, (status) => statuses.push(status)), 'ok\nok')

  assert.equal(primaryCalls, 1)
  assert.deepEqual(statuses, ['Revisando o texto 1/2 · principal', 'Revisando o texto 1/2 · reserva (reserva)', 'Revisando o texto 2/2 · reserva (reserva)'])
  primary.close()
  reserve.close()
})

test('when every service fails the error names each one', async () => {
  const down = await fakeApi((_req, res) => res.writeHead(503).end(JSON.stringify({ error: { message: 'high demand' } })))
  const badKey = await fakeApi((_req, res) => res.writeHead(401).end(JSON.stringify({ error: { message: 'invalid key' } })))
  const complete = completeWithFallback([
    { provider: 'custom', baseURL: down.url, model: 'principal' },
    { provider: 'custom', baseURL: badKey.url, model: 'reserva' },
  ])

  await assert.rejects(summarize('texto', complete), /principal: .*HTTP 503: high demand · reserva: .*HTTP 401: invalid key/)
  down.close()
  badKey.close()
})

test('the time limit setting becomes the request timeout, and Ilimitado sets none', () => {
  assert.equal(withRequestLimits({ timeoutSeconds: '30' }, true).timeoutMs, 30_000)
  assert.equal(withRequestLimits({ timeoutSeconds: '0' }, true).timeoutMs, undefined)
})

test('a service that does not answer in its time limit hands over to the reserve', async () => {
  const silent = await fakeApi(() => {})
  const slow = await fakeApi((_req, res) => setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: 'devagar' } }] })), 200))
  const complete = completeWithFallback([
    { provider: 'custom', baseURL: silent.url, model: 'principal', timeoutSeconds: '0.1' },
    { provider: 'custom', baseURL: slow.url, model: 'reserva', timeoutSeconds: '0' },
  ])

  assert.equal(await summarize('texto', complete), 'devagar')
  silent.closeAllConnections()
  silent.close()
  slow.close()
})

test('a long meeting is summarized in parts that are then joined', async () => {
  const requests = []
  const isNotes = (messages) => messages[0].content.includes('parte da transcrição')
  const server = await fakeApi(async (req, res) => {
    const { messages } = JSON.parse(await readBody(req))
    requests.push(messages)
    res.end(JSON.stringify({ choices: [{ message: { content: isNotes(messages) ? `notas ${requests.length}` : '## Resumo\nReunião longa.' } }] }))
  })
  const line = (i) => `[${formatTime(i * 10)}] ${'fala '.repeat(30)}`
  const transcript = Array.from({ length: 150 }, (_, i) => line(i)).join('\n')

  const summary = await summarize(transcript, completeWithFallback([{ provider: 'custom', baseURL: server.url, model: 'm' }]))

  assert.equal(summary, '## Resumo\nReunião longa.')
  assert.equal(requests.length, 3)
  assert.equal(requests.filter(isNotes).length, 2)
  assert.equal(requests[2][1].content, 'notas 1\n\nnotas 2')
  server.close()
})

function claudeMessage(content) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}

const hasLocalModel =fs.existsSync(path.join(MODELS_DIR, 'encoder.int8.onnx'))

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

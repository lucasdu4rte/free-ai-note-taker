import { LLM_PRESETS, TRANSCRIPTION_PRESETS, fromPreset } from './presets.js'

const { api } = window
const $ = (selector) => document.querySelector(selector)
const PRESETS = { transcription: TRANSCRIPTION_PRESETS, llm: LLM_PRESETS }
const FIELDS = ['provider', 'apiKey', 'model', 'baseURL', 'mode']
const form = $('#settings form')
const statuses = new Map()
let selectedId
let recording

const captureSystemAudio = api.platform === 'win32'
$('#record-hint').textContent = captureSystemAudio
  ? 'Grava o microfone e o som do computador (Teams, Meet, Zoom).'
  : 'Neste sistema, por enquanto, só o microfone é gravado.'

async function startRecording() {
  const context = new AudioContext({ sampleRate: 16000 })
  const streams = []
  try {
    await context.audioWorklet.addModule('recorder-worklet.js')
    streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }))
    if (captureSystemAudio) {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      screen.getVideoTracks().forEach((track) => track.stop())
      streams.push(screen)
    }
  } catch (error) {
    releaseAudio(context, streams)
    throw error
  }
  // channelCount 1 makes Web Audio mix the mic and the system audio down to one mono track.
  const recorder = new AudioWorkletNode(context, 'recorder', { channelCount: 1, channelCountMode: 'explicit' })
  for (const stream of streams) context.createMediaStreamSource(stream).connect(recorder)
  recorder.connect(context.destination)
  const id = await api.startRecording()
  recorder.port.onmessage = (event) => api.sendAudio(event.data)
  return { id, context, streams, startedAt: Date.now() }
}

function releaseAudio(context, streams) {
  streams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop())
  return context.close()
}

async function toggleRecording() {
  const button = $('#record')
  button.disabled = true
  try {
    if (!recording) {
      recording = await startRecording()
      recording.timer = setInterval(showElapsed, 1000)
      showElapsed()
      button.textContent = 'Parar e gerar resumo'
      button.classList.add('on')
      return
    }
    const { context, streams, timer } = recording
    recording = undefined
    clearInterval(timer)
    $('#timer').textContent = ''
    button.textContent = 'Gravar reunião'
    button.classList.remove('on')
    await releaseAudio(context, streams)
    const id = await api.stopRecording()
    await refreshList()
    await showMeeting(id)
    processMeeting(id)
  } catch (error) {
    alert(`Não foi possível gravar: ${error.message}`)
  } finally {
    button.disabled = false
  }
}

function showElapsed() {
  const seconds = Math.floor((Date.now() - recording.startedAt) / 1000)
  $('#timer').textContent = new Date(seconds * 1000).toISOString().slice(11, 19)
}

async function processMeeting(id) {
  setStatus(id, 'Processando…')
  try {
    await api.processMeeting(id)
    setStatus(id, '')
  } catch (error) {
    setStatus(id, `Erro: ${error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
  }
  if (id === selectedId) await showMeeting(id)
}

function setStatus(id, status) {
  statuses.set(id, status)
  if (id === selectedId) $('#meeting-status').textContent = status
  $('#process').disabled = isProcessing(selectedId)
}

const isProcessing = (id) => Boolean(statuses.get(id)) && !statuses.get(id).startsWith('Erro')

async function refreshList() {
  const ids = await api.listMeetings()
  if (!ids.length) return ($('#meetings').innerHTML = '<li class="muted">Nenhuma reunião gravada ainda.</li>')
  $('#meetings').replaceChildren(
    ...ids.map((id) => {
      const button = document.createElement('button')
      button.textContent = formatId(id)
      button.dataset.id = id
      button.onclick = () => showMeeting(id)
      const item = document.createElement('li')
      item.append(button)
      return item
    }),
  )
}

async function showMeeting(id) {
  selectedId = id
  const { summary, transcript } = await api.readMeeting(id)
  $('#meeting').hidden = false
  $('#meeting-title').textContent = formatId(id)
  $('#meeting-status').textContent = statuses.get(id) ?? ''
  $('#summary').textContent = summary ?? 'Ainda sem resumo. Clique em "Processar".'
  $('#transcript').textContent = transcript ?? 'Ainda sem transcrição.'
  $('#copy-summary').disabled = !summary
  $('#process').disabled = isProcessing(id)
  document.querySelectorAll('nav button').forEach((button) => button.setAttribute('aria-current', button.dataset.id === id))
}

function formatId(id) {
  const [date, time] = id.split(' ')
  return `${date.split('-').reverse().join('/')} ${time.slice(0, 5).replace('-', ':')}`
}

function writeSection(section, config) {
  for (const field of FIELDS) {
    const input = form.elements[`${section}.${field}`]
    if (input) input.value = config[field] ?? ''
  }
  const cloud = form.querySelector(`[data-section=${section}] .cloud`)
  if (cloud) cloud.hidden = config.provider === 'local'
}

function readSection(section) {
  return Object.fromEntries(FIELDS.map((field) => [field, form.elements[`${section}.${field}`]?.value.trim() ?? '']))
}

for (const [section, presets] of Object.entries(PRESETS)) {
  const select = form.elements[`${section}.provider`]
  select.append(...Object.entries(presets).map(([value, { label }]) => new Option(label, value)))
  select.onchange = () => writeSection(section, fromPreset(presets, select.value))
}

$('#open-settings').onclick = async () => {
  const settings = await api.getSettings()
  writeSection('transcription', settings.transcription)
  writeSection('llm', settings.llm)
  $('#settings').showModal()
}

$('#settings').onclose = () => {
  if ($('#settings').returnValue !== 'save') return
  api.saveSettings({ transcription: readSection('transcription'), llm: readSection('llm') })
}

$('#record').onclick = toggleRecording
$('#process').onclick = () => processMeeting(selectedId)
$('#open-folder').onclick = () => api.openMeeting(selectedId)
$('#copy-summary').onclick = async () => navigator.clipboard.writeText((await api.readMeeting(selectedId)).summary)
api.onStatus(setStatus)

await refreshList()

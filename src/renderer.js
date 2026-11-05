import { LLM_PRESETS, TRANSCRIPTION_PRESETS, fromPreset } from './presets.js'
import { parseSummary, parseTranscript } from './notes.js'

const { api } = window
const $ = (selector) => document.querySelector(selector)
const PRESETS = { transcription: TRANSCRIPTION_PRESETS, llm: LLM_PRESETS }
const FIELDS = ['provider', 'apiKey', 'model', 'baseURL', 'mode']
const SAVE_DELAY_MS = 400
const SAVED_BADGE_MS = 2500
const form = $('#settings-form')
const statuses = new Map()
let meetings = []
let selectedId
let summaryText
let tab = 'summary'
let recording
let toggling = false
let saveTimer
let saveStateTimer

const captureSystemAudio = api.platform === 'win32'

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children.filter((child) => child !== undefined))
  return node
}

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
  // The worklet sends audio chunks every 250 ms and, in between, a level number every 50 ms for the overlay.
  recorder.port.onmessage = ({ data }) => (typeof data === 'number' ? api.sendLevel(data) : api.sendAudio(data))
  return { id, context, streams }
}

function releaseAudio(context, streams) {
  streams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop())
  return context.close()
}

async function toggleRecording() {
  if (toggling) return
  toggling = true
  try {
    if (!recording) {
      recording = await startRecording()
      renderRecordState()
      return
    }
    const { context, streams } = recording
    recording = undefined
    renderRecordState()
    await releaseAudio(context, streams)
    const id = await api.stopRecording()
    showView('meetings')
    await refreshList()
    await showMeeting(id)
    processMeeting(id)
  } catch (error) {
    alert(`Não foi possível gravar: ${error.message}`)
  } finally {
    toggling = false
  }
}

async function processMeeting(id) {
  setStatus(id, 'Processando…')
  try {
    await api.processMeeting(id)
    setStatus(id, '')
  } catch (error) {
    setStatus(id, `Erro: ${errorText(error)}`)
  }
  await refreshList()
  if (id === selectedId) await showMeeting(id)
}

const errorText = (error) => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const isProcessing = (id) => Boolean(statuses.get(id)) && !statuses.get(id).startsWith('Erro')

function setStatus(id, status) {
  statuses.set(id, status)
  if (id === selectedId) renderMeetingStatus()
  renderRecordState()
  renderList()
}

function appState() {
  if (recording) return { label: 'Gravando', dot: 'rec' }
  if ([...statuses.keys()].some(isProcessing)) return { label: 'Processando', dot: 'busy' }
  return { label: 'Pronto', dot: 'ok' }
}

function renderRecordState() {
  const state = appState()
  $('#record').classList.toggle('on', Boolean(recording))
  $('#record-label').textContent = recording ? 'Parar' : 'Gravar'
  $('#state').textContent = state.label
  $('#state-dot').className = `dot ${state.dot}`
  $('#update-install').disabled = state.dot !== 'ok'
  $('#update-install').title = state.dot === 'ok' ? '' : 'Espere a gravação e o processamento terminarem'
}

function formatWhen(id) {
  const [date, time] = id.split(' ')
  const day = new Date(`${date}T00:00:00`)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  const hour = time.slice(0, 5).replace('-', ':')
  if (date === today.toLocaleDateString('sv')) return `Hoje, ${hour}`
  if (date === yesterday.toLocaleDateString('sv')) return `Ontem, ${hour}`
  return `${day.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}, ${hour}`
}

const titleOf = (meeting) => meeting.title || `Reunião de ${formatWhen(meeting.id)}`

function dotClass(meeting) {
  if (isProcessing(meeting.id)) return 'dot busy'
  return meeting.hasSummary ? 'dot ok' : 'dot warn'
}

function previewOf(meeting) {
  if (isProcessing(meeting.id)) return statuses.get(meeting.id)
  return meeting.preview || 'Sem resumo ainda'
}

const selectedMeeting = () => meetings.find((m) => m.id === selectedId)

async function refreshList() {
  meetings = await api.listMeetings()
  renderList()
}

function renderList() {
  const query = $('#search').value.trim().toLowerCase()
  const visible = meetings.filter((m) => `${titleOf(m)} ${m.preview}`.toLowerCase().includes(query))
  $('#count').textContent = meetings.length || ''
  $('#no-meeting').hidden = Boolean(selectedId)
  if (!visible.length) {
    $('#meetings').replaceChildren(el('p', { className: 'empty', textContent: query ? 'Nada encontrado.' : 'Nenhuma reunião ainda.' }))
    return
  }
  $('#meetings').replaceChildren(
    ...visible.map((meeting) => {
      const row = el(
        'button',
        { className: meeting.id === selectedId ? 'row on' : 'row', onclick: () => showMeeting(meeting.id) },
        el('span', { className: dotClass(meeting), ariaHidden: 'true' }),
        el(
          'span',
          { className: 'row-body' },
          el('span', { className: 'row-title', textContent: titleOf(meeting) }),
          el('span', { className: 'row-meta', textContent: `${formatWhen(meeting.id)} · ${meeting.minutes} min` }),
          el('span', { className: 'row-preview', textContent: previewOf(meeting) }),
        ),
      )
      if (meeting.id === selectedId) row.setAttribute('aria-current', 'true')
      return row
    }),
  )
}

async function showMeeting(id) {
  const meeting = meetings.find((m) => m.id === id)
  if (!meeting) return
  selectedId = id
  const { summary, transcript, audioUrl } = await api.readMeeting(id)
  summaryText = summary
  $('#meeting').hidden = false
  $('#title').textContent = titleOf(meeting)
  $('#meta').textContent = `${formatWhen(id)} · ${meeting.minutes} min`
  $('#copy').disabled = !summary
  renderMeetingStatus()
  renderPlayer(audioUrl)
  renderSummary(id, summary)
  renderTranscript(transcript)
  renderTab()
  renderList()
}

function renderPlayer(audioUrl) {
  const player = $('#player')
  player.hidden = !audioUrl
  if (!audioUrl) return player.removeAttribute('src')
  // Reassigning the same URL would restart the audio when the meeting view refreshes after processing.
  if (player.getAttribute('src') !== audioUrl) player.src = audioUrl
}

function renderMeetingStatus() {
  const status = statuses.get(selectedId) ?? ''
  $('#meeting-status').textContent = status
  $('#meeting-status').classList.toggle('error', status.startsWith('Erro'))
  $('#process').disabled = isProcessing(selectedId)
}

function renderSummary(id, markdown) {
  if (!markdown) {
    $('#panel-summary').replaceChildren(
      el(
        'div',
        { className: 'card no-summary' },
        el('p', { textContent: 'Ainda sem resumo. A transcrição bruta fica na aba Transcrição quando existir.' }),
        el('button', { className: 'btn', textContent: 'Processar', disabled: isProcessing(id), onclick: () => processMeeting(id) }),
      ),
    )
    return
  }
  const cards = parseSummary(markdown).sections.map((section) => {
    const card = el('section', { className: 'card' })
    if (section.heading) card.append(el('h2', { textContent: section.heading }))
    let list
    for (const item of section.items) {
      if (item.kind === 'task') {
        card.append(taskRow(id, item))
        continue
      }
      if (item.kind === 'bullet') {
        list ??= card.appendChild(el('ul'))
        list.append(el('li', { textContent: item.text }))
        continue
      }
      list = undefined
      card.append(el('p', { textContent: item.text }))
    }
    return card
  })
  $('#panel-summary').replaceChildren(...cards)
}

function taskRow(id, item) {
  const checkbox = el('input', { type: 'checkbox', checked: item.done })
  const row = el('label', { className: item.done ? 'task done' : 'task' }, checkbox, el('span', { textContent: item.text }))
  checkbox.onchange = async () => {
    row.classList.toggle('done', checkbox.checked)
    await api.toggleTask(id, item.index, checkbox.checked)
    summaryText = (await api.readMeeting(id)).summary
  }
  return row
}

function renderTranscript(transcript) {
  const lines = parseTranscript(transcript)
  if (!lines.length) {
    $('#panel-transcript').replaceChildren(el('p', { className: 'muted', textContent: 'Ainda sem transcrição.' }))
    return
  }
  $('#panel-transcript').replaceChildren(
    el('div', { className: 'card' }, ...lines.map((line) => el('p', { className: 'line' }, el('time', { textContent: line.time }), el('span', { textContent: line.text })))),
  )
}

function renderTab() {
  for (const [name, button, panel] of [
    ['summary', '#tab-summary', '#panel-summary'],
    ['transcript', '#tab-transcript', '#panel-transcript'],
  ]) {
    $(button).classList.toggle('on', tab === name)
    $(button).setAttribute('aria-selected', tab === name)
    $(panel).hidden = tab !== name
  }
}

function showView(view) {
  $('#view-meetings').hidden = view !== 'meetings'
  $('#view-settings').hidden = view !== 'settings'
  document.querySelectorAll('.nav').forEach((button) => button.classList.toggle('on', button.dataset.view === view))
}

function writeSection(section, config) {
  for (const field of FIELDS) form.elements[`${section}.${field}`].value = config[field] ?? ''
  form.querySelectorAll(`[data-section=${section}] .cloud`).forEach((row) => (row.hidden = config.provider === 'local'))
}

function readSection(section) {
  return Object.fromEntries(FIELDS.map((field) => [field, form.elements[`${section}.${field}`].value.trim()]))
}

const shortLabel = (section, provider) => PRESETS[section][provider]?.label.split(' (')[0] ?? provider

function renderProviderLabels(settings) {
  $('#asr-label').textContent = shortLabel('transcription', settings.transcription.provider)
  $('#llm-label').textContent = shortLabel('llm', settings.llm.provider)
}

for (const [section, presets] of Object.entries(PRESETS)) {
  form.elements[`${section}.provider`].append(...Object.entries(presets).map(([value, { label }]) => new Option(label, value)))
}

form.addEventListener('submit', (event) => event.preventDefault())
async function saveForm() {
  const settings = { transcription: readSection('transcription'), llm: readSection('llm') }
  try {
    await api.saveSettings(settings)
  } catch (error) {
    showSaveState(`Não foi possível salvar: ${error.message}`, true)
    return
  }
  renderProviderLabels(settings)
  showSaveState('Salvo')
}

function showSaveState(text, failed = false) {
  const badge = $('#save-state')
  badge.textContent = text
  badge.classList.toggle('error', failed)
  badge.hidden = false
  clearTimeout(saveStateTimer)
  if (!failed) saveStateTimer = setTimeout(() => (badge.hidden = true), SAVED_BADGE_MS)
}

const testButtons = [...document.querySelectorAll('[data-test]')]
const testHints = Object.fromEntries(testButtons.map(({ dataset }) => [dataset.test, $(`#test-${dataset.test}`).textContent]))

function showTestResult(section, text = testHints[section], state = '') {
  const result = $(`#test-${section}`)
  result.textContent = text
  result.className = state
}

async function testSection(button) {
  const section = button.dataset.test
  button.disabled = true
  showTestResult(section, 'Testando…')
  try {
    const reply = await api.testSettings(section, readSection(section))
    showTestResult(section, `✓ Funcionou: “${reply}”`, 'ok')
  } catch (error) {
    showTestResult(section, `✗ ${errorText(error)}`, 'error')
  }
  button.disabled = false
}

testButtons.forEach((button) => (button.onclick = () => testSection(button)))
api.onTestStatus((section, status) => showTestResult(section, status))

form.addEventListener('input', (event) => {
  const [section, field] = event.target.name.split('.')
  if (field === 'provider') writeSection(section, fromPreset(PRESETS[section], event.target.value))
  showTestResult(section)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveForm, SAVE_DELAY_MS)
})

$('#record').onclick = toggleRecording
document.querySelectorAll('.reveal').forEach((button) => {
  button.onclick = () => {
    const input = button.previousElementSibling
    const reveal = input.type === 'password'
    input.type = reveal ? 'text' : 'password'
    button.setAttribute('aria-pressed', reveal)
    const label = reveal ? 'Esconder chave' : 'Mostrar chave'
    button.ariaLabel = label
    button.title = label
  }
})
$('#update-install').onclick = () => api.installUpdate()
api.onUpdateReady((version) => {
  $('#update-version').textContent = version
  $('#update').hidden = false
})
document.querySelectorAll('.nav').forEach((button) => (button.onclick = () => showView(button.dataset.view)))
$('#search').oninput = renderList
const selectTab = (name) => () => {
  tab = name
  renderTab()
}
$('#tab-summary').onclick = selectTab('summary')
$('#tab-transcript').onclick = selectTab('transcript')
$('#process').onclick = () => processMeeting(selectedId)
$('#title').onkeydown = (event) => {
  if (event.key === 'Enter') event.preventDefault()
  if (event.key === 'Escape') $('#title').textContent = titleOf(selectedMeeting())
  if (event.key === 'Enter' || event.key === 'Escape') $('#title').blur()
}
$('#title').onblur = async () => {
  const name = $('#title').textContent.trim()
  if (name === titleOf(selectedMeeting())) return
  await api.renameMeeting(selectedId, name)
  await refreshList()
  $('#title').textContent = titleOf(selectedMeeting())
}
$('#open-folder').onclick = () => api.openMeeting(selectedId)
$('#copy').onclick = async () => {
  await navigator.clipboard.writeText(summaryText)
  $('#meeting-status').textContent = 'Resumo copiado'
  setTimeout(renderMeetingStatus, 1500)
}

api.onStatus(setStatus)
api.onToggleRecording(toggleRecording)
api.onShowSettings(() => showView('settings'))

const settings = await api.getSettings()
writeSection('transcription', settings.transcription)
writeSection('llm', settings.llm)
renderProviderLabels(settings)

const shortcut = await api.shortcut()
$('#shortcut').hidden = !shortcut
$('#shortcut').textContent = shortcut ?? ''
$('#shortcut-setting').textContent = shortcut ?? 'indisponível (outro app já usa)'
$('#app-version').textContent = await api.version()

await refreshList()
if (meetings.length) await showMeeting(meetings[0].id)

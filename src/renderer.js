import { LLM_PRESETS, TRANSCRIPTION_PRESETS, fromPreset, llmFromPreset } from './presets.js'
import { STEPS, acceleratorFromKey, parseSummary, parseTranscript, stepStates } from './notes.js'

const { api } = window
const $ = (selector) => document.querySelector(selector)
const PRESETS = { transcription: TRANSCRIPTION_PRESETS, llm: LLM_PRESETS }
const CONFIG_FROM_PRESET = { transcription: (provider) => fromPreset(TRANSCRIPTION_PRESETS, provider), llm: llmFromPreset }
const SAVE_DELAY_MS = 400
const SAVED_BADGE_MS = 2500
const STEP_LABELS = { transcribe: 'Transcrição', clean: 'Revisão do texto', summarize: 'Resumo' }
const STEP_VIEWS = {
  pending: { tone: '', text: () => 'Pendente', action: 'Processar' },
  running: { tone: 'busy', text: (run) => run.detail || 'Em andamento' },
  done: { tone: 'ok', text: () => 'Concluída' },
  error: { tone: 'error', text: (run) => run.error, action: 'Tentar de novo' },
}
const form = $('#settings-form')
const transcriptionGroup = $('[data-section=transcription]')
const llmGroups = () => [...$('#llm-groups').children]
// Per meeting: { step, detail } while it runs, { step, error } after it fails.
const runs = new Map()
let meetings = []
let doneSteps = []
let selectedId
let summaryText
let transcriptText
let tab = 'summary'
let recording
let toggling = false
let saveTimer
let saveStateTimer
let notice

const captureSystemAudio = api.platform === 'win32'
const SHORT_RECORDING_NOTICE_MS = 4000

async function withLoading(button, task) {
  button.disabled = true
  button.classList.add('loading')
  try {
    return await task()
  } finally {
    button.classList.remove('loading')
    button.disabled = false
  }
}

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
  $('#record').classList.add('loading')
  $('#record').disabled = true
  $('#record-label').textContent = recording ? 'Salvando…' : 'Iniciando…'
  try {
    if (recording) await stopRecording()
    else recording = await startRecording()
  } catch (error) {
    alert(`Não foi possível gravar: ${error.message}`)
  } finally {
    toggling = false
    $('#record').classList.remove('loading')
    $('#record').disabled = false
    renderRecordState()
  }
}

async function stopRecording() {
  const { context, streams } = recording
  recording = undefined
  await releaseAudio(context, streams)
  const id = await api.stopRecording()
  if (!id) return showNotice('Gravação com menos de 3 s descartada')
  showView('meetings')
  await refreshList()
  await showMeeting(id)
  processMeeting(id, 'transcribe')
}

function showNotice(text) {
  notice = text
  setTimeout(() => {
    notice = undefined
    renderRecordState()
  }, SHORT_RECORDING_NOTICE_MS)
}

async function processMeeting(id, from) {
  setRun(id, { step: from })
  try {
    await api.processMeeting(id, from)
    runs.delete(id)
  } catch (error) {
    runs.set(id, { step: runs.get(id).step, error: errorText(error) })
  }
  renderRecordState()
  await refreshList()
  if (id === selectedId) await showMeeting(id)
}

const errorText = (error) => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const isProcessing = (id) => runs.has(id) && !runs.get(id).error

function setRun(id, run) {
  runs.set(id, run)
  if (id === selectedId) renderSteps()
  renderRecordState()
  renderList()
}

function appState() {
  if (recording) return { label: 'Gravando', dot: 'rec' }
  if ([...runs.keys()].some(isProcessing)) return { label: 'Processando', dot: 'busy' }
  if (notice) return { label: notice, dot: 'warn' }
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
  const run = runs.get(meeting.id)
  if (isProcessing(meeting.id)) return run.detail || STEP_LABELS[run.step]
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
  const { summary, transcript, audioUrl, done } = await api.readMeeting(id)
  summaryText = summary
  transcriptText = transcript
  doneSteps = done
  $('#meeting').hidden = false
  $('#title').textContent = titleOf(meeting)
  $('#meta').textContent = `${formatWhen(id)} · ${meeting.minutes} min`
  renderSteps()
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

function renderSteps() {
  const run = runs.get(selectedId)
  const states = stepStates(doneSteps, run)
  const firstUndone = states.findIndex((state) => state !== 'done')
  const idle = !isProcessing(selectedId)
  $('#steps').hidden = firstUndone === -1
  $('#steps').replaceChildren(...STEPS.map((step, i) => stepRow(selectedId, step, states[i], run, idle && i === firstUndone)))
  $('#process').disabled = !idle || !doneSteps.includes('transcribe')
  $('#process').classList.toggle('loading', !idle)
  $('#delete').disabled = !idle
}

function stepRow(id, step, state, run, withAction) {
  const view = STEP_VIEWS[state]
  const detail = el('small', { className: view.tone, textContent: view.text(run) })
  if (state === 'error') detail.role = 'alert'
  const action = withAction ? el('button', { type: 'button', className: 'test-btn', textContent: view.action, onclick: () => processMeeting(id, step) }) : undefined
  return el('li', { className: 'setting' }, el('span', {}, STEP_LABELS[step], detail), action)
}

function renderSummary(id, markdown) {
  if (!markdown) {
    $('#panel-summary').replaceChildren(
      el(
        'div',
        { className: 'card no-summary' },
        el('p', { textContent: 'Ainda sem resumo. A transcrição bruta fica na aba Transcrição quando existir.' }),
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

const copyLabel = () => (tab === 'summary' ? 'Copiar resumo' : 'Copiar transcrição')

function renderTab() {
  for (const [name, button, panel] of [
    ['summary', '#tab-summary', '#panel-summary'],
    ['transcript', '#tab-transcript', '#panel-transcript'],
  ]) {
    $(button).classList.toggle('on', tab === name)
    $(button).setAttribute('aria-selected', tab === name)
    $(panel).hidden = tab !== name
  }
  $('#copy').ariaLabel = copyLabel()
  $('#copy').title = copyLabel()
  $('#copy').disabled = !(tab === 'summary' ? summaryText : transcriptText)
}

function showView(view) {
  $('#view-meetings').hidden = view !== 'meetings'
  $('#view-settings').hidden = view !== 'settings'
  document.querySelectorAll('.nav').forEach((button) => button.classList.toggle('on', button.dataset.view === view))
}

function writeConfig(group, config) {
  for (const input of group.querySelectorAll('[name]')) input.value = config[input.name] ?? ''
  group.querySelectorAll('.cloud').forEach((row) => (row.hidden = config.provider === 'local'))
}

function readConfig(group) {
  return Object.fromEntries([...group.querySelectorAll('[name]')].map((input) => [input.name, input.value.trim()]))
}

const providerOptions = (presets) => Object.entries(presets).map(([value, { label }]) => new Option(label, value))

function renderLlmGroups(configs) {
  $('#llm-groups').replaceChildren(...configs.map(llmGroup))
}

function llmGroup(config, index) {
  const group = $('#llm-template').content.firstElementChild.cloneNode(true)
  nameLlmGroup(group, index)
  group.querySelector('[data-action=remove]').hidden = !index
  group.querySelector('[name=provider]').append(...providerOptions(LLM_PRESETS))
  writeConfig(group, config)
  return group
}

function nameLlmGroup(group, index) {
  const title = index ? `Reserva ${index}` : 'Principal'
  group.ariaLabel = title
  group.querySelector('.llm-title').textContent = title
  const removeButton = group.querySelector('[data-action=remove]')
  removeButton.ariaLabel = `Remover ${title.toLowerCase()}`
  removeButton.title = removeButton.ariaLabel
}

const shortLabel = (section, provider) => PRESETS[section][provider]?.label.split(' (')[0] ?? provider

function renderProviderLabels(settings) {
  $('#asr-label').textContent = shortLabel('transcription', settings.transcription.provider)
  $('#llm-label').textContent = shortLabel('llm', settings.llm.provider)
}

transcriptionGroup.querySelector('[name=provider]').append(...providerOptions(TRANSCRIPTION_PRESETS))

form.addEventListener('submit', (event) => event.preventDefault())
async function saveForm() {
  const [llm, ...llmFallbacks] = llmGroups().map(readConfig)
  const settings = { transcription: readConfig(transcriptionGroup), llm, llmFallbacks }
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

function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveForm, SAVE_DELAY_MS)
}

function showTestResult(group, text, state = '') {
  const result = group.querySelector('.test-result')
  result.dataset.hint ??= result.textContent
  result.textContent = text ?? result.dataset.hint
  result.className = `test-result ${state}`
}

// shortcut: Cancelar only stops waiting; the request finishes in the background (at most 30 s for the AI), which is harmless.
async function testGroup(group, button) {
  const run = (group.testRun = (group.testRun ?? 0) + 1)
  const finish = (text, state) => {
    if (group.testRun !== run) return
    group.testRun++
    button.classList.remove('loading')
    button.textContent = 'Testar'
    showTestResult(group, text, state)
  }
  if (button.classList.contains('loading')) return finish('Teste cancelado')
  button.classList.add('loading')
  button.textContent = 'Cancelar'
  showTestResult(group, 'Testando…')
  try {
    const reply = await api.testSettings(group.dataset.section, readConfig(group))
    finish(`✓ Funcionou: “${reply}”`, 'ok')
  } catch (error) {
    finish(`✗ ${errorText(error)}`, 'error')
  }
}

function toggleSecret(_group, button) {
  const input = button.previousElementSibling
  const reveal = input.type === 'password'
  input.type = reveal ? 'text' : 'password'
  button.setAttribute('aria-pressed', reveal)
  const label = reveal ? 'Esconder chave' : 'Mostrar chave'
  button.ariaLabel = label
  button.title = label
}

// The LLM cards are cloned from a template, so their buttons are handled by one listener on the form.
const GROUP_ACTIONS = {
  test: testGroup,
  reveal: toggleSecret,
  remove: (group) => {
    group.remove()
    llmGroups().forEach(nameLlmGroup)
    saveSoon()
  },
}

form.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]')
  if (!button) return
  GROUP_ACTIONS[button.dataset.action](button.closest('[data-section]'), button)
})
api.onTestStatus((section, status) => {
  const group = $(`[data-section=${section}]`)
  if (group.querySelector('[data-action=test]').classList.contains('loading')) showTestResult(group, status)
})

form.addEventListener('input', (event) => {
  const group = event.target.closest('[data-section]')
  if (!group) return
  if (event.target.name === 'provider') writeConfig(group, CONFIG_FROM_PRESET[group.dataset.section](event.target.value))
  showTestResult(group)
  saveSoon()
})

$('#add-llm').onclick = () => {
  $('#llm-groups').append(llmGroup(llmFromPreset('groq'), llmGroups().length))
  saveSoon()
}
$('#record').onclick = toggleRecording
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
$('#process').onclick = () => processMeeting(selectedId, 'clean')
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
  await navigator.clipboard.writeText(tab === 'summary' ? summaryText : transcriptText)
  $('#meeting-status').textContent = tab === 'summary' ? 'Resumo copiado' : 'Transcrição copiada'
  setTimeout(() => ($('#meeting-status').textContent = ''), 1500)
}
$('#delete').onclick = () =>
  withLoading($('#delete'), async () => {
    if (!confirm(`Excluir "${titleOf(selectedMeeting())}"? A pasta vai para a lixeira.`)) return
    await api.deleteMeeting(selectedId)
    runs.delete(selectedId)
    selectedId = undefined
    $('#meeting').hidden = true
    await refreshList()
    if (meetings.length) await showMeeting(meetings[0].id)
  })
$('#check-update').onclick = () =>
  withLoading($('#check-update'), async () => {
    const result = $('#update-result')
    result.className = 'busy'
    result.textContent = 'Procurando…'
    try {
      const { latest, available } = await api.checkForUpdate()
      result.textContent = available ? `↓ Baixando a versão ${latest}. Ela entra quando você fechar o app.` : `✓ Você já está na versão mais nova (${latest}).`
      result.className = 'ok'
    } catch (error) {
      result.textContent = `✗ ${errorText(error)}`
      result.className = 'error'
    }
  })
$('#theme').onchange = () => api.setTheme($('#theme').value)

api.onMeetingProgress((id, step, detail) => setRun(id, { step, detail }))
api.onToggleRecording(toggleRecording)
api.onShowSettings(() => showView('settings'))

const settings = await api.getSettings()
writeConfig(transcriptionGroup, settings.transcription)
renderLlmGroups([settings.llm, ...settings.llmFallbacks])
renderProviderLabels(settings)

function renderShortcut(label, hint = 'Funciona com qualquer janela em foco') {
  $('#shortcut').hidden = !label
  $('#shortcut').textContent = label ?? ''
  $('#shortcut-setting').textContent = label ?? 'indisponível (outro app já usa)'
  $('#shortcut-hint').textContent = hint
}

function nextShortcut() {
  return new Promise((resolve) => {
    const onKey = (event) => {
      event.preventDefault()
      const cancelled = event.key === 'Escape'
      const accelerator = acceleratorFromKey(event)
      if (!cancelled && !accelerator) return
      window.removeEventListener('keydown', onKey, true)
      resolve(cancelled ? null : accelerator)
    }
    window.addEventListener('keydown', onKey, true)
  })
}

async function changeShortcut() {
  const button = $('#change-shortcut')
  await api.pauseShortcut()
  button.textContent = 'Pressione o atalho…'
  const accelerator = await nextShortcut()
  button.textContent = 'Alterar'
  const { label, taken } = await api.setShortcut(accelerator)
  renderShortcut(label, taken ? 'Essa combinação já é usada por outro app. Tente outra.' : undefined)
}

$('#change-shortcut').onclick = changeShortcut
renderShortcut(await api.shortcut())
$('#app-version').textContent = await api.version()
$('#theme').value = await api.theme()

await refreshList()
if (meetings.length) await showMeeting(meetings[0].id)

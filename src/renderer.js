import { LLM_PRESETS, TRANSCRIPTION_PRESETS, fromPreset, llmFromPreset } from './presets.js'
import { STEPS, acceleratorFromKey, downloadProgressText, downloadSize, parseSummary, parseTranscript, stepStates } from './notes.js'

const { api } = window
const $ = (selector) => document.querySelector(selector)
const PRESETS = { transcription: TRANSCRIPTION_PRESETS, llm: LLM_PRESETS }
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
let starting
let pendingStart
let toggling = false
let saveTimer
let saveStateTimer
let notice
let llmProfiles = {}
let comboCount = 0
const combos = new WeakMap()

const captureSystemAudio = api.platform === 'win32'
const SHORT_RECORDING_NOTICE_MS = 4000
const DEVICE_SETTLE_MS = 800
const MIC_STORAGE_KEY = 'micDeviceId'

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

class StartCancelled extends Error {}

async function startRecording(attempt) {
  // Opening the audio device blocks this thread, so let the "Iniciando" state paint first.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)))
  const throwIfCancelled = () => {
    if (attempt.cancelled) throw new StartCancelled()
  }
  const context = new AudioContext({ sampleRate: 16000 })
  const streams = []
  try {
    await context.audioWorklet.addModule('recorder-worklet.js')
    throwIfCancelled()
    streams.push(...(await captureAudio()))
    throwIfCancelled()
  } catch (error) {
    releaseAudio(context, streams)
    throw error
  }
  // channelCount 1 makes Web Audio mix the mic and the system audio down to one mono track.
  const recorder = new AudioWorkletNode(context, 'recorder', { channelCount: 1, channelCountMode: 'explicit' })
  const sources = connectSources(context, streams, recorder)
  recorder.connect(context.destination)
  const id = await api.startRecording()
  if (attempt.cancelled) {
    await releaseAudio(context, streams)
    // No audio reached the file yet, so the main process discards this meeting as too short.
    await api.stopRecording()
    throw new StartCancelled()
  }
  // The worklet sends audio chunks every 250 ms and, in between, a level number every 50 ms for the overlay.
  recorder.port.onmessage = ({ data }) => (typeof data === 'number' ? api.sendLevel(data) : api.sendAudio(data))
  return { id, context, streams, sources, recorder, micMuted: false }
}

// The mic comes first: muting disables streams[0].
async function captureAudio() {
  const micId = chosenMic()
  // ideal, not exact: an unplugged mic falls back to the system default instead of failing the recording.
  const mic = { deviceId: micId ? { ideal: micId } : undefined, echoCancellation: true, noiseSuppression: true }
  const streams = [await navigator.mediaDevices.getUserMedia({ audio: mic })]
  if (!captureSystemAudio) return streams
  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    screen.getVideoTracks().forEach((track) => track.stop())
    streams.push(screen)
    return streams
  } catch (error) {
    streams[0].getTracks().forEach((track) => track.stop())
    throw error
  }
}

function connectSources(context, streams, recorder) {
  return streams.map((stream) => {
    const source = context.createMediaStreamSource(stream)
    source.connect(recorder)
    return source
  })
}

const applyMicMute = ({ streams, micMuted }) => streams[0].getAudioTracks().forEach((track) => (track.enabled = !micMuted))

// A capture stays tied to the devices that were default when it opened, so plugging or unplugging a headset
// left the recording silent. Reopening on the new defaults keeps the same file and recorder going.
async function followDefaultAudioDevices() {
  const current = recording
  if (!current) return
  let streams
  try {
    streams = await captureAudio()
  } catch (error) {
    console.error('Could not switch the audio devices:', error)
    return
  }
  if (recording !== current) {
    streams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop())
    return
  }
  current.sources.forEach((source) => source.disconnect())
  current.streams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop())
  current.streams = streams
  current.sources = connectSources(current.context, streams, current.recorder)
  applyMicMute(current)
}

function releaseAudio(context, streams) {
  streams.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop())
  return context.close()
}

async function toggleRecording() {
  if (starting) return cancelStarting()
  if (toggling) return
  if (!recording) return startWithFeedback()
  toggling = true
  $('#record').classList.add('loading')
  $('#record').disabled = true
  $('#record-label').textContent = 'Salvando…'
  try {
    await stopRecording()
  } catch (error) {
    alert(`Não foi possível salvar a gravação: ${error.message}`)
  } finally {
    toggling = false
    $('#record').classList.remove('loading')
    $('#record').disabled = false
    renderRecordState()
  }
}

async function startWithFeedback() {
  const attempt = { cancelled: false }
  starting = attempt
  renderRecordState()
  try {
    // A cancelled start may still be talking to the main process; a new one must not overlap it.
    await pendingStart?.catch(() => {})
    if (attempt.cancelled) return
    pendingStart = startRecording(attempt)
    recording = await pendingStart
  } catch (error) {
    if (!(error instanceof StartCancelled)) alert(`Não foi possível gravar: ${error.message}`)
  } finally {
    if (starting === attempt) starting = undefined
    renderRecordState()
  }
}

function cancelStarting() {
  starting.cancelled = true
  starting = undefined
  renderRecordState()
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
  if (starting) return { label: 'Iniciando a gravação…', dot: 'busy' }
  if (recording) return { label: 'Gravando', dot: 'rec' }
  if ([...runs.keys()].some(isProcessing)) return { label: 'Processando', dot: 'busy' }
  if (notice) return { label: notice, dot: 'warn' }
  return { label: 'Pronto', dot: 'ok' }
}

function renderRecordState() {
  const state = appState()
  $('#record').classList.toggle('on', Boolean(recording))
  $('#record').classList.toggle('loading', Boolean(starting) || toggling)
  $('#record').title = starting ? 'Clique para cancelar' : ''
  $('#record-label').textContent = recordLabel()
  $('#state').textContent = state.label
  $('#state-dot').className = `dot ${state.dot}`
  $('#update-install').disabled = state.dot !== 'ok'
  $('#update-install').title = state.dot === 'ok' ? '' : 'Espere a gravação e o processamento terminarem'
}

function recordLabel() {
  if (starting) return 'Cancelar'
  if (recording) return 'Parar'
  return 'Gravar'
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
        {
          className: meeting.id === selectedId ? 'row on' : 'row',
          onclick: () => showMeeting(meeting.id),
          oncontextmenu: () => api.meetingMenu(meeting.id, !isProcessing(meeting.id)),
        },
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
  group.querySelectorAll('select').forEach(syncCombobox)
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
  const select = group.querySelector('[name=provider]')
  select.append(...providerOptions(LLM_PRESETS))
  upgradeSelects(group)
  writeLlmConfig(group, config)
  return group
}

function writeLlmConfig(group, config) {
  writeConfig(group, config)
  group.dataset.provider = config.provider
  renderConfiguredProviders(group)
  loadOllamaModels(group)
}

function switchLlmProvider(group, provider) {
  llmProfiles[group.dataset.provider] = { ...readConfig(group), provider: group.dataset.provider }
  writeLlmConfig(group, llmProfiles[provider] ?? llmFromPreset(provider))
}

const isConfigured = (config) => Boolean(config?.apiKey) || (config?.provider === 'ollama' && Boolean(config.model))

function renderConfiguredProviders(group) {
  const select = group.querySelector('[name=provider]')
  for (const option of select.options) option.dataset.configured = isConfigured(llmProfiles[option.value])
  syncCombobox(select)
}

const comboboxOf = (select) => combos.get(select)
const syncCombobox = (select) => comboboxOf(select)?.render()
const SEARCH_FROM_OPTIONS = 6
const fieldLabel = (select) => select.getAttribute('aria-label') ?? select.closest('.setting')?.querySelector('span')?.firstChild?.textContent.trim() ?? ''

function upgradeSelects(root) {
  for (const select of root.querySelectorAll('select')) {
    if (combos.has(select)) continue
    select.hidden = true
    select.before(combobox(select))
  }
}

const CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path></svg>'

const configuredBadge = (option) => (option.dataset.configured === 'true' ? el('span', { className: 'combo-badge', textContent: 'configurado' }) : undefined)

// Stands in for a hidden <select>, which keeps the value: picking an option sets it and fires the same input and change events.
// Lists long enough to scan get a search field; short ones take the keys on the list itself.
function combobox(select) {
  const label = fieldLabel(select)
  const listId = `combo-${++comboCount}`
  const trigger = el('button', { type: 'button', className: 'combo-trigger' })
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  const search = el('input', { className: 'combo-search', placeholder: 'Buscar…', autocomplete: 'off', spellcheck: false })
  search.setAttribute('role', 'combobox')
  search.setAttribute('aria-label', `Buscar ${label.toLowerCase()}`)
  search.setAttribute('aria-controls', listId)
  search.setAttribute('aria-expanded', 'true')
  search.setAttribute('aria-autocomplete', 'list')
  const list = el('ul', { id: listId, className: 'combo-list', role: 'listbox', tabIndex: -1 })
  list.setAttribute('aria-label', label)
  const popup = el('div', { className: 'combo-popup', hidden: true }, search, list)
  const combo = el('div', { className: 'combo' }, trigger, popup)
  let active = 0

  const searchable = () => select.options.length >= SEARCH_FROM_OPTIONS
  const keyTarget = () => (searchable() ? search : list)
  const matches = () => [...select.options].filter((option) => option.text.toLowerCase().includes(search.value.trim().toLowerCase()))
  const optionId = (option) => `${listId}-${[...select.options].indexOf(option)}`

  function renderTrigger() {
    const option = select.selectedOptions[0]
    if (!option) return
    const badge = configuredBadge(option)
    trigger.replaceChildren(...[el('span', { className: 'combo-name', textContent: option.text }), badge].filter(Boolean))
    trigger.insertAdjacentHTML('beforeend', CHEVRON)
    trigger.lastElementChild.classList.add('combo-chevron')
    trigger.setAttribute('aria-label', `${label}: ${option.text}${badge ? ', configurado' : ''}`)
  }

  function renderList() {
    const options = matches()
    active = Math.max(0, Math.min(active, options.length - 1))
    list.replaceChildren(
      ...options.map((option, index) => {
        const item = el(
          'li',
          { id: optionId(option), className: index === active ? 'combo-option active' : 'combo-option', role: 'option' },
          el('span', { className: 'combo-check', textContent: '✓', ariaHidden: 'true' }),
          el('span', { className: 'combo-name', textContent: option.text }),
          configuredBadge(option),
        )
        item.setAttribute('aria-selected', String(option.value === select.value))
        item.onmousedown = (event) => event.preventDefault()
        item.onmousemove = () => {
          if (active === index) return
          active = index
          renderList()
        }
        item.onclick = () => choose(option.value)
        return item
      }),
    )
    if (!options.length) list.append(el('li', { className: 'combo-empty', textContent: 'Nada encontrado' }))
    keyTarget().setAttribute('aria-activedescendant', options[active] ? optionId(options[active]) : '')
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }

  function open() {
    popup.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    search.value = ''
    search.hidden = !searchable()
    active = [...select.options].findIndex((option) => option.value === select.value)
    renderList()
    keyTarget().focus()
  }

  function close({ focusTrigger = true } = {}) {
    if (popup.hidden) return
    popup.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    if (focusTrigger) trigger.focus()
  }

  function choose(value) {
    close()
    if (value === select.value) return
    select.value = value
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
    renderTrigger()
  }

  const moveActive = (step) => {
    active += step
    renderList()
  }
  const SEARCH_KEYS = {
    ArrowDown: () => moveActive(1),
    ArrowUp: () => moveActive(-1),
    Home: () => moveActive(-active),
    End: () => moveActive(Infinity),
    Enter: () => matches()[active] && choose(matches()[active].value),
    Escape: () => close(),
  }

  trigger.onclick = () => (popup.hidden ? open() : close())
  trigger.onkeydown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    open()
  }
  search.oninput = (event) => {
    event.stopPropagation()
    active = 0
    renderList()
  }
  const onListKey = (event) => {
    if (event.key === 'Tab') return close({ focusTrigger: false })
    if (!SEARCH_KEYS[event.key]) return
    event.preventDefault()
    SEARCH_KEYS[event.key]()
  }
  search.onkeydown = onListKey
  list.onkeydown = onListKey
  combo.addEventListener('focusout', (event) => {
    if (!combo.contains(event.relatedTarget)) close({ focusTrigger: false })
  })

  combos.set(select, { element: combo, render: renderTrigger })
  renderTrigger()
  return combo
}

async function loadOllamaModels(group) {
  const hint = group.querySelector('.model-hint')
  const picker = group.querySelector('.model-picker')
  const input = group.querySelector('[name=model]')
  const { provider, baseURL } = readConfig(group)
  hint.hidden = provider !== 'ollama'
  comboboxOf(picker).element.hidden = true
  input.hidden = false
  if (provider !== 'ollama') return
  hint.textContent = 'Procurando os modelos do Ollama…'
  let names
  try {
    names = await api.listModels(baseURL)
  } catch {
    names = undefined
  }
  const current = readConfig(group)
  if (current.provider !== 'ollama' || current.baseURL !== baseURL) return
  if (!names) {
    hint.textContent = `O Ollama não respondeu em ${baseURL}`
    return
  }
  if (!names.length) {
    hint.textContent = 'Nenhum modelo instalado no Ollama (rode "ollama pull")'
    return
  }
  hint.textContent = names.length === 1 ? '1 modelo instalado no Ollama' : `${names.length} modelos instalados no Ollama`
  picker.replaceChildren(...names.map((name) => new Option(name)))
  comboboxOf(picker).element.hidden = false
  input.hidden = true
  if (names.includes(current.model)) picker.value = current.model
  else input.value = names[0]
  syncCombobox(picker)
  if (!names.includes(current.model)) saveSoon()
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
upgradeSelects(form)

form.addEventListener('submit', (event) => event.preventDefault())
async function saveForm() {
  const [llm, ...llmFallbacks] = llmGroups().map(readConfig)
  for (const config of [llm, ...llmFallbacks]) llmProfiles[config.provider] = config
  const settings = { transcription: readConfig(transcriptionGroup), llm, llmFallbacks, llmProfiles }
  try {
    await api.saveSettings(settings)
  } catch (error) {
    showSaveState(`Não foi possível salvar: ${error.message}`, true)
    return
  }
  renderProviderLabels(settings)
  llmGroups().forEach(renderConfiguredProviders)
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
  if (event.target.name === 'provider' && group.dataset.section === 'llm') switchLlmProvider(group, event.target.value)
  else if (event.target.name === 'provider') writeConfig(group, fromPreset(TRANSCRIPTION_PRESETS, event.target.value))
  showTestResult(group)
  saveSoon()
})

form.addEventListener('change', (event) => {
  if (event.target.classList.contains('model-picker')) {
    event.target.closest('[data-section]').querySelector('[name=model]').value = event.target.value
    saveSoon()
    return
  }
  if (event.target.name === 'baseURL' && event.target.closest('[data-section=llm]')) loadOllamaModels(event.target.closest('[data-section=llm]'))
})

$('#add-llm').onclick = () => {
  $('#llm-groups').append(llmGroup(llmFromPreset('groq'), llmGroups().length))
  saveSoon()
}
$('#record').onclick = toggleRecording
$('#update-install').onclick = () => api.installUpdate()

let availableUpdate

function showUpdateAvailable(update, note = '') {
  availableUpdate = update
  const size = update.bytes ? downloadSize(update.bytes) : ''
  $('#update-result').textContent = note || `↓ A versão ${update.version} está disponível${size ? ` (${size})` : ''}. Baixe quando quiser.`
  $('#update-result').className = note ? '' : 'ok'
  $('#update-download').textContent = size ? `Baixar ${size}` : 'Baixar'
  $('#update-download').hidden = false
  $('#check-update').hidden = true
  $('#update-progress-row').hidden = true
  document.querySelector('.nav[data-view=settings]').classList.add('has-update')
}

function renderUpdateProgress(progress) {
  $('#update-progress').max = progress.total || 1
  $('#update-progress').value = progress.transferred
  $('#update-progress-text').textContent = downloadProgressText(progress)
}

api.onUpdateAvailable((update) => showUpdateAvailable(update))
api.onUpdateProgress(renderUpdateProgress)
$('#update-cancel').onclick = () => api.cancelUpdate()
$('#update-download').onclick = async () => {
  $('#update-download').hidden = true
  $('#update-progress-row').hidden = false
  $('#update-progress-version').textContent = availableUpdate.version
  renderUpdateProgress({ transferred: 0, total: availableUpdate.bytes, bytesPerSecond: 0 })
  try {
    const { cancelled } = await api.downloadUpdate()
    if (cancelled) showUpdateAvailable(availableUpdate, 'Download cancelado. Nada foi instalado; baixe de novo quando quiser.')
  } catch (error) {
    showUpdateAvailable(availableUpdate, `✗ O download falhou: ${errorText(error)}`)
  }
}
api.onUpdateReady((version) => {
  $('#update-result').textContent = `↓ A versão ${version} foi baixada e entra quando você fechar o app.`
  $('#update-result').className = 'ok'
  $('#check-update').hidden = true
  $('#update-download').hidden = true
  $('#update-progress-row').hidden = true
  $('#update-install').hidden = false
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
api.onMeetingMenuAction(async (id, action) => {
  await showMeeting(id)
  if (action === 'delete') return $('#delete').click()
  $('#title').focus()
  getSelection().selectAllChildren($('#title'))
})
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
      const { latest, available, bytes } = await api.checkForUpdate()
      if (available) return showUpdateAvailable({ version: latest, bytes })
      result.textContent = `✓ Você já está na versão mais nova (${latest}).`
      result.className = 'ok'
    } catch (error) {
      result.textContent = `✗ ${errorText(error)}`
      result.className = 'error'
    }
  })
$('#theme').onchange = () => api.setTheme($('#theme').value)
$('#mic-device').onchange = () => {
  try {
    localStorage.setItem(MIC_STORAGE_KEY, $('#mic-device').value)
  } catch (error) {
    console.error('Could not remember the microphone:', error)
  }
}
$('#open-sound-settings').onclick = () => api.openSoundSettings()
$('#output-row').hidden = !captureSystemAudio
const renderOverlayOpacity = (percent) => ($('#overlay-opacity-value').textContent = `${percent}%`)
$('#overlay-opacity').oninput = (event) => {
  event.stopPropagation()
  const percent = Number($('#overlay-opacity').value)
  renderOverlayOpacity(percent)
  api.setOverlayOpacity(percent)
}

function mcpStatusLine({ running, error, port }) {
  if (error === 'port-taken') return [`✗ A porta ${port} já está em uso. Escolha outra.`, 'error']
  if (error) return [`✗ ${error}`, 'error']
  if (running) return [`✓ Ligado na porta ${port}. Só este computador acessa.`, 'ok']
  return ['Desligado. Nenhum app de IA vê suas reuniões.', '']
}

function renderMcp(status) {
  $('#mcp-enabled').checked = status.enabled
  $('#mcp-port').value = status.port
  $('#mcp-url').textContent = status.url
  $('#mcp-http-command').textContent = status.httpCommand
  $('#mcp-wsl-command').textContent = status.wslCommand ?? ''
  $('#mcp-wsl-row').hidden = !status.wslCommand
  document.querySelectorAll('.mcp-option').forEach((option) => (option.hidden = !status.enabled))
  const [text, tone] = mcpStatusLine(status)
  $('#mcp-result').textContent = text
  $('#mcp-result').className = tone
}

async function saveMcp() {
  try {
    renderMcp(await api.setMcp($('#mcp-enabled').checked, Number($('#mcp-port').value)))
  } catch (error) {
    $('#mcp-result').textContent = `✗ ${errorText(error)}`
    $('#mcp-result').className = 'error'
  }
}

$('#mcp-enabled').onchange = saveMcp
$('#mcp-port').onchange = saveMcp
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.onclick = async () => {
    await navigator.clipboard.writeText($(`#${button.dataset.copy}`).textContent)
    button.textContent = 'Copiado'
    setTimeout(() => (button.textContent = 'Copiar'), 1500)
  }
})

api.onMeetingProgress((id, step, detail) => setRun(id, { step, detail }))
api.onToggleRecording(toggleRecording)
// Only the mic track is disabled, so the PC audio keeps being recorded while the mic is muted.
api.onMicMuted((muted) => {
  if (!recording) return
  recording.micMuted = muted
  applyMicMute(recording)
})
let deviceChangeTimer
// Plugging a headset fires several devicechange events in a row; react once they settle.
navigator.mediaDevices.ondevicechange = () => {
  clearTimeout(deviceChangeTimer)
  deviceChangeTimer = setTimeout(() => {
    refreshAudioDevices()
    followDefaultAudioDevices()
  }, DEVICE_SETTLE_MS)
}

function chosenMic() {
  try {
    return localStorage.getItem(MIC_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

let knownDevices
const isDeviceAlias = (device) => device.deviceId === 'default' || device.deviceId === 'communications'
const deviceName = (device) => device?.label.replace(/^(Padrão|Default|Comunicações|Communications) - /, '') || 'outro aparelho'
const defaultDevice = (devices, kind) => devices.find((device) => device.kind === kind && device.deviceId === 'default')

async function refreshAudioDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind !== 'videoinput')
  renderMicOptions(devices)
  $('#output-hint').textContent = `Gravado da saída padrão do Windows, agora: ${deviceName(defaultDevice(devices, 'audiooutput'))}`
  if (knownDevices) warnAboutNewAudioDevice(devices)
  knownDevices = devices
}

function renderMicOptions(devices) {
  const mics = devices.filter((device) => device.kind === 'audioinput' && !isDeviceAlias(device))
  const select = $('#mic-device')
  const chosen = chosenMic()
  const missing = Boolean(chosen) && !mics.some((device) => device.deviceId === chosen)
  select.replaceChildren(new Option('Padrão do sistema', ''), ...mics.map((device, index) => new Option(device.label || `Microfone ${index + 1}`, device.deviceId)))
  select.value = missing ? '' : chosen
  $('#mic-hint').textContent = missing ? 'O microfone escolhido não está conectado. Usando o padrão do sistema.' : 'Escolha o mesmo microfone que você usa na reunião'
  syncCombobox(select)
}

// A headset only helps if it is what the app records from: the chosen (or default) mic and, on Windows, the default output.
function warnAboutNewAudioDevice(devices) {
  const known = new Set(knownDevices.map((device) => `${device.kind}:${device.deviceId}`))
  const added = devices.filter((device) => !isDeviceAlias(device) && !known.has(`${device.kind}:${device.deviceId}`))
  const output = added.find((device) => device.kind === 'audiooutput')
  const mic = added.find((device) => device.kind === 'audioinput')
  if (!output && !mic) return
  const recordedMic = devices.find((device) => device.kind === 'audioinput' && device.deviceId === chosenMic()) ?? defaultDevice(devices, 'audioinput')
  const recordedOutput = defaultDevice(devices, 'audiooutput')
  const problems = []
  if (captureSystemAudio && output && recordedOutput?.groupId !== output.groupId) problems.push(`O som da reunião continua sendo gravado de ${deviceName(recordedOutput)}: deixe o fone como saída padrão do Windows.`)
  if (mic && recordedMic?.groupId !== mic.groupId) problems.push(`Sua voz continua sendo gravada por ${deviceName(recordedMic)}: escolha o microfone do fone nas configurações.`)
  const body = problems.length ? problems.join(' ') : 'O app já grava por ele.'
  const notification = new Notification(`${deviceName(output ?? mic)} conectado`, { body })
  notification.onclick = () => api.overlay.openSettings()
}
api.onShowSettings(() => showView('settings'))

const settings = await api.getSettings()
llmProfiles = settings.llmProfiles
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
$('#overlay-opacity').value = await api.overlayOpacity()
await refreshAudioDevices()
renderOverlayOpacity(Number($('#overlay-opacity').value))
syncCombobox($('#theme'))
renderMcp(await api.mcpStatus())

await refreshList()
if (meetings.length) await showMeeting(meetings[0].id)

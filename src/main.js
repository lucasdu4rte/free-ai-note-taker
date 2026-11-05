import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeTheme, net, safeStorage, screen, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, LLM_PRESETS } from './presets.js'
import { FILES, processMeeting, readIfExists } from './pipeline.js'
import { parseSummary, summaryPreview, toggleTask } from './notes.js'
import { HEADER_BYTES, SAMPLE_RATE, floatToInt16, repairWavHeader, wavHeader } from './wav.js'

// Chromium's network stack honours the Windows proxy/PAC settings that corporate networks rely on.
globalThis.fetch = net.fetch

const MEETING_ID = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/
// Ctrl+Shift+R would steal the browsers' hard-reload shortcut system-wide.
const SHORTCUT = 'CommandOrControl+Alt+R'
const SHORTCUT_LABEL = process.platform === 'darwin' ? '⌘⌥R' : 'Ctrl+Alt+R'
const OVERLAY_SIZE = { width: 640, height: 112, bottomMargin: 24 }
const OVERLAY_LINGER_MS = 8000
const MAX_TITLE_LENGTH = 120

const notesDir = () => path.join(app.getPath('documents'), 'Free AI Note Taker')
const modelsDir = () => path.join(app.getPath('userData'), 'models')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const preload = path.join(import.meta.dirname, 'preload.cjs')

function meetingDir(id) {
  if (!MEETING_ID.test(id)) throw new Error(`Reunião inválida: ${id}`)
  return path.join(notesDir(), id)
}

function meetingInfo(id) {
  const summary = readIfExists(path.join(meetingDir(id), FILES.summary))
  const customTitle = readIfExists(path.join(meetingDir(id), FILES.title))
  const audio = path.join(meetingDir(id), FILES.audio)
  const seconds = fs.existsSync(audio) ? (fs.statSync(audio).size - HEADER_BYTES) / (SAMPLE_RATE * 2) : 0
  return {
    id,
    title: customTitle || parseSummary(summary).title,
    preview: summaryPreview(summary),
    minutes: Math.max(1, Math.round(seconds / 60)),
    hasSummary: summary !== undefined,
  }
}

async function loadSettings() {
  const saved = JSON.parse(readIfExists(settingsFile()) ?? 'null')
  if (!saved) return DEFAULT_SETTINGS
  for (const section of ['transcription', 'llm']) {
    const { apiKey } = saved[section]
    saved[section].apiKey = apiKey ? (await safeStorage.decryptStringAsync(Buffer.from(apiKey, 'base64'))).result : ''
  }
  return saved
}

async function saveSettings(settings) {
  const stored = structuredClone(settings)
  for (const section of ['transcription', 'llm']) {
    const { apiKey } = stored[section]
    stored[section].apiKey = apiKey ? (await safeStorage.encryptStringAsync(apiKey)).toString('base64') : ''
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(stored, null, 2))
}

let win
let overlay
let overlayState = { phase: 'hidden' }
let hideOverlayTimer
let recording = null

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay()
  const window = new BrowserWindow({
    width: OVERLAY_SIZE.width,
    height: OVERLAY_SIZE.height,
    x: Math.round(workArea.x + (workArea.width - OVERLAY_SIZE.width) / 2),
    y: workArea.y + workArea.height - OVERLAY_SIZE.height - OVERLAY_SIZE.bottomMargin,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload },
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.loadFile(path.join(import.meta.dirname, 'overlay.html'))
  return window
}

function showOverlay(state) {
  clearTimeout(hideOverlayTimer)
  overlayState = state
  overlay.webContents.send('overlay:state', state)
  // showInactive keeps the focus on Teams instead of jumping to the overlay.
  if (!overlay.isVisible()) overlay.showInactive()
  if (state.phase === 'done' || state.phase === 'error') hideOverlayTimer = setTimeout(hideOverlay, OVERLAY_LINGER_MS)
}

function hideOverlay() {
  clearTimeout(hideOverlayTimer)
  overlayState = { phase: 'hidden' }
  overlay.hide()
}

function focusMainWindow(channel, ...args) {
  hideOverlay()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send(channel, ...args)
}

ipcMain.handle('recording:start', async () => {
  const id = new Date().toLocaleString('sv').replaceAll(':', '-')
  fs.mkdirSync(meetingDir(id), { recursive: true })
  const fd = fs.openSync(path.join(meetingDir(id), FILES.audio), 'w')
  fs.writeSync(fd, wavHeader(0))
  recording = { id, fd }
  const { llm } = await loadSettings()
  showOverlay({
    phase: 'recording',
    startedAt: Date.now(),
    sources: process.platform === 'win32' ? 'Microfone + som do PC' : 'Microfone',
    llm: LLM_PRESETS[llm.provider]?.label.split(' (')[0] ?? llm.model,
  })
  return id
})

ipcMain.on('recording:chunk', (_event, samples) => {
  if (recording) fs.writeSync(recording.fd, floatToInt16(samples))
})

ipcMain.on('recording:level', (_event, level) => overlay.webContents.send('overlay:level', level))

ipcMain.handle('recording:stop', () => {
  const { id, fd } = recording
  recording = null
  fs.closeSync(fd)
  repairWavHeader(path.join(meetingDir(id), FILES.audio))
  showOverlay({ phase: 'processing', status: 'Preparando o áudio' })
  return id
})

ipcMain.handle('meeting:process', async (event, id) => {
  const report = (status) => {
    event.sender.send('status', id, status)
    showOverlay({ phase: 'processing', status })
  }
  try {
    await processMeeting(meetingDir(id), await loadSettings(), modelsDir(), report)
  } catch (error) {
    showOverlay({ phase: 'error', id, status: error.message })
    throw error
  }
  showOverlay({ phase: 'done', id, title: meetingInfo(id).title })
})

ipcMain.handle('meetings:list', () => {
  fs.mkdirSync(notesDir(), { recursive: true })
  return fs.readdirSync(notesDir()).filter((name) => MEETING_ID.test(name)).sort().reverse().map(meetingInfo)
})

ipcMain.handle('meeting:read', (_event, id) => {
  const file = (name) => readIfExists(path.join(meetingDir(id), name))
  return { summary: file(FILES.summary), transcript: file(FILES.transcript) ?? file(FILES.rawTranscript) }
})

ipcMain.handle('meeting:toggle-task', (_event, id, index, done) => {
  const file = path.join(meetingDir(id), FILES.summary)
  fs.writeFileSync(file, toggleTask(fs.readFileSync(file, 'utf8'), index, done))
})

// The rename lives in its own file so reprocessing, which rewrites the summary, keeps the name the user chose.
ipcMain.handle('meeting:rename', (_event, id, title) => {
  const file = path.join(meetingDir(id), FILES.title)
  const name = String(title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
  if (!name) return fs.rmSync(file, { force: true })
  fs.writeFileSync(file, name)
})

ipcMain.handle('meeting:open', (_event, id) => shell.openPath(meetingDir(id)))
ipcMain.handle('settings:get', loadSettings)
ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings))

ipcMain.handle('overlay:get-state', () => overlayState)
ipcMain.on('overlay:stop', () => win.webContents.send('recording:toggle'))
ipcMain.on('overlay:open-meeting', (_event, id) => focusMainWindow('meeting:show', id))
ipcMain.on('overlay:open-settings', () => focusMainWindow('settings:show'))

app.whenReady().then(() => {
  // Teams/Meet/Zoom audio comes out of the speakers: Windows lets us record it as a WASAPI loopback, no driver needed.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const [source] = await desktopCapturer.getSources({ types: ['screen'] })
    callback({ video: source, audio: 'loopback' })
  })

  win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'Free AI Note Taker',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141518' : '#FFFFFF',
    webPreferences: { preload },
  })
  win.removeMenu()
  win.loadFile(path.join(import.meta.dirname, 'index.html'))
  // The overlay is a window too, so closing the main window has to end the app explicitly.
  win.on('closed', () => app.quit())

  overlay = createOverlay()

  const shortcutRegistered = globalShortcut.register(SHORTCUT, () => win.webContents.send('recording:toggle'))
  ipcMain.handle('app:shortcut', () => (shortcutRegistered ? SHORTCUT_LABEL : null))
})

app.on('will-quit', () => globalShortcut.unregisterAll())

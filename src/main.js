import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeTheme, net, safeStorage, screen, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import electronUpdater from 'electron-updater'
import { DEFAULT_SETTINGS, LLM_PRESETS, withSettingsDefaults } from './presets.js'
import { FILES, completedSteps, processMeeting, readIfExists, testTranscription } from './pipeline.js'
import { testLlm } from './llm.js'
import { parseSummary, shortcutLabel, summaryPreview, toggleTask } from './notes.js'
import { HEADER_BYTES, SAMPLE_RATE, floatToInt16, repairWavHeader, wavHeader } from './wav.js'

// Chromium's network stack honours the Windows proxy/PAC settings that corporate networks rely on.
globalThis.fetch = net.fetch

const MEETING_ID = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/
// Ctrl+Shift+R would steal the browsers' hard-reload shortcut system-wide.
const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+R'
const OVERLAY_SIZE = { width: 640, height: 112, bottomMargin: 24 }
const MAX_TITLE_LENGTH = 120
const MIN_RECORDING_SECONDS = 3
const THEMES = ['system', 'light', 'dark']

const notesDir = () => path.join(app.getPath('documents'), 'Free AI Note Taker')
const modelsDir = () => path.join(app.getPath('userData'), 'models')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const shortcutFile = () => path.join(app.getPath('userData'), 'shortcut.txt')
const themeFile = () => path.join(app.getPath('userData'), 'theme.txt')
const preload = path.join(import.meta.dirname, 'preload.cjs')

function meetingDir(id) {
  if (!MEETING_ID.test(id)) throw new Error(`Reunião inválida: ${id}`)
  return path.join(notesDir(), id)
}

const audioSeconds = (file) => (fs.existsSync(file) ? (fs.statSync(file).size - HEADER_BYTES) / (SAMPLE_RATE * 2) : 0)

function meetingInfo(id) {
  const summary = readIfExists(path.join(meetingDir(id), FILES.summary))
  const customTitle = readIfExists(path.join(meetingDir(id), FILES.title))
  const seconds = audioSeconds(path.join(meetingDir(id), FILES.audio))
  return {
    id,
    title: customTitle || parseSummary(summary).title,
    preview: summaryPreview(summary),
    minutes: Math.max(1, Math.round(seconds / 60)),
    hasSummary: summary !== undefined,
  }
}

const configsWithKeys = (settings) => [settings.transcription, settings.llm, ...settings.llmFallbacks]

async function loadSettings() {
  const saved = JSON.parse(readIfExists(settingsFile()) ?? 'null')
  if (!saved) return DEFAULT_SETTINGS
  const settings = withSettingsDefaults(saved)
  for (const config of configsWithKeys(settings)) {
    config.apiKey = config.apiKey ? (await safeStorage.decryptStringAsync(Buffer.from(config.apiKey, 'base64'))).result : ''
  }
  return settings
}

async function saveSettings(settings) {
  const stored = withSettingsDefaults(structuredClone(settings))
  for (const config of configsWithKeys(stored)) {
    config.apiKey = config.apiKey ? (await safeStorage.encryptStringAsync(config.apiKey)).toString('base64') : ''
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(stored, null, 2))
}

let win
let overlay
let overlayState = { phase: 'hidden' }
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
  overlayState = state
  overlay.webContents.send('overlay:state', state)
  // showInactive keeps the focus on Teams instead of jumping to the overlay.
  if (!overlay.isVisible()) overlay.showInactive()
}

function hideOverlay() {
  overlayState = { phase: 'hidden' }
  // A hidden window keeps running, so the recording view's timer has to be told to stop.
  overlay.webContents.send('overlay:state', overlayState)
  overlay.hide()
}

function focusMainWindow(channel, ...args) {
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
  const audio = path.join(meetingDir(id), FILES.audio)
  repairWavHeader(audio)
  hideOverlay()
  // A press-and-release of the shortcut leaves an empty meeting nobody wants in the list.
  if (audioSeconds(audio) >= MIN_RECORDING_SECONDS) return id
  fs.rmSync(meetingDir(id), { recursive: true, force: true })
  return null
})

ipcMain.handle('meeting:process', async (event, id, from) => {
  // Processing the WAV still being written would cache a partial raw transcript for the real run after Parar.
  if (id === recording?.id) throw new Error('Pare a gravação antes de processar esta reunião.')
  const report = (step, detail) => event.sender.send('meeting:progress', id, step, detail)
  await processMeeting(meetingDir(id), await loadSettings(), modelsDir(), report, from)
})

ipcMain.handle('meetings:list', () => {
  fs.mkdirSync(notesDir(), { recursive: true })
  return fs.readdirSync(notesDir()).filter((name) => MEETING_ID.test(name) && name !== recording?.id).sort().reverse().map(meetingInfo)
})

ipcMain.handle('meeting:read', (_event, id) => {
  const file = (name) => readIfExists(path.join(meetingDir(id), name))
  const audio = path.join(meetingDir(id), FILES.audio)
  return {
    summary: file(FILES.summary),
    transcript: file(FILES.transcript) ?? file(FILES.rawTranscript),
    audioUrl: fs.existsSync(audio) ? pathToFileURL(audio).href : undefined,
    done: completedSteps(meetingDir(id)),
  }
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

ipcMain.handle('meeting:delete', (_event, id) => {
  if (id === recording?.id) throw new Error('Pare a gravação antes de excluir esta reunião.')
  return shell.trashItem(meetingDir(id))
})

ipcMain.handle('meeting:open', (_event, id) => shell.openPath(meetingDir(id)))
ipcMain.handle('settings:get', loadSettings)
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings))
ipcMain.handle('settings:test', (event, section, config) => {
  if (section === 'llm') return testLlm(config)
  return testTranscription(config, modelsDir(), (status) => event.sender.send('settings:test-status', section, status))
})

ipcMain.handle('overlay:get-state', () => overlayState)
ipcMain.on('overlay:stop', () => win.webContents.send('recording:toggle'))
ipcMain.on('overlay:open-settings', () => focusMainWindow('settings:show'))

// Updates come from this repo's GitHub Releases (latest.yml). A downloaded update installs when the app quits,
// so it never cuts a recording short; the sidebar also offers to restart right away.
function watchUpdates() {
  const { autoUpdater } = electronUpdater
  autoUpdater.on('update-downloaded', ({ version }) => win.webContents.send('update:ready', version))
  autoUpdater.on('error', (error) => console.error('Update failed:', error.message))
  autoUpdater.checkForUpdates().catch(() => {})
}

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) throw new Error('A busca de atualização só funciona no app instalado.')
  const result = await electronUpdater.autoUpdater.checkForUpdates()
  const latest = result?.updateInfo.version ?? app.getVersion()
  return { latest, available: latest !== app.getVersion() }
})

ipcMain.on('update:install', () => {
  if (recording) return
  electronUpdater.autoUpdater.quitAndInstall(true, true)
})

// A second copy would fight the first over the global shortcut and the meeting being recorded.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(() => {
  nativeTheme.themeSource = readIfExists(themeFile())?.trim() || 'system'
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

  if (app.isPackaged) watchUpdates()

  registerShortcut(readIfExists(shortcutFile())?.trim() || DEFAULT_SHORTCUT)
})

let shortcut = null

function registerShortcut(accelerator) {
  if (!globalShortcut.register(accelerator, () => win.webContents.send('recording:toggle'))) return false
  shortcut = accelerator
  return true
}

const currentShortcut = () => (shortcut ? shortcutLabel(shortcut, process.platform) : null)

ipcMain.handle('app:shortcut', currentShortcut)
// Paused while the user presses a new combination, so pressing the current one does not start a recording.
ipcMain.handle('app:shortcut-pause', () => globalShortcut.unregisterAll())
ipcMain.handle('app:shortcut-set', (_event, accelerator) => {
  const previous = shortcut
  if (accelerator && registerShortcut(accelerator)) {
    fs.writeFileSync(shortcutFile(), accelerator)
    return { label: currentShortcut() }
  }
  if (previous) registerShortcut(previous)
  return { label: currentShortcut(), taken: Boolean(accelerator) }
})

ipcMain.handle('app:theme', () => nativeTheme.themeSource)
ipcMain.handle('app:theme-set', (_event, theme) => {
  if (!THEMES.includes(theme)) throw new Error(`Tema inválido: ${theme}`)
  nativeTheme.themeSource = theme
  fs.writeFileSync(themeFile(), theme)
})

app.on('will-quit', () => globalShortcut.unregisterAll())

import { app, BrowserWindow, desktopCapturer, ipcMain, net, safeStorage, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS } from './presets.js'
import { FILES, processMeeting, readIfExists } from './pipeline.js'
import { floatToInt16, repairWavHeader, wavHeader } from './wav.js'

// Chromium's network stack honours the Windows proxy/PAC settings that corporate networks rely on.
globalThis.fetch = net.fetch

const notesDir = () => path.join(app.getPath('documents'), 'Free AI Note Taker')
const modelsDir = () => path.join(app.getPath('userData'), 'models')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

function meetingDir(id) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(id)) throw new Error(`Reunião inválida: ${id}`)
  return path.join(notesDir(), id)
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

let recording = null

ipcMain.handle('recording:start', () => {
  const id = new Date().toLocaleString('sv').replaceAll(':', '-')
  fs.mkdirSync(meetingDir(id), { recursive: true })
  const fd = fs.openSync(path.join(meetingDir(id), FILES.audio), 'w')
  fs.writeSync(fd, wavHeader(0))
  recording = { id, fd }
  return id
})

ipcMain.on('recording:chunk', (_event, samples) => {
  if (recording) fs.writeSync(recording.fd, floatToInt16(samples))
})

ipcMain.handle('recording:stop', () => {
  const { id, fd } = recording
  recording = null
  fs.closeSync(fd)
  repairWavHeader(path.join(meetingDir(id), FILES.audio))
  return id
})

ipcMain.handle('meeting:process', async (event, id) =>
  processMeeting(meetingDir(id), await loadSettings(), modelsDir(), (status) => event.sender.send('status', id, status)),
)

ipcMain.handle('meetings:list', () => {
  fs.mkdirSync(notesDir(), { recursive: true })
  return fs.readdirSync(notesDir()).filter((name) => /^\d{4}-/.test(name)).sort().reverse()
})

ipcMain.handle('meeting:read', (_event, id) => {
  const file = (name) => readIfExists(path.join(meetingDir(id), name))
  return { summary: file(FILES.summary), transcript: file(FILES.transcript) ?? file(FILES.rawTranscript) }
})

ipcMain.handle('meeting:open', (_event, id) => shell.openPath(meetingDir(id)))
ipcMain.handle('settings:get', loadSettings)
ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings))

app.whenReady().then(() => {
  // Teams/Meet/Zoom audio comes out of the speakers: Windows lets us record it as a WASAPI loopback, no driver needed.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] })
    callback({ video: screen, audio: 'loopback' })
  })

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Free AI Note Taker',
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs') },
  })
  win.removeMenu()
  win.loadFile(path.join(import.meta.dirname, 'index.html'))
})

app.on('window-all-closed', () => app.quit())

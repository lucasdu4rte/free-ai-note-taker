const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, ...args) => callback(...args))

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  shortcut: () => ipcRenderer.invoke('app:shortcut'),
  pauseShortcut: () => ipcRenderer.invoke('app:shortcut-pause'),
  setShortcut: (accelerator) => ipcRenderer.invoke('app:shortcut-set', accelerator),
  version: () => ipcRenderer.invoke('app:version'),
  startRecording: () => ipcRenderer.invoke('recording:start'),
  sendAudio: (samples) => ipcRenderer.send('recording:chunk', samples),
  sendLevel: (level) => ipcRenderer.send('recording:level', level),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  processMeeting: (id, from) => ipcRenderer.invoke('meeting:process', id, from),
  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  readMeeting: (id) => ipcRenderer.invoke('meeting:read', id),
  toggleTask: (id, index, done) => ipcRenderer.invoke('meeting:toggle-task', id, index, done),
  renameMeeting: (id, title) => ipcRenderer.invoke('meeting:rename', id, title),
  openMeeting: (id) => ipcRenderer.invoke('meeting:open', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testSettings: (section, config) => ipcRenderer.invoke('settings:test', section, config),
  onTestStatus: on('settings:test-status'),
  onUpdateReady: on('update:ready'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onMeetingProgress: on('meeting:progress'),
  onToggleRecording: on('recording:toggle'),
  onShowSettings: on('settings:show'),

  overlay: {
    getState: () => ipcRenderer.invoke('overlay:get-state'),
    onState: on('overlay:state'),
    onLevel: on('overlay:level'),
    stop: () => ipcRenderer.send('overlay:stop'),
    openSettings: () => ipcRenderer.send('overlay:open-settings'),
  },
})

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  startRecording: () => ipcRenderer.invoke('recording:start'),
  sendAudio: (samples) => ipcRenderer.send('recording:chunk', samples),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  processMeeting: (id) => ipcRenderer.invoke('meeting:process', id),
  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  readMeeting: (id) => ipcRenderer.invoke('meeting:read', id),
  openMeeting: (id) => ipcRenderer.invoke('meeting:open', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  onStatus: (callback) => ipcRenderer.on('status', (_event, id, status) => callback(id, status)),
})

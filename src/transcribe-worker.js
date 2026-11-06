import { net } from 'electron'
import { transcribe } from './pipeline.js'

// Same proxy-aware fetch as the main process, for cloud transcription behind corporate proxies.
globalThis.fetch = net.fetch

process.parentPort.once('message', async ({ data: { audioPath, config, modelsDir } }) => {
  const send = (message) => process.parentPort.postMessage(message)
  try {
    send({ transcript: await transcribe(audioPath, config, modelsDir, (status) => send({ status })) })
  } catch (error) {
    send({ error: error.message })
  }
})

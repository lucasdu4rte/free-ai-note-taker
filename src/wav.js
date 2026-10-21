import fs from 'node:fs'

export const SAMPLE_RATE = 16000
const HEADER_BYTES = 44

export function wavHeader(dataBytes, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

export function floatToInt16(samples) {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff
  return pcm
}

export function encodeWav(samples) {
  const pcm = floatToInt16(samples)
  return Buffer.concat([wavHeader(pcm.byteLength), Buffer.from(pcm.buffer)])
}

// The recording is written while the meeting runs, so after a crash the header still says 0 bytes.
export function repairWavHeader(file) {
  const dataBytes = fs.statSync(file).size - HEADER_BYTES
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, wavHeader(dataBytes), 0, HEADER_BYTES, 0)
  fs.closeSync(fd)
}

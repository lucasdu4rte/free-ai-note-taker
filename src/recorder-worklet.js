const CHUNK_SAMPLES = 4000 // 250 ms at 16 kHz

class Recorder extends AudioWorkletProcessor {
  chunk = new Float32Array(CHUNK_SAMPLES)
  offset = 0

  process([input]) {
    const mono = input[0]
    if (!mono) return true
    for (const sample of mono) {
      this.chunk[this.offset++] = sample
      if (this.offset < CHUNK_SAMPLES) continue
      this.port.postMessage(this.chunk)
      this.chunk = new Float32Array(CHUNK_SAMPLES)
      this.offset = 0
    }
    return true
  }
}

registerProcessor('recorder', Recorder)

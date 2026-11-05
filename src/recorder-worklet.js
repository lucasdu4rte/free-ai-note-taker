const CHUNK_SAMPLES = 4000 // 250 ms at 16 kHz
const LEVEL_SAMPLES = 800 // 50 ms, so the overlay's level bars move at about 20 fps

class Recorder extends AudioWorkletProcessor {
  chunk = new Float32Array(CHUNK_SAMPLES)
  offset = 0
  sumSquares = 0
  levelSamples = 0

  process([input]) {
    const mono = input[0]
    if (!mono) return true
    for (const sample of mono) {
      this.trackLevel(sample)
      this.chunk[this.offset++] = sample
      if (this.offset < CHUNK_SAMPLES) continue
      this.port.postMessage(this.chunk)
      this.chunk = new Float32Array(CHUNK_SAMPLES)
      this.offset = 0
    }
    return true
  }

  trackLevel(sample) {
    this.sumSquares += sample * sample
    if (++this.levelSamples < LEVEL_SAMPLES) return
    this.port.postMessage(Math.min(1, Math.sqrt(this.sumSquares / LEVEL_SAMPLES) * 4))
    this.sumSquares = 0
    this.levelSamples = 0
  }
}

registerProcessor('recorder', Recorder)

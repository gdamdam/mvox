// A pass-through AudioWorklet that taps the master output for WAV capture. It
// forwards input to output unchanged and, while armed, batches channel frames
// into reused buffers and transfers them (zero-copy) to the main thread ~once
// per BATCH_FRAMES, where they're concatenated and run through the tested
// encodeWav(). Kept separate from the engine worklet so DSP and capture stay
// decoupled.
//
// Batching (vs. posting every 128-frame quantum) keeps the audio thread off the
// hot path of ~375 allocations and cross-thread messages per second at 48 kHz,
// which is what glitches long recordings. Mirrors the batched recorder in
// mkeys/mfx.

declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor,
): void

export type RecorderCommand = { type: 'start' } | { type: 'stop' }
export type RecorderMessage =
  | { type: 'chunk'; left: Float32Array; right: Float32Array }
  | { type: 'started'; sampleRate: number }
  | { type: 'stopped' }

// ~170 ms at 48 kHz (64 render quanta). Big enough to slash the message rate,
// small enough that the auto-stop cap and stop-flush tail stay tight.
const BATCH_FRAMES = 8192

class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false
  // Reused across quanta: filled up to `fill`, then a right-sized copy is
  // transferred out and `fill` resets — no per-quantum allocation.
  private readonly batchL = new Float32Array(BATCH_FRAMES)
  private readonly batchR = new Float32Array(BATCH_FRAMES)
  private fill = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<RecorderCommand>) => {
      if (event.data.type === 'start') {
        this.recording = true
        this.port.postMessage({ type: 'started', sampleRate })
      } else {
        // Stop-ack handshake: flush the partial batch first, then post 'stopped'.
        // Message-port ordering guarantees every chunk we posted this session
        // (including this final flush) precedes 'stopped', so the main thread can
        // wait for it and assemble without dropping the final render quanta.
        this.recording = false
        this.flush()
        this.port.postMessage({ type: 'stopped' })
      }
    }
  }

  /** Transfer the accumulated frames to the main thread and reset the batch. */
  private flush(): void {
    if (this.fill === 0) return
    // slice() yields a right-sized copy with its own buffer, so the reused batch
    // buffers stay usable after we transfer these out.
    const left = this.batchL.slice(0, this.fill)
    const right = this.batchR.slice(0, this.fill)
    this.port.postMessage({ type: 'chunk', left, right }, [left.buffer, right.buffer])
    this.fill = 0
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]
    if (input && output) {
      for (let ch = 0; ch < output.length; ch += 1) {
        const src = input[ch] ?? input[0]
        if (src) output[ch].set(src)
      }
    }
    if (this.recording && input && input[0]) {
      const left = input[0]
      const right = input[1] ?? input[0]
      // Copy the quantum into the batch, splitting across a flush boundary if the
      // batch fills mid-quantum (quanta are 128 frames, but don't assume it).
      let srcOff = 0
      const n = left.length
      while (srcOff < n) {
        const take = Math.min(BATCH_FRAMES - this.fill, n - srcOff)
        this.batchL.set(left.subarray(srcOff, srcOff + take), this.fill)
        this.batchR.set(right.subarray(srcOff, srcOff + take), this.fill)
        this.fill += take
        srcOff += take
        if (this.fill === BATCH_FRAMES) this.flush()
      }
    }
    return true
  }
}

registerProcessor('mvox-recorder', RecorderProcessor)

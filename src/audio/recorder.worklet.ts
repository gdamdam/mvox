// A pass-through AudioWorklet that taps the master output for WAV capture. It
// forwards input to output unchanged and, while armed, copies each channel block
// to the main thread (transferred, zero-copy) where they're concatenated and run
// through the tested encodeWav(). Kept separate from the engine worklet so DSP
// and capture stay decoupled.

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

class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<RecorderCommand>) => {
      if (event.data.type === 'start') {
        this.recording = true
        this.port.postMessage({ type: 'started', sampleRate })
      } else {
        this.recording = false
      }
    }
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
      // Copy (not transfer the render buffer itself — it's reused each quantum).
      const left = new Float32Array(input[0])
      const right = new Float32Array(input[1] ?? input[0])
      this.port.postMessage({ type: 'chunk', left, right }, [left.buffer, right.buffer])
    }
    return true
  }
}

registerProcessor('mvox-recorder', RecorderProcessor)

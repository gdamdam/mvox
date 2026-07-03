// Thin AudioWorklet shell around the pure MvoxEngineCore. Declares the worklet
// globals itself (no ambient lib), owns message handling and throttled telemetry,
// and delegates all DSP to the Node-testable core. Loaded via ?worker&url so Vite
// bundles it (plus its imported DSP) as a separate hashed chunk.

import { WORKLET_PROCESSOR_NAME, type MainToWorkletMessage } from './contracts'
import { MvoxEngineCore } from './dsp/engineCore'

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

const TELEMETRY_HZ = 30

class MvoxProcessor extends AudioWorkletProcessor {
  private readonly core = new MvoxEngineCore(sampleRate)
  private readonly telemetryInterval = Math.max(1, Math.round(sampleRate / TELEMETRY_HZ))
  private framesUntilTelemetry = this.telemetryInterval
  // Reused silent input for the no-mic case; allocating per quantum here would
  // churn ~375 Float32Arrays/sec on the audio thread (no hot-path allocation).
  private silentInput = new Float32Array(128)

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<MainToWorkletMessage>) => {
      const msg = event.data
      switch (msg.type) {
        case 'set-patch':
          this.core.setPatch(msg.patch)
          break
        case 'note-on':
          this.core.noteOn(msg.note.midi, msg.note.velocity)
          break
        case 'note-off':
          this.core.noteOff(msg.midi)
          break
        case 'panic':
          this.core.panic()
          break
        case 'set-voice-sample':
          this.core.setVoiceSample(msg.channel)
          break
        case 'use-live-input':
          this.core.setLiveInput(msg.live)
          break
        case 'set-tempo':
          this.core.setTempo(msg.bpm)
          break
        case 'reset':
          this.core.reset()
          break
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outL = output[0]
    const outR = output[1] ?? output[0]
    let input = inputs[0]?.[0]
    if (!input) {
      // Reallocate only if the quantum size ever differs from our cached buffer.
      if (this.silentInput.length !== outL.length) this.silentInput = new Float32Array(outL.length)
      input = this.silentInput
    }

    const t = this.core.process(input, outL, outR)

    this.framesUntilTelemetry -= outL.length
    if (this.framesUntilTelemetry <= 0) {
      this.framesUntilTelemetry = this.telemetryInterval
      this.port.postMessage({
        type: 'telemetry',
        inputLevel: t.inputLevel,
        outputPeak: t.outputPeak,
        f0: t.f0,
        confidence: t.confidence,
        activeVoices: t.activeVoices,
      })
    }
    return true
  }
}

registerProcessor(WORKLET_PROCESSOR_NAME, MvoxProcessor)

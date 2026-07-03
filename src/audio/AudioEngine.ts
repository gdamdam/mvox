// Framework-agnostic audio engine: owns the AudioContext, loads the worklet,
// wires the mic (input never monitored to output by default), routes notes and
// patch changes to the worklet, and fans telemetry back out to listeners. No
// React or DOM-framework imports — the UI subscribes through the listener API.

import mvoxWorkletUrl from './mvox.worklet.ts?worker&url'
import recorderWorkletUrl from './recorder.worklet.ts?worker&url'
import {
  DEFAULT_PATCH,
  WORKLET_PROCESSOR_NAME,
  sanitizePatch,
  type MainToWorkletMessage,
  type MvoxPatch,
  type NoteMsg,
  type Telemetry,
  type WorkletToMainMessage,
} from './contracts'
import { makeDemoVoice } from './demoVoice'
import { encodeWav } from './dsp/wav'

interface RecordChunk {
  left: Float32Array
  right: Float32Array
}

export type EngineStatus = 'idle' | 'starting' | 'running' | 'error'

type TelemetryListener = (t: Telemetry) => void
type StatusListener = (status: EngineStatus, error?: string) => void

const START_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

export class AudioEngine {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private master: GainNode | null = null
  private limiter: DynamicsCompressorNode | null = null
  private recorderNode: AudioWorkletNode | null = null
  private recording = false
  private recChunks: RecordChunk[] = []
  private recSampleRate = 48000
  private micStream: MediaStream | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private startPromise: Promise<void> | null = null
  private liveInputGeneration = 0

  private status: EngineStatus = 'idle'
  private patch: MvoxPatch = DEFAULT_PATCH
  private readonly telemetryListeners = new Set<TelemetryListener>()
  private readonly statusListeners = new Set<StatusListener>()

  getStatus(): EngineStatus {
    return this.status
  }

  onTelemetry(fn: TelemetryListener): () => void {
    this.telemetryListeners.add(fn)
    return () => this.telemetryListeners.delete(fn)
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  private setStatus(status: EngineStatus, error?: string): void {
    this.status = status
    for (const fn of this.statusListeners) fn(status, error)
  }

  /** Start (or resume) audio. Must be called from a user gesture. Idempotent. */
  start(): Promise<void> {
    this.startPromise ??= this.runStart().catch((err: unknown) => {
      this.startPromise = null
      const message = err instanceof Error ? err.message : 'Audio failed to start.'
      this.setStatus('error', message)
      throw err
    })
    return this.startPromise
  }

  private async runStart(): Promise<void> {
    if (this.status === 'running') return
    this.setStatus('starting')
    const context = new AudioContext({ latencyHint: 'interactive' })
    this.context = context

    await withTimeout(
      context.audioWorklet.addModule(mvoxWorkletUrl),
      START_TIMEOUT_MS,
      'Timed out loading the audio engine.',
    )
    await withTimeout(context.resume(), START_TIMEOUT_MS, 'Timed out starting audio.')

    const node = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 1,
      channelCountMode: 'explicit',
    })
    node.port.onmessage = (event: MessageEvent<WorkletToMainMessage>) => {
      const msg = event.data
      if (msg.type === 'telemetry') {
        for (const fn of this.telemetryListeners) fn(msg)
      }
    }

    const master = context.createGain()
    master.gain.value = 0.85
    const limiter = context.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.003
    limiter.release.value = 0.1

    // Recorder tap sits at the end of the chain (post-limiter) so captures match
    // what's heard. It passes audio through unchanged; capture is opt-in.
    await withTimeout(
      context.audioWorklet.addModule(recorderWorkletUrl),
      START_TIMEOUT_MS,
      'Timed out loading the recorder.',
    )
    const recorder = new AudioWorkletNode(context, 'mvox-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    })
    recorder.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'chunk'; left: Float32Array; right: Float32Array }
        | { type: 'started'; sampleRate: number }
      if (msg.type === 'chunk') {
        if (this.recording) this.recChunks.push({ left: msg.left, right: msg.right })
      } else if (msg.type === 'started') {
        this.recSampleRate = msg.sampleRate
      }
    }

    node.connect(master)
    master.connect(limiter)
    limiter.connect(recorder)
    recorder.connect(context.destination)

    this.node = node
    this.master = master
    this.limiter = limiter
    this.recorderNode = recorder

    // Seed the worklet with a demo voice so the instrument is playable with no
    // mic permission, plus the current patch.
    const demo = makeDemoVoice(context.sampleRate)
    this.post({ type: 'set-voice-sample', channel: demo }, [demo.buffer])
    this.post({ type: 'set-patch', patch: this.patch })

    this.setStatus('running')
  }

  private post(message: MainToWorkletMessage, transfer?: Transferable[]): void {
    if (!this.node) return
    if (transfer) this.node.port.postMessage(message, transfer)
    else this.node.port.postMessage(message)
  }

  setPatch(patch: MvoxPatch): void {
    this.patch = sanitizePatch(patch)
    this.post({ type: 'set-patch', patch: this.patch })
  }

  noteOn(note: NoteMsg): void {
    this.post({ type: 'note-on', note })
  }

  noteOff(midi: number): void {
    this.post({ type: 'note-off', midi })
  }

  panic(): void {
    this.post({ type: 'panic' })
  }

  setTempo(bpm: number): void {
    this.post({ type: 'set-tempo', bpm })
  }

  /**
   * Enable the microphone. Processing (AGC/NS/echo) is disabled so the raw voice
   * reaches the worklet. The mic connects ONLY into the worklet node, never to
   * destination — so the dry voice is never monitored through the speakers
   * (privacy + feedback). Returns true on success.
   */
  async enableMic(): Promise<boolean> {
    if (!this.context || !this.node) return false
    const generation = ++this.liveInputGeneration
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
    })
    // A newer enable/disable call superseded this one while awaiting permission.
    if (generation !== this.liveInputGeneration) {
      for (const track of stream.getTracks()) track.stop()
      return false
    }
    const track = stream.getAudioTracks()[0]
    if (track && 'contentHint' in track) track.contentHint = 'music'
    // Flush held notes if the device disconnects, and drop back to demo voice.
    track?.addEventListener('ended', () => {
      this.disableMic()
      this.post({ type: 'use-live-input', live: false })
    })

    const source = this.context.createMediaStreamSource(stream)
    source.connect(this.node)
    this.micStream = stream
    this.micSource = source
    this.post({ type: 'use-live-input', live: true })
    return true
  }

  disableMic(): void {
    this.liveInputGeneration += 1
    this.micSource?.disconnect()
    this.micSource = null
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop()
      this.micStream = null
    }
    this.post({ type: 'use-live-input', live: false })
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000
  }

  get isRecording(): boolean {
    return this.recording
  }

  startRecording(): void {
    if (!this.recorderNode || this.recording) return
    this.recChunks = []
    this.recording = true
    this.recorderNode.port.postMessage({ type: 'start' })
  }

  /** Stop recording and return the capture as a 16-bit WAV Blob (null if empty). */
  stopRecording(): Blob | null {
    if (!this.recorderNode || !this.recording) return null
    this.recording = false
    this.recorderNode.port.postMessage({ type: 'stop' })
    if (this.recChunks.length === 0) return null

    let total = 0
    for (const c of this.recChunks) total += c.left.length
    const left = new Float32Array(total)
    const right = new Float32Array(total)
    let offset = 0
    for (const c of this.recChunks) {
      left.set(c.left, offset)
      right.set(c.right, offset)
      offset += c.left.length
    }
    this.recChunks = []
    const wav = encodeWav([left, right], this.recSampleRate)
    return new Blob([wav], { type: 'audio/wav' })
  }

  async dispose(): Promise<void> {
    this.disableMic()
    this.panic()
    this.node?.disconnect()
    this.master?.disconnect()
    this.limiter?.disconnect()
    this.recorderNode?.disconnect()
    this.telemetryListeners.clear()
    this.statusListeners.clear()
    await this.context?.close()
    this.context = null
    this.node = null
    this.startPromise = null
    this.setStatus('idle')
  }
}

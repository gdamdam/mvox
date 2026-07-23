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
import { buildLimiterCurve } from './dsp/limiter'

interface RecordChunk {
  left: Float32Array
  right: Float32Array
}

export type EngineStatus = 'idle' | 'starting' | 'running' | 'error'

type TelemetryListener = (t: Telemetry) => void
type StatusListener = (status: EngineStatus, error?: string) => void
type MicListener = (on: boolean) => void
type SuspendListener = (suspended: boolean) => void

/** Recorder state fanned out so React can stay truthful about a capture that the
 *  engine stops on its own (the 10-minute cap) without any UI gesture. */
export interface RecordState {
  recording: boolean
  /** True when the active capture hit MAX_RECORD_SECONDS and auto-stopped. */
  capped: boolean
}
type RecordListener = (state: RecordState) => void
type LoadListener = (load: number) => void

/** How aggressively to trade latency for dropout-safety. 'safe' asks the browser
 *  for a larger buffer (fewer glitches, more latency); 'normal' is interactive. */
export type QualityMode = 'normal' | 'safe'

export interface EngineInfo {
  sampleRate: number
  baseLatency: number | null
  outputLatency: number | null
  /** True when this browser can route audio to a chosen output (AudioContext.setSinkId). */
  outputSelectionSupported: boolean
  /** True when a defensible render-load metric (AudioContext.renderCapacity) exists. */
  loadMetricSupported: boolean
}

export interface DeviceList {
  inputs: { id: string; label: string }[]
  outputs: { id: string; label: string }[]
}

const START_TIMEOUT_MS = 5000

/** Cap on a single capture so the unbounded chunk buffer can't exhaust memory. */
export const MAX_RECORD_SECONDS = 600

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  // Clear the timer on settle so a fast success doesn't leave a pending timeout
  // (and its stray late rejection) alive for up to `ms`.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class AudioEngine {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private master: GainNode | null = null
  private limiter: DynamicsCompressorNode | null = null
  // Brickwall ceiling after the compressor: makes limiterCeiling a guaranteed peak
  // ceiling, not just a compression knee the transient edge can slip past.
  private ceilingShaper: WaveShaperNode | null = null
  private lastCeilingDb = Number.NaN
  private recorderNode: AudioWorkletNode | null = null
  private recording = false
  private recChunks: RecordChunk[] = []
  private recSampleRate = 48000
  private recTotalSamples = 0
  private recCapped = false
  private recStopResolve: (() => void) | null = null
  private micStream: MediaStream | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private startPromise: Promise<void> | null = null
  private liveInputGeneration = 0
  // Device + quality preferences. Applied at context creation (quality) or on the
  // next mic enable / hot-swap (input id). Stored as stable ids, never device objects.
  private quality: QualityMode = 'normal'
  private preferredInputId: string | null = null
  private currentInputId: string | null = null
  // Render-load metric (AudioContext.renderCapacity) — subscribed only when the
  // browser supports it, so the UI never shows invented precision.
  private renderCapacity: { onupdate: ((e: unknown) => void) | null; start: (o: { updateInterval: number }) => void; stop: () => void } | null = null
  private renderCapacityHandler: ((e: unknown) => void) | null = null

  private status: EngineStatus = 'idle'
  private patch: MvoxPatch = DEFAULT_PATCH
  private readonly telemetryListeners = new Set<TelemetryListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly micListeners = new Set<MicListener>()
  private readonly suspendListeners = new Set<SuspendListener>()
  private readonly recordListeners = new Set<RecordListener>()
  private readonly loadListeners = new Set<LoadListener>()

  getStatus(): EngineStatus {
    return this.status
  }

  /** End-of-chain output (post-limiter recorder pass-through — what's heard)
   *  for publishing to the mbus patchbay. null until running. */
  getMasterTap(): AudioNode | null {
    return this.recorderNode
  }

  onTelemetry(fn: TelemetryListener): () => void {
    this.telemetryListeners.add(fn)
    return () => this.telemetryListeners.delete(fn)
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  /** Mic on/off, including involuntary drops (device unplugged/lost) that the UI
   *  must reflect — it can't observe the internal disableMic() otherwise. */
  onMic(fn: MicListener): () => void {
    this.micListeners.add(fn)
    return () => this.micListeners.delete(fn)
  }

  /** Fires when the browser suspends/resumes the AudioContext out from under us
   *  (tab backgrounded, iOS interruption). A suspended context is silent but still
   *  reports status 'running', so the UI needs this to offer a resume gesture. */
  onSuspend(fn: SuspendListener): () => void {
    this.suspendListeners.add(fn)
    return () => this.suspendListeners.delete(fn)
  }

  /** Recorder state, including the self-initiated stop when a capture hits the
   *  MAX_RECORD_SECONDS cap — the UI can't observe that internal stop otherwise. */
  onRecord(fn: RecordListener): () => void {
    this.recordListeners.add(fn)
    return () => this.recordListeners.delete(fn)
  }

  /** Render-load updates (0..1) when the browser exposes AudioContext.renderCapacity.
   *  Never fires on unsupported browsers — the UI hides the meter accordingly. */
  onLoad(fn: LoadListener): () => void {
    this.loadListeners.add(fn)
    return () => this.loadListeners.delete(fn)
  }

  private notifyLoad(load: number): void {
    for (const fn of this.loadListeners) fn(load)
  }

  /** Quality/latency tradeoff. Takes effect when the context is next (re)created;
   *  changing it while running is a no-op until restart (surfaced by the UI). */
  setQuality(q: QualityMode): void {
    this.quality = q
  }

  getQuality(): QualityMode {
    return this.quality
  }

  /** Live device + capability info for the UI. Safe before/after start. */
  getInfo(): EngineInfo {
    const ctx = this.context
    const ctxProto = typeof AudioContext !== 'undefined' ? AudioContext.prototype : null
    return {
      sampleRate: ctx?.sampleRate ?? 48000,
      baseLatency: ctx && 'baseLatency' in ctx ? ctx.baseLatency : null,
      outputLatency: ctx && 'outputLatency' in ctx ? (ctx as { outputLatency?: number }).outputLatency ?? null : null,
      outputSelectionSupported: !!ctxProto && 'setSinkId' in ctxProto,
      loadMetricSupported: !!ctxProto && 'renderCapacity' in ctxProto,
    }
  }

  getCurrentInputId(): string | null {
    return this.currentInputId
  }

  /** Enumerate audio input/output devices. Labels are only populated once mic
   *  permission has been granted (browser privacy rule); ids are always stable. */
  async listDevices(): Promise<DeviceList> {
    const empty: DeviceList = { inputs: [], outputs: [] }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return empty
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs: DeviceList['inputs'] = []
      const outputs: DeviceList['outputs'] = []
      for (const d of devices) {
        if (d.kind === 'audioinput') inputs.push({ id: d.deviceId, label: d.label || 'Microphone' })
        else if (d.kind === 'audiooutput') outputs.push({ id: d.deviceId, label: d.label || 'Output' })
      }
      return { inputs, outputs }
    } catch {
      return empty
    }
  }

  /** Choose the input device. Remembered for the next enable; hot-swaps live if the
   *  mic is already on (old source torn down first so nothing leaks or double-feeds). */
  async setInputDevice(deviceId: string | null): Promise<boolean> {
    this.preferredInputId = deviceId
    if (!this.micStream) return true // applied on next enableMic()
    this.disableMic()
    return this.enableMic(deviceId ?? undefined)
  }

  /** Route output to a chosen device via AudioContext.setSinkId. Returns false when
   *  unsupported (the UI hides the control) or on failure — audio keeps playing. */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    const ctx = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
    if (!ctx || typeof ctx.setSinkId !== 'function') return false
    try {
      await ctx.setSinkId(deviceId)
      return true
    } catch {
      return false
    }
  }

  private notifyMic(on: boolean): void {
    for (const fn of this.micListeners) fn(on)
  }

  private notifySuspended(suspended: boolean): void {
    for (const fn of this.suspendListeners) fn(suspended)
  }

  private notifyRecord(): void {
    const state: RecordState = { recording: this.recording, capped: this.recCapped }
    for (const fn of this.recordListeners) fn(state)
  }

  private setStatus(status: EngineStatus, error?: string): void {
    this.status = status
    for (const fn of this.statusListeners) fn(status, error)
  }

  /** Start (or resume) audio. Must be called from a user gesture. Idempotent. */
  start(): Promise<void> {
    // The OS/browser can suspend a running context out from under us (iOS
    // interruption, Safari tab restore). A fresh user gesture must resume it —
    // otherwise the cached resolved startPromise reports running while silent.
    if (this.status === 'running' && this.context?.state === 'suspended') {
      return this.context.resume()
    }
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
    // 'safe' asks for a larger buffer (fewer dropouts, more latency); 'normal' is
    // interactive/low-latency. This is a real, bounded CPU/latency tradeoff.
    const context = new AudioContext({ latencyHint: this.quality === 'safe' ? 'playback' : 'interactive' })
    this.context = context
    // Reflect browser-initiated suspend/resume so the UI can surface a resume
    // gesture; the initial suspended→running is handled by the resume() below.
    context.onstatechange = () => {
      if (this.context !== context) return
      this.notifySuspended(context.state === 'suspended')
    }

    try {
      await withTimeout(
        context.audioWorklet.addModule(mvoxWorkletUrl),
        START_TIMEOUT_MS,
        'Timed out loading the audio engine.',
      )
      // dispose() (e.g. React StrictMode unmount) nulls/replaces this.context; if
      // it fired while we were awaiting, bail before touching the dead context.
      if (this.context !== context) return
      await withTimeout(context.resume(), START_TIMEOUT_MS, 'Timed out starting audio.')
      if (this.context !== context) return

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
      // Two-stage limiter: the compressor does smooth, musical gain reduction as
      // the signal approaches the ceiling; the shaper below is the hard guarantee.
      const limiter = context.createDynamicsCompressor()
      limiter.threshold.value = this.patch.fx.limiterCeiling
      limiter.knee.value = 0
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.1
      // WaveShaper brickwall at the ceiling. oversample '4x' keeps the knee/clip
      // from aliasing. This is what makes "limiter ceiling" a true peak ceiling.
      const ceilingShaper = context.createWaveShaper()
      ceilingShaper.curve = buildLimiterCurve(this.patch.fx.limiterCeiling)
      ceilingShaper.oversample = '4x'
      this.lastCeilingDb = this.patch.fx.limiterCeiling

      // Recorder tap sits at the end of the chain (post-limiter) so captures match
      // what's heard. It passes audio through unchanged; capture is opt-in.
      await withTimeout(
        context.audioWorklet.addModule(recorderWorkletUrl),
        START_TIMEOUT_MS,
        'Timed out loading the recorder.',
      )
      if (this.context !== context) return
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
          | { type: 'stopped' }
        if (msg.type === 'chunk') {
          // Accept chunks while armed and during the stop handshake (recStopResolve
          // set), so the tail quanta flushed before 'stopped' aren't dropped.
          if ((this.recording && !this.recCapped) || this.recStopResolve) {
            this.recChunks.push({ left: msg.left, right: msg.right })
            this.recTotalSamples += msg.left.length
            // Cap the capture: stop the worklet tap but keep the buffered audio so
            // a later stopRecording() still returns the (capped) WAV.
            if (
              this.recording &&
              !this.recCapped &&
              this.recTotalSamples >= MAX_RECORD_SECONDS * this.recSampleRate
            ) {
              this.recCapped = true
              this.recorderNode?.port.postMessage({ type: 'stop' })
              // Surface the self-initiated cap so the UI can notify + finalize;
              // recording stays true (buffer preserved) until stopRecording().
              this.notifyRecord()
            }
          }
        } else if (msg.type === 'started') {
          this.recSampleRate = msg.sampleRate
        } else if (msg.type === 'stopped') {
          const resolve = this.recStopResolve
          this.recStopResolve = null
          resolve?.()
        }
      }

      node.connect(master)
      master.connect(limiter)
      limiter.connect(ceilingShaper)
      ceilingShaper.connect(recorder)
      recorder.connect(context.destination)

      this.node = node
      this.master = master
      this.limiter = limiter
      this.ceilingShaper = ceilingShaper
      this.recorderNode = recorder

      // Seed the worklet with a demo voice so the instrument is playable with no
      // mic permission, plus the current patch.
      const demo = makeDemoVoice(context.sampleRate)
      this.post({ type: 'set-voice-sample', channel: demo }, [demo.buffer])
      this.post({ type: 'set-patch', patch: this.patch })

      this.subscribeRenderCapacity(context)
      this.setStatus('running')
    } catch (err) {
      // Failed/timed-out start leaks a live AudioContext unless closed; browsers
      // cap concurrent contexts, so retries would eventually fail permanently (H5).
      if (context.state !== 'closed') void context.close()
      // Superseded by dispose()/restart mid-start: that path owns cleanup and the
      // idle status, so swallow rather than resurrect an 'error' status (M12).
      if (this.context !== context) return
      this.context = null
      throw err
    }
  }

  // Subscribe to AudioContext.renderCapacity if the browser has it. The metric is
  // the fraction of the render budget used — a defensible dropout/overload signal.
  private subscribeRenderCapacity(context: AudioContext): void {
    const rc = (context as { renderCapacity?: AudioEngine['renderCapacity'] }).renderCapacity
    if (!rc || typeof rc.start !== 'function') return
    this.renderCapacity = rc
    this.renderCapacityHandler = (e: unknown) => {
      const load = (e as { renderCapacity?: number })?.renderCapacity
      if (typeof load === 'number' && Number.isFinite(load)) this.notifyLoad(Math.min(1, Math.max(0, load)))
    }
    rc.onupdate = this.renderCapacityHandler
    try {
      rc.start({ updateInterval: 1 })
    } catch {
      // start can throw if already running / unsupported args; ignore.
    }
  }

  private stopRenderCapacity(): void {
    if (this.renderCapacity) {
      try {
        this.renderCapacity.onupdate = null
        this.renderCapacity.stop()
      } catch {
        // best-effort teardown
      }
    }
    this.renderCapacity = null
    this.renderCapacityHandler = null
  }

  private post(message: MainToWorkletMessage, transfer?: Transferable[]): void {
    if (!this.node) return
    if (transfer) this.node.port.postMessage(message, transfer)
    else this.node.port.postMessage(message)
  }

  setPatch(patch: MvoxPatch): void {
    this.patch = sanitizePatch(patch)
    // The limiter is a native node outside the worklet, so its patch param must
    // be applied here — otherwise fx.limiterCeiling is dead.
    const ceilingDb = this.patch.fx.limiterCeiling
    if (this.limiter) this.limiter.threshold.value = ceilingDb
    // Rebuild the brickwall curve only when the ceiling actually moves — building
    // a 2049-point table on every knob turn would be needless work.
    if (this.ceilingShaper && ceilingDb !== this.lastCeilingDb) {
      this.ceilingShaper.curve = buildLimiterCurve(ceilingDb)
      this.lastCeilingDb = ceilingDb
    }
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
  async enableMic(deviceId?: string): Promise<boolean> {
    if (!this.context || !this.node) return false
    // Already active: a second enable would overwrite micStream/micSource and leak
    // the first source (still connected, tracks never stopped) (H4).
    if (this.micStream) return true
    const generation = ++this.liveInputGeneration
    // Prefer an explicit id, else the remembered preference; `exact` so a vanished
    // device fails cleanly (→ demo voice) rather than silently picking another.
    const wantId = deviceId ?? this.preferredInputId ?? undefined
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
          ...(wantId ? { deviceId: { exact: wantId } } : {}),
        },
      })
    } catch {
      // Permission denied / no device: honour the boolean contract, leave no state (M7).
      return false
    }
    // A newer enable/disable call superseded this one while awaiting permission.
    if (generation !== this.liveInputGeneration) {
      for (const track of stream.getTracks()) track.stop()
      return false
    }
    const track = stream.getAudioTracks()[0]
    if (track && 'contentHint' in track) track.contentHint = 'music'
    // Device disconnected/lost: drop back to the demo voice. disableMic() posts
    // use-live-input:false and notifies mic listeners so the UI stops showing "Mic on".
    track?.addEventListener('ended', () => {
      this.disableMic()
    })

    const source = this.context.createMediaStreamSource(stream)
    source.connect(this.node)
    this.micStream = stream
    this.micSource = source
    // Remember which device is actually live (from the granted track) so the UI can
    // reflect the real input, and store stable ids only.
    const settings = track?.getSettings?.()
    this.currentInputId = settings?.deviceId ?? wantId ?? null
    this.post({ type: 'use-live-input', live: true })
    this.notifyMic(true)
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
    this.currentInputId = null
    this.post({ type: 'use-live-input', live: false })
    this.notifyMic(false)
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000
  }

  get isRecording(): boolean {
    return this.recording
  }

  /** True once a capture hit MAX_RECORD_SECONDS and auto-stopped (buffer preserved). */
  get recordingLimitReached(): boolean {
    return this.recCapped
  }

  startRecording(): void {
    if (!this.recorderNode || this.recording) return
    this.recChunks = []
    this.recTotalSamples = 0
    this.recCapped = false
    this.recording = true
    this.recorderNode.port.postMessage({ type: 'start' })
    this.notifyRecord()
  }

  /** Stop recording and return the capture as a 16-bit WAV Blob (null if empty). */
  async stopRecording(): Promise<Blob | null> {
    if (!this.recorderNode || !this.recording) return null
    this.recording = false
    this.recCapped = false
    this.notifyRecord()
    // Handshake: wait for the worklet's 'stopped' ack so chunks still queued on
    // the MessagePort are appended before we assemble — otherwise the final render
    // quanta are dropped by the chunk gate (M9). Timeout so a closed/dead context
    // can't hang the caller; we still assemble whatever arrived.
    await withTimeout(
      new Promise<void>((resolve) => {
        this.recStopResolve = resolve
        this.recorderNode?.port.postMessage({ type: 'stop' })
      }),
      START_TIMEOUT_MS,
      'Timed out stopping the recorder.',
    ).catch(() => {
      this.recStopResolve = null
    })
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
    this.stopRenderCapacity()
    this.node?.disconnect()
    this.master?.disconnect()
    this.limiter?.disconnect()
    this.ceilingShaper?.disconnect()
    this.recorderNode?.disconnect()

    const context = this.context
    // Null the context synchronously (before awaiting close) so an in-flight
    // runStart bails at its next await instead of building on a dead context (M12).
    this.context = null
    this.node = null
    this.master = null
    this.limiter = null
    this.ceilingShaper = null
    this.lastCeilingDb = Number.NaN
    this.recorderNode = null
    this.recording = false
    this.recChunks = []
    this.recSampleRate = 48000
    this.recTotalSamples = 0
    this.recCapped = false
    // Unblock any pending stopRecording() handshake so its promise can't hang.
    const stopResolve = this.recStopResolve
    this.recStopResolve = null
    stopResolve?.()
    this.startPromise = null

    // Emit idle BEFORE clearing listeners so subscribers observe the transition (M8).
    this.setStatus('idle')
    this.telemetryListeners.clear()
    this.statusListeners.clear()
    this.micListeners.clear()
    this.suspendListeners.clear()
    this.recordListeners.clear()
    this.loadListeners.clear()

    await context?.close()
  }
}

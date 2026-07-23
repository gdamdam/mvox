// Lifecycle + recorder-cap + true-limiter coverage for AudioEngine. The engine
// touches Web Audio, which the `node` test environment lacks, so we stub a
// minimal graph: enough nodes to let start() build the chain and enough of the
// recorder MessagePort to drive the auto-stop cap deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine, MAX_RECORD_SECONDS, type RecordState } from './AudioEngine'

// Vite resolves the `?worker&url` worklet imports to URL strings under vitest, so
// AudioEngine's module-level imports don't need stubbing — only the runtime nodes.

interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage: (msg: unknown, transfer?: unknown) => void
}

function makePort(): FakePort {
  return { onmessage: null, postMessage: vi.fn() }
}

// Track the created worklet nodes so a test can reach the recorder's port.
const created: { name: string; port: FakePort }[] = []

class FakeAudioWorkletNode {
  port = makePort()
  constructor(_ctx: unknown, public name: string) {
    created.push({ name, port: this.port })
  }
  connect() {}
  disconnect() {}
}

function makeParam() {
  return { value: 0 }
}

// Captures the most recent AudioContext constructor options (for quality tests).
let lastCtorOptions: { latencyHint?: string } | undefined

// A minimal renderCapacity stub whose update handler a test can fire.
function makeRenderCapacity() {
  return {
    onupdate: null as ((e: unknown) => void) | null,
    start: vi.fn(),
    stop: vi.fn(),
    fire(load: number) {
      this.onupdate?.({ renderCapacity: load })
    },
  }
}

class FakeContext {
  state = 'suspended'
  sampleRate = 48000
  baseLatency = 0.005
  outputLatency = 0.011
  destination = {}
  onstatechange: (() => void) | null = null
  audioWorklet = { addModule: vi.fn(async () => {}) }
  // Backing field; exposed via a prototype getter so feature detection
  // (`'renderCapacity' in AudioContext.prototype`) sees it, like a real browser.
  _rc = makeRenderCapacity()
  constructor(opts?: { latencyHint?: string }) {
    lastCtorOptions = opts
  }
  get renderCapacity() {
    return this._rc
  }
  // A prototype method (not an instance field) so `'setSinkId' in prototype` holds.
  setSinkId(): Promise<void> {
    return Promise.resolve()
  }
  async resume() {
    this.state = 'running'
  }
  async close() {
    this.state = 'closed'
  }
  createGain() {
    return { gain: makeParam(), connect() {}, disconnect() {} }
  }
  createDynamicsCompressor() {
    return {
      threshold: makeParam(),
      knee: makeParam(),
      ratio: makeParam(),
      attack: makeParam(),
      release: makeParam(),
      connect() {},
      disconnect() {},
    }
  }
  createWaveShaper() {
    return { curve: null as Float32Array | null, oversample: 'none', connect() {}, disconnect() {} }
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
}

let lastGetUserMediaConstraints: { audio?: { deviceId?: { exact?: string } } } | undefined

function fakeStream() {
  const track = {
    contentHint: '',
    addEventListener: vi.fn(),
    getSettings: () => ({ deviceId: 'mic-1' }),
    stop: vi.fn(),
  }
  return { getAudioTracks: () => [track], getTracks: () => [track] }
}

beforeEach(() => {
  created.length = 0
  lastCtorOptions = undefined
  lastGetUserMediaConstraints = undefined
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async (c: { audio?: { deviceId?: { exact?: string } } }) => {
        lastGetUserMediaConstraints = c
        return fakeStream()
      }),
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in Mic' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'USB Mic' },
        { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Camera' },
      ]),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The engine holds its live context privately; read it for context-state asserts. */
function engineContext(engine: AudioEngine): FakeContext {
  return (engine as unknown as { context: FakeContext }).context
}

/** The recorder is the second worklet node created in runStart. */
function recorderPort(): FakePort {
  const rec = created.find((c) => c.name === 'mvox-recorder')
  if (!rec) throw new Error('recorder node not created')
  return rec.port
}

describe('AudioEngine lifecycle', () => {
  it('starts, reaching running with a graph built', async () => {
    const engine = new AudioEngine()
    await engine.start()
    expect(engine.getStatus()).toBe('running')
    // Both worklets were added + instantiated.
    expect(created.map((c) => c.name).sort()).toEqual(['mvox-engine', 'mvox-recorder'])
  })

  it('rebuilds the ceiling curve only when limiterCeiling changes', async () => {
    const engine = new AudioEngine()
    await engine.start()
    const shaper = (engine as unknown as { ceilingShaper: { curve: Float32Array | null } }).ceilingShaper
    const first = shaper.curve
    expect(first).toBeInstanceOf(Float32Array)
    // Same ceiling → same curve reference (no rebuild).
    engine.setPatch({ ...structuredClonePatch(engine) })
    expect(shaper.curve).toBe(first)
    // Changed ceiling → new curve.
    const patch = structuredClonePatch(engine)
    patch.fx.limiterCeiling = -6
    engine.setPatch(patch)
    expect(shaper.curve).not.toBe(first)
  })

  it('disposes cleanly, closing the context and going idle', async () => {
    const engine = new AudioEngine()
    await engine.start()
    const ctx = engineContext(engine)
    await engine.dispose()
    expect(engine.getStatus()).toBe('idle')
    expect(ctx.state).toBe('closed')
  })
})

describe('AudioEngine recorder cap', () => {
  it('notifies with capped=true and preserves the buffered audio', async () => {
    const engine = new AudioEngine()
    await engine.start()
    const states: RecordState[] = []
    engine.onRecord((s) => states.push({ ...s }))
    const port = recorderPort()

    engine.startRecording()
    expect(states.at(-1)).toEqual({ recording: true, capped: false })

    // Drive the recorder port: a tiny sample rate makes the cap threshold small,
    // so one oversized chunk trips it deterministically.
    port.onmessage?.({ data: { type: 'started', sampleRate: 1 } })
    const capSamples = MAX_RECORD_SECONDS // = MAX_RECORD_SECONDS * 1
    const left = new Float32Array(capSamples).fill(0.5)
    const right = new Float32Array(capSamples).fill(0.5)
    port.onmessage?.({ data: { type: 'chunk', left, right } })

    // The cap fired: capped=true, still "recording" (buffer intact until finalize).
    expect(states.at(-1)).toEqual({ recording: true, capped: true })

    // Finalize: the handshake needs a 'stopped' ack, which the worklet would send.
    const blobPromise = engine.stopRecording()
    port.onmessage?.({ data: { type: 'stopped' } })
    const blob = await blobPromise
    expect(blob).not.toBeNull()
    expect(blob!.size).toBeGreaterThan(0)
    // Finalizing clears the capped flag.
    expect(states.at(-1)).toEqual({ recording: false, capped: false })
  })
})

describe('AudioEngine device / latency / quality', () => {
  it('reports latency + capability info from the live context', async () => {
    const engine = new AudioEngine()
    await engine.start()
    const info = engine.getInfo()
    expect(info.sampleRate).toBe(48000)
    expect(info.baseLatency).toBeCloseTo(0.005, 5)
    expect(info.outputLatency).toBeCloseTo(0.011, 5)
    expect(info.outputSelectionSupported).toBe(true) // FakeContext.prototype has setSinkId
    expect(info.loadMetricSupported).toBe(true) // and a renderCapacity getter
  })

  it('reports capabilities false on a bare context', () => {
    // A context whose prototype has neither setSinkId nor renderCapacity.
    class BareContext {}
    vi.stubGlobal('AudioContext', BareContext)
    const info = new AudioEngine().getInfo()
    expect(info.outputSelectionSupported).toBe(false)
    expect(info.loadMetricSupported).toBe(false)
  })

  it('maps the quality mode to the context latency hint', async () => {
    const normal = new AudioEngine()
    await normal.start()
    expect(lastCtorOptions?.latencyHint).toBe('interactive')
    await normal.dispose()

    const safe = new AudioEngine()
    safe.setQuality('safe')
    await safe.start()
    expect(lastCtorOptions?.latencyHint).toBe('playback')
  })

  it('enumerates audio devices (excludes video)', async () => {
    const engine = new AudioEngine()
    const list = await engine.listDevices()
    expect(list.inputs.map((d) => d.id)).toEqual(['mic-1', 'mic-2'])
    expect(list.outputs.map((d) => d.id)).toEqual(['spk-1'])
  })

  it('routes output via setSinkId when supported', async () => {
    const engine = new AudioEngine()
    await engine.start()
    expect(await engine.setOutputDevice('spk-1')).toBe(true)
  })

  it('passes an explicit input device id to getUserMedia', async () => {
    const engine = new AudioEngine()
    await engine.start()
    await engine.enableMic('mic-2')
    expect(lastGetUserMediaConstraints?.audio?.deviceId?.exact).toBe('mic-2')
    expect(engine.getCurrentInputId()).toBe('mic-1') // from the granted track's settings
  })

  it('remembers an input preference when the mic is off', async () => {
    const engine = new AudioEngine()
    await engine.start()
    expect(await engine.setInputDevice('mic-2')).toBe(true) // stored, applied on next enable
  })

  it('emits render load from renderCapacity updates', async () => {
    const engine = new AudioEngine()
    await engine.start()
    const loads: number[] = []
    engine.onLoad((l) => loads.push(l))
    const ctx = engineContext(engine) as unknown as { _rc: { fire: (n: number) => void } }
    ctx._rc.fire(0.42)
    ctx._rc.fire(1.5) // clamped
    expect(loads).toEqual([0.42, 1])
  })
})

// The engine sanitizes and stores the patch internally; read it back to mutate a
// single field for the setPatch tests without reconstructing the whole shape.
function structuredClonePatch(engine: AudioEngine) {
  const patch = (engine as unknown as { patch: import('./contracts').MvoxPatch }).patch
  return structuredClone(patch)
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MidiRouter } from './router'
import type { MidiEvent } from './parse'

// ── Minimal Web MIDI fake ────────────────────────────────────────────────────
// A structural stand-in for the browser's MIDIAccess/MIDIInput objects, driven
// synchronously so we can inject bytes and simulate hot-plug from a node test.

interface Msg {
  data: Uint8Array | null
}

class FakeInput {
  onmidimessage: ((event: Msg) => void) | null = null
  constructor(
    public readonly id: string,
    public readonly name = 'Fake',
    public state = 'connected',
  ) {}
  /** Deliver raw bytes as if the device sent a MIDI message. */
  send(bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) })
  }
}

class FakeInputMap {
  readonly map = new Map<string, FakeInput>()
  forEach(cb: (value: FakeInput) => void): void {
    this.map.forEach(cb)
  }
  get(id: string): FakeInput | undefined {
    return this.map.get(id)
  }
}

class FakeAccess {
  readonly inputs = new FakeInputMap()
  onstatechange: ((event: unknown) => void) | null = null
  emitStateChange(): void {
    this.onstatechange?.({})
  }
}

function stubMidi(access: FakeAccess): void {
  vi.stubGlobal('navigator', {
    requestMIDIAccess: vi.fn(async () => access),
  })
}

const NOTE_ON = 0x90
const NOTE_OFF = 0x80
const CONTROL_CHANGE = 0xb0
const CC_SUSTAIN = 64

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MidiRouter', () => {
  let access: FakeAccess
  let input: FakeInput

  beforeEach(() => {
    access = new FakeAccess()
    input = new FakeInput('in-1', 'Keystation')
    access.inputs.map.set(input.id, input)
    stubMidi(access)
  })

  it('init() opens connected inputs and routes note events to subscribers', async () => {
    const router = new MidiRouter()
    const events: MidiEvent[] = []
    router.onNote((e) => events.push(e))

    expect(await router.init()).toBe(true)
    // Assigning onmidimessage is how the router opens a port.
    expect(input.onmidimessage).not.toBeNull()

    input.send([NOTE_ON, 60, 100])
    input.send([NOTE_OFF, 60, 0])
    expect(events).toEqual([
      { type: 'noteon', note: 60, velocity: 100 / 127 },
      { type: 'noteoff', note: 60 },
    ])
  })

  it('synthesizes note-offs for held notes when switching inputs (M6)', async () => {
    const other = new FakeInput('in-2', 'Launchkey')
    access.inputs.map.set(other.id, other)
    const router = new MidiRouter()
    const events: MidiEvent[] = []
    router.onNote((e) => events.push(e))
    await router.init()

    input.send([NOTE_ON, 64, 90]) // held on in-1
    events.length = 0

    router.selectInput('in-2')
    expect(events).toEqual([{ type: 'noteoff', note: 64 }])
  })

  it('synthesizes note-offs when a held input is hot-unplugged (M6)', async () => {
    const router = new MidiRouter()
    const events: MidiEvent[] = []
    router.onNote((e) => events.push(e))
    await router.init()

    input.send([NOTE_ON, 67, 80])
    input.send([NOTE_ON, 72, 80])
    events.length = 0

    // Device vanishes: drop it from the map and fire statechange.
    access.inputs.map.delete('in-1')
    access.emitStateChange()

    expect(events).toContainEqual({ type: 'noteoff', note: 67 })
    expect(events).toContainEqual({ type: 'noteoff', note: 72 })
  })

  it('does not re-fire note-offs for notes already released (M6)', async () => {
    const router = new MidiRouter()
    const events: MidiEvent[] = []
    router.onNote((e) => events.push(e))
    await router.init()

    input.send([NOTE_ON, 60, 100])
    input.send([NOTE_OFF, 60, 0]) // released cleanly before dispose
    events.length = 0

    router.dispose()
    expect(events).toEqual([]) // nothing held → no synthetic offs
  })

  it('releases held notes to subscribers on dispose (M6)', async () => {
    const router = new MidiRouter()
    const events: MidiEvent[] = []
    router.onNote((e) => events.push(e))
    await router.init()

    input.send([NOTE_ON, 55, 100])
    events.length = 0

    router.dispose()
    expect(events).toEqual([{ type: 'noteoff', note: 55 }])
  })

  it('lifts a held sustain pedal BEFORE flushing notes on hot-unplug', async () => {
    // With the pedal down, a subscriber defers note-offs until pedal-up. If the
    // device vanishes it can never send pedal-up, so the router must synthesize
    // one — and emit it before the note-offs so the deferral clears first.
    const router = new MidiRouter()
    const events: MidiEvent[] = []
    router.onNote((e) => events.push(e))
    await router.init()

    input.send([NOTE_ON, 60, 100])
    input.send([CONTROL_CHANGE, CC_SUSTAIN, 127]) // pedal down
    events.length = 0

    access.inputs.map.delete('in-1')
    access.emitStateChange()

    expect(events).toEqual([
      { type: 'sustain', on: false },
      { type: 'noteoff', note: 60 },
    ])
  })

  it('lifts a held sustain pedal on dispose even with no notes still held', async () => {
    // Key released while sustained: activeNotes is already empty, but the
    // subscriber is still holding that note. The synthetic pedal-up is what
    // releases it, so it must fire regardless of activeNotes being empty.
    const router = new MidiRouter()
    const events: MidiEvent[] = []
    router.onNote((e) => events.push(e))
    await router.init()

    input.send([CONTROL_CHANGE, CC_SUSTAIN, 127]) // pedal down
    input.send([NOTE_ON, 62, 90])
    input.send([NOTE_OFF, 62, 0]) // released while sustained
    events.length = 0

    router.dispose()
    expect(events).toEqual([{ type: 'sustain', on: false }])
  })

  it('a disposed router does not re-open — a fresh one must be created (M4)', async () => {
    const router = new MidiRouter()
    await router.init()
    router.dispose()

    // Re-init on the disposed instance is a no-op: this is why the App builds a
    // fresh router on re-enable rather than reusing the old one.
    expect(await router.init()).toBe(false)

    // A brand-new router initializes normally against the same access.
    const fresh = new MidiRouter()
    expect(await fresh.init()).toBe(true)
  })

  it('init() resolves false (never throws) when Web MIDI is unsupported', async () => {
    vi.stubGlobal('navigator', {})
    const router = new MidiRouter()
    expect(await router.init()).toBe(false)
  })
})

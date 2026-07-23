// Web MIDI INPUT router for mvox. No MIDI out.
//
// Input hot-plug / cleanup handling is adapted from mchord's src/midi/router.ts,
// stripped to the input-only concern: enumerate inputs, open the selected one
// (or all), decode inbound bytes, and fan note events out to subscribers.
//
// Design notes:
//   * MIDI is never required: init() resolves false (never throws) when Web MIDI
//     is unsupported or permission is denied.
//   * We open a port by assigning `input.onmidimessage` (NOT addEventListener):
//     Chrome opens the port implicitly on assignment and only delivers messages
//     from an open port (per the Web MIDI spec).
//   * `statechange` re-reconciles inputs so hot-plugged devices become audible
//     and vanished ones drop their zombie handlers.

import { parseMidi, type MidiEvent } from './parse'

// ── Minimal structural Web MIDI shapes ──────────────────────────────────────
// We depend on a structural subset rather than the global DOM MIDI types so the
// router compiles in a `node` test environment and can be driven by a fake.

/** The subset of MIDIInput we use. */
interface MidiInputPort {
  readonly id: string
  readonly name?: string | null
  readonly state?: string
  onmidimessage: ((event: { data: Uint8Array | null }) => void) | null
}

/** Iterable Map-like port collection, as the spec exposes (a MIDIInputMap). */
interface PortMap<T> {
  forEach(cb: (value: T) => void): void
  get(id: string): T | undefined
}

/** The subset of MIDIAccess we use. */
interface MidiAccessLike {
  readonly inputs: PortMap<MidiInputPort>
  onstatechange: ((event: unknown) => void) | null
}

// Web MIDI's requestMIDIAccess is not in every TS DOM lib target; declare the
// structural signature we call so the router type-checks without lib bumps.
interface MidiAccessRequester {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>
}

export interface MidiInputInfo {
  id: string
  name: string
}

type NoteCb = (event: MidiEvent) => void

/**
 * Top-level MIDI input manager: requests access, enumerates inputs, opens the
 * selected input (or all), routes inbound messages to note subscribers, and
 * handles hot-plug. Never throws into the UI.
 */
export class MidiRouter {
  private access: MidiAccessLike | null = null
  private disposed = false

  // null = listen to ALL inputs; a string = listen to just that input id.
  private selectedInputId: string | null = null

  // null = accept ALL channels; 0..15 = only events on that channel. Applied
  // after parsing in handleInputData; 'other' events (no channel) never pass.
  private selectedChannel: number | null = null

  // inputId -> attached handler (so we can detach exactly what we attached).
  private readonly inputHandlers = new Map<string, (event: { data: Uint8Array | null }) => void>()

  private readonly noteCbs = new Set<NoteCb>()

  // Note numbers currently held down (across whichever input is open). Used to
  // synthesize note-offs when the source drops out from under a held key —
  // input switch, hot-unplug, or dispose — so nothing sticks on (M6).
  private readonly activeNotes = new Set<number>()

  // Whether the sustain (damper) pedal is currently down on the open input. When
  // the source drops out (switch / unplug / dispose) the physical pedal can no
  // longer send its pedal-up, so we synthesize one — otherwise a subscriber that
  // defers note-offs while sustained (see App.setSustain) never releases them
  // and the note hangs even though we flushed activeNotes.
  private sustainOn = false

  /** True when Web MIDI is reachable in this environment. */
  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof (navigator as MidiAccessRequester).requestMIDIAccess === 'function'
    )
  }

  /**
   * Request MIDI access. Resolves true on success, false (never throws) when
   * unsupported or permission denied — MIDI is always optional.
   */
  async init(): Promise<boolean> {
    if (this.access) return true
    if (!MidiRouter.isSupported()) return false
    let access: MidiAccessLike
    try {
      // sysex:false — never needed, and avoids an extra permission prompt.
      const request = (navigator as MidiAccessRequester).requestMIDIAccess!
      access = await request({ sysex: false })
    } catch {
      return false
    }
    // React StrictMode mount→unmount→mount: bail if disposed mid-request.
    if (this.disposed) return false
    this.access = access
    access.onstatechange = () => this.handleStateChange()
    this.reconcileInputs()
    return true
  }

  /** Subscribe to decoded note events. Returns an unsubscribe function. */
  onNote(fn: NoteCb): () => void {
    this.noteCbs.add(fn)
    return () => {
      this.noteCbs.delete(fn)
    }
  }

  listInputs(): MidiInputInfo[] {
    if (!this.access) return []
    const out: MidiInputInfo[] = []
    this.access.inputs.forEach((p) => out.push({ id: p.id, name: p.name ?? 'Unknown' }))
    return out
  }

  /** Select an input by id, or null to listen to all inputs. */
  selectInput(id: string | null): void {
    if (id === this.selectedInputId) return
    // The outgoing input can't send note-offs for keys held during the switch.
    this.flushActiveNotes()
    this.selectedInputId = id
    this.reconcileInputs()
  }

  /**
   * Restrict routing to a single MIDI channel (0..15), or null for all
   * channels. Flushes held notes on change — a note held on the old channel can
   * no longer be released once its channel is filtered out, so synthesize its
   * note-off (same reasoning as selectInput).
   */
  setChannel(ch: number | null): void {
    if (ch === this.selectedChannel) return
    this.flushActiveNotes()
    this.selectedChannel = ch
  }

  // ── Input routing ───────────────────────────────────────────────────────────

  private reconcileInputs(): void {
    this.detachInputs()
    if (!this.access) return
    this.access.inputs.forEach((input) => {
      // null selection means "all inputs"; otherwise match the chosen id.
      if (this.selectedInputId !== null && input.id !== this.selectedInputId) return
      if (input.state !== undefined && input.state !== 'connected') return
      const handler = (event: { data: Uint8Array | null }): void => {
        if (event.data) this.handleInputData(event.data)
      }
      // Assigning `onmidimessage` (not addEventListener) implicitly OPENS the
      // port — Chrome only delivers from an open port (per Web MIDI spec).
      input.onmidimessage = handler
      this.inputHandlers.set(input.id, handler)
    })
  }

  private detachInputs(): void {
    if (this.access) {
      this.access.inputs.forEach((input) => {
        if (this.inputHandlers.has(input.id)) input.onmidimessage = null
      })
    }
    this.inputHandlers.clear()
  }

  /** Decode an inbound buffer and fan it out to listeners. */
  private handleInputData(data: Uint8Array | number[]): void {
    const event = parseMidi(data)
    // Silently drop undecodable traffic (no channel to filter or fan on).
    if (event.type === 'other') return
    // Per-channel filter: with a channel selected, drop everything on any other
    // channel before it can be tracked or fanned out.
    if (this.selectedChannel !== null && event.channel !== this.selectedChannel) return
    // Track held notes so we can release them if the input vanishes mid-hold.
    // Only note events touch that tracking; CC/bend/pressure just flow through.
    if (event.type === 'noteon') this.activeNotes.add(event.note)
    else if (event.type === 'noteoff') this.activeNotes.delete(event.note)
    else if (event.type === 'sustain') this.sustainOn = event.on
    for (const cb of this.noteCbs) cb(event)
  }

  /**
   * Release everything the source can no longer release when it drops out from
   * under a held key (input switch, hot-unplug, dispose). Lift a held sustain
   * pedal FIRST — so a subscriber deferring note-offs while sustained clears that
   * state before the note-offs land — then synthesize a note-off per held note.
   */
  private flushActiveNotes(): void {
    // Synthetic releases carry channel 0: activeNotes tracks bare note numbers
    // (no per-note channel), and a subscriber acts on the note regardless.
    if (this.sustainOn) {
      this.sustainOn = false
      for (const cb of this.noteCbs) cb({ type: 'sustain', on: false, channel: 0 })
    }
    if (this.activeNotes.size === 0) return
    for (const note of this.activeNotes) {
      for (const cb of this.noteCbs) cb({ type: 'noteoff', note, channel: 0 })
    }
    this.activeNotes.clear()
  }

  // ── Hot-plug ────────────────────────────────────────────────────────────────

  private handleStateChange(): void {
    if (!this.access) return
    // Drop handlers for inputs that vanished so they aren't zombies, then
    // re-reconcile: newly connected inputs become audible, and a re-connected
    // selected input is re-opened.
    const present = new Set<string>()
    this.access.inputs.forEach((i) => {
      if (i.state === undefined || i.state === 'connected') present.add(i.id)
    })
    let vanished = false
    for (const id of [...this.inputHandlers.keys()]) {
      if (!present.has(id)) {
        this.inputHandlers.delete(id)
        vanished = true
      }
    }
    // An input we were listening to unplugged while a key was down can't send
    // its note-offs; synthesize them so the held note doesn't stick (M6).
    if (vanished) this.flushActiveNotes()
    this.reconcileInputs()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  dispose(): void {
    this.disposed = true
    // Release held notes to subscribers before we drop them, so tearing MIDI
    // down doesn't leave a note stuck on in the engine (M6).
    this.flushActiveNotes()
    this.detachInputs()
    if (this.access) this.access.onstatechange = null
    this.noteCbs.clear()
    this.access = null
  }
}

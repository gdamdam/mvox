import './styles.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ENGINE_MODES,
  RANGES,
  sanitizePatch,
  type EngineMode,
  type MvoxPatch,
} from './audio/contracts'
import { MODES, NOTE_NAMES, hzToMidi, type Mode } from './audio/dsp/scale'
import { applyPerformance, MACROS, XY } from './performance/macros'
import { patchFromUrl } from './sharing/codec'
import {
  loadSession,
  saveSession,
  SESSION_VERSION,
  type PerformanceState,
  type PerfSnapshot,
  type SessionSnapshot,
} from './persistence/session'
import { loadSlots, saveSlots, SLOT_COUNT, type SlotBank } from './persistence/slots'
import { PerformanceSlots } from './components/PerformanceSlots'
import { DeviceControls } from './components/DeviceControls'
import { PerformanceMode } from './components/PerformanceMode'
import type { DeviceList, QualityMode } from './audio/AudioEngine'
import { MidiRouter } from './midi/router'
import type { MidiEvent } from './midi/parse'
import {
  addMapping,
  findBySource,
  isContinuousTarget,
  removeMappingForTarget,
  sourceFromEvent,
  sourceKey,
  type MidiMapping,
  type MappingTarget,
} from './midi/mapping'
import { MidiLearnPanel } from './components/MidiLearnPanel'
import { useEngine } from './ui/useEngine'
import { useKeyboard } from './ui/useKeyboard'
import { Knob, Meter, Select, XYPad } from './components/controls'
import { FxControls, ModeControls } from './components/ModeControls'
import { TuningControls } from './components/TuningControls'
import { Keyboard } from './components/Keyboard'
import { PresetBar } from './components/PresetBar'
import { InputTrackingControls } from './components/InputTrackingControls'

const MODE_LABELS: Record<EngineMode, string> = {
  vocoder: 'VOCODER',
  harmony: 'HARMONY',
  formant: 'FORMANT',
  follow: 'FOLLOW',
}

// One-line orientation per mode so a first-time visitor doesn't have to guess.
const MODE_DESCRIPTIONS: Record<EngineMode, string> = {
  vocoder: 'Your voice shapes a synth carrier — hold notes to make it talk.',
  harmony: 'Harmony voices are layered onto whatever you sing.',
  formant: 'Reshapes your voice: pitch/size shift, robot, whisper, ring mod.',
  follow: 'A synth glides along with the pitch you sing or hum.',
}

const scaleOptions = MODES.map((m) => ({ value: m, label: m }))
const rootOptions = NOTE_NAMES.map((n, i) => ({ value: String(i), label: n }))

// Hz → e.g. "A4" for the pitch/target readout. Uses the same note spelling as the
// keyboard labels. '—' when there's no pitch.
function hzToNoteName(hz: number): string {
  if (!(hz > 0)) return '—'
  const midi = Math.round(hzToMidi(hz))
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

interface InitialState {
  patch: MvoxPatch
  perf: PerformanceState
  recovery: 'reset-corrupt' | 'reset-future' | null
}

// Restore where the user left off. A share link in the URL wins for the SOUND
// patch (that's what a link carries); performance state (BPM, latch) is always
// local, so it comes from the stored session regardless. With no link, the whole
// last session is restored. A corrupt/future stored session surfaces a recovery
// notice rather than a silent wipe.
function restoreInitial(): InitialState {
  const shared = patchFromUrl(window.location.hash)
  const { session, status } = loadSession()
  return {
    patch: shared ?? session.patch,
    perf: session.performance,
    recovery: !shared && (status === 'reset-corrupt' || status === 'reset-future') ? status : null,
  }
}

const RECOVERY_MESSAGE: Record<'reset-corrupt' | 'reset-future', string> = {
  'reset-corrupt': 'Your last session couldn’t be read and was reset to defaults.',
  'reset-future': 'Your last session was saved by a newer version of mvox; it was backed up and defaults were loaded.',
}

export default function App() {
  const engine = useEngine()
  // Restore once, before first paint. A lazy useState initializer runs exactly
  // once and its value is safe to read during render (unlike a ref).
  const [init] = useState<InitialState>(restoreInitial)
  const [patch, setPatchState] = useState<MvoxPatch>(init.patch)
  const [tempo, setTempo] = useState(init.perf.bpm)
  const [sessionNotice, setSessionNotice] = useState<string | null>(
    init.recovery ? RECOVERY_MESSAGE[init.recovery] : null,
  )
  // Editable BPM text kept separate from the committed numeric tempo so an empty
  // or mid-edit field isn't snapped to a fallback while typing (L8).
  const [tempoText, setTempoText] = useState(String(tempo))
  const [activeNotes, setActiveNotes] = useState<Set<number>>(() => new Set())
  const [showMicWarn, setShowMicWarn] = useState(false)
  const [micDenied, setMicDenied] = useState(false)
  const [midiOn, setMidiOn] = useState(false)
  const midiRef = useRef<MidiRouter | null>(null)
  const micWarnRef = useRef<HTMLDivElement | null>(null)
  const micTriggerRef = useRef<HTMLElement | null>(null)
  // Guards a MIDI toggle whose init() is still awaiting so two quick taps can't
  // both register a note subscriber (M5); the unsubscribe is kept to release it.
  const midiInFlight = useRef(false)
  const midiUnsub = useRef<(() => void) | null>(null)

  const update = useCallback((mut: (p: MvoxPatch) => void) => {
    setPatchState((prev) => {
      const next = structuredClone(prev)
      mut(next)
      return sanitizePatch(next)
    })
  }, [])

  // The effective patch folds macro + XY performance state into the base patch.
  const effective = useMemo(() => applyPerformance(patch), [patch])

  // Push the effective patch to the engine whenever it changes and audio runs.
  // Destructure the stable engine methods (not the engine object, whose identity
  // changes every render as telemetry re-renders fire) so these effects re-run
  // only when effective/tempo actually change — not ~60x/sec while running.
  const {
    status: engineStatus,
    setPatch: engineSetPatch,
    setTempo: engineSetTempo,
    setQuality: engineSetQuality,
    setInputDevice: engineSetInputDevice,
    setOutputDevice: engineSetOutputDevice,
    listDevices: engineListDevices,
  } = engine
  useEffect(() => {
    if (engineStatus === 'running') engineSetPatch(effective)
  }, [effective, engineStatus, engineSetPatch])

  useEffect(() => {
    if (engineStatus === 'running') engineSetTempo(tempo)
  }, [tempo, engineStatus, engineSetTempo])

  // Mirror committed tempo into the edit field (e.g. after a preset load resets
  // it) without clobbering what the user is mid-typing — tempo only changes on
  // commit, so this only re-syncs when the committed value actually changes.
  // Adjust-state-during-render (React's endorsed pattern) rather than an effect,
  // so it commits before paint with no cascading render.
  const [lastTempo, setLastTempo] = useState(tempo)
  if (tempo !== lastTempo) {
    setLastTempo(tempo)
    setTempoText(String(tempo))
  }

  const commitTempo = useCallback(() => {
    const n = Math.round(Number(tempoText))
    const next = Number.isFinite(n) && n > 0 ? Math.min(300, Math.max(40, n)) : tempo
    setTempo(next)
    setTempoText(String(next))
  }, [tempoText, tempo])

  // Hands-free hold state. Refs (not state) so the note callbacks stay identity-
  // stable and always read the current hold mode without re-subscribing the
  // keyboard/MIDI; `latch` mirrors latchRef into state only for the button UI.
  const [latch, setLatch] = useState(init.perf.latch)
  const heldRef = useRef<Set<number>>(new Set())
  const latchRef = useRef(init.perf.latch)
  const sustainRef = useRef(false)
  const sustainedRef = useRef<Set<number>>(new Set())

  // --- MIDI learn state ------------------------------------------------------
  const [midiMappings, setMidiMappings] = useState<MidiMapping[]>(init.perf.midiMappings)
  const [midiInputId, setMidiInputId] = useState<string | null>(init.perf.midiInputId)
  const [midiChannel, setMidiChannel] = useState<number | null>(init.perf.midiChannel)
  const [midiInputs, setMidiInputs] = useState<{ id: string; name: string }[]>([])
  const [learnTarget, setLearnTarget] = useState<MappingTarget | null>(null)
  // Refs so the single stable MIDI callback reads the CURRENT mappings/learn state
  // without re-subscribing (a re-subscribe per mapping edit risks duplicate
  // handlers / hung notes). Written in effects, never during render.
  const midiMappingsRef = useRef(midiMappings)
  useEffect(() => { midiMappingsRef.current = midiMappings }, [midiMappings])
  const learnTargetRef = useRef<MappingTarget | null>(learnTarget)
  useEffect(() => { learnTargetRef.current = learnTarget }, [learnTarget])
  // Last value per source, for rising-edge detection on trigger targets.
  const lastCcValueRef = useRef<Map<string, number>>(new Map())

  // --- Audio device + quality (device-specific; persisted, not in portable presets)
  const [quality, setQualityPref] = useState<QualityMode>(init.perf.quality)
  const [audioInputId, setAudioInputId] = useState<string | null>(init.perf.audioInputId)
  const [audioOutputId, setAudioOutputId] = useState<string | null>(init.perf.audioOutputId)
  const [devices, setDevices] = useState<DeviceList>({ inputs: [], outputs: [] })
  // The router subscribes a stable wrapper that dispatches through this ref, so the
  // real handler (which references actions declared later) can update freely
  // without re-subscribing.
  const handleMidiEventRef = useRef<(e: MidiEvent) => void>(() => {})
  // Program change recalls a quick slot; routed through a ref so the stable MIDI
  // dispatcher can reach the slot bank (defined below) without a forward ref.
  const programRef = useRef<(program: number) => void>(() => {})

  // Debounced last-session save: persist the sound patch plus local performance
  // state (BPM, latch) shortly after any change so a reload/crash resumes where
  // the user was. Best-effort — a failed write (private mode, quota) is silent
  // here; explicit save failures surface through the preset UI. 500 ms coalesces
  // rapid knob turns into one write.
  useEffect(() => {
    const id = setTimeout(() => {
      saveSession({
        version: SESSION_VERSION,
        patch,
        performance: { bpm: tempo, latch, midiMappings, midiInputId, midiChannel, quality, audioInputId, audioOutputId },
      })
    }, 500)
    return () => clearTimeout(id)
  }, [patch, tempo, latch, midiMappings, midiInputId, midiChannel, quality, audioInputId, audioOutputId])
  // heldRef is the source of truth for what's sounding; mirror it into state so
  // the on-screen keyboard highlights stay in sync (side effects stay out of the
  // state updater, which React may run twice).
  const syncActiveNotes = useCallback(() => {
    setActiveNotes(new Set(heldRef.current))
  }, [])

  // Note handlers shared by computer keys, MIDI, and the on-screen keyboard.
  const noteOn = useCallback(
    (midi: number, velocity: number) => {
      // Ignore input before audio runs (the on-screen keys are always rendered),
      // otherwise a pre-start click latches the key highlight with no sound.
      if (engine.status !== 'running') return
      // In latch mode, re-pressing a held note toggles it off — hands-free chord
      // building without needing to keep keys down while singing.
      if (latchRef.current && heldRef.current.has(midi)) {
        engine.noteOff(midi)
        heldRef.current.delete(midi)
        sustainedRef.current.delete(midi)
        syncActiveNotes()
        return
      }
      engine.noteOn(midi, velocity)
      heldRef.current.add(midi)
      sustainedRef.current.delete(midi)
      syncActiveNotes()
    },
    [engine, syncActiveNotes],
  )
  const noteOff = useCallback(
    (midi: number) => {
      // Latch keeps the note held until it's toggled off or cleared; the sustain
      // pedal defers the release until the pedal lifts. Otherwise release now.
      if (latchRef.current) return
      if (sustainRef.current) {
        sustainedRef.current.add(midi)
        return
      }
      engine.noteOff(midi)
      heldRef.current.delete(midi)
      syncActiveNotes()
    },
    [engine, syncActiveNotes],
  )

  // Sustain (damper) pedal from MIDI CC 64: while down, note-offs are deferred;
  // when it lifts, every note released during the hold is finally stopped.
  const setSustain = useCallback(
    (on: boolean) => {
      sustainRef.current = on
      if (on) return
      for (const midi of sustainedRef.current) {
        engine.noteOff(midi)
        heldRef.current.delete(midi)
      }
      sustainedRef.current.clear()
      syncActiveNotes()
    },
    [engine, syncActiveNotes],
  )

  const toggleLatch = useCallback(() => {
    const next = !latchRef.current
    latchRef.current = next
    setLatch(next)
    // Turning latch off releases the held chord so notes don't hang indefinitely.
    if (!next) {
      for (const midi of heldRef.current) engine.noteOff(midi)
      heldRef.current.clear()
      sustainedRef.current.clear()
      syncActiveNotes()
    }
  }, [engine, syncActiveNotes])

  const kbd = useKeyboard({ onNoteOn: noteOn, onNoteOff: noteOff, enabled: engine.status === 'running' })

  const panic = useCallback(() => {
    engine.panic()
    heldRef.current.clear()
    sustainedRef.current.clear()
    setActiveNotes(new Set())
  }, [engine])

  const toggleMidi = useCallback(async () => {
    if (midiInFlight.current) return
    if (midiOn) {
      // dispose() synthesizes note-offs for held notes to our still-subscribed
      // onNote callback (M6) and clears its subscribers, so just null out the
      // dead router — the next enable builds a fresh one (M4).
      midiRef.current?.dispose()
      midiRef.current = null
      midiUnsub.current = null
      setMidiOn(false)
      setMidiInputs([])
      // A dropped device can't finish a pending learn — don't leave it armed.
      setLearnTarget(null)
      return
    }
    midiInFlight.current = true
    try {
      // A fresh router each enable: a disposed router's init() is a no-op (M4).
      const router = new MidiRouter()
      const ok = await router.init()
      if (!ok) {
        router.dispose()
        return
      }
      midiRef.current = router
      // Restore the stored input + channel preferences (stable ids, not objects).
      router.selectInput(midiInputId)
      router.setChannel(midiChannel)
      setMidiInputs(router.listInputs())
      // Subscribe a stable wrapper; the real dispatcher updates via the ref.
      midiUnsub.current = router.onNote((e) => handleMidiEventRef.current(e))
      setMidiOn(true)
    } finally {
      midiInFlight.current = false
    }
  }, [midiOn, midiInputId, midiChannel])

  // Dispose the MIDI router when App unmounts: toggleMidi only tears it down on an
  // explicit toggle-off, so without this the statechange handler + open input
  // ports leak (and a mid-await init() would resolve into a dead component). The
  // router's own init() already no-ops after dispose(), so this closes the loop.
  useEffect(() => {
    return () => {
      midiRef.current?.dispose()
      midiRef.current = null
      midiUnsub.current = null
    }
  }, [])

  // Modal focus management for the mic-warning dialog: trap Tab inside it, move
  // focus in on open, and restore focus to the trigger on close — so keyboard and
  // screen-reader users aren't dropped back at the document top.
  useEffect(() => {
    if (!showMicWarn) return
    micTriggerRef.current = document.activeElement as HTMLElement | null
    const box = micWarnRef.current
    const focusables = box
      ? Array.from(
          box.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        )
      : []
    // Focus the primary action (last button) so Enter confirms by default.
    focusables[focusables.length - 1]?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowMicWarn(false)
        return
      }
      if (e.key !== 'Tab' || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      micTriggerRef.current?.focus()
    }
  }, [showMicWarn])

  const confirmMic = useCallback(async () => {
    setShowMicWarn(false)
    // enableMic returns false when getUserMedia is denied/unavailable; leave the
    // toggle off (useEngine keeps micOn false) and surface why to the user (M7).
    const ok = await engine.enableMic()
    setMicDenied(!ok)
  }, [engine])

  // The engine can stop a capture on its own at the 10-minute cap (buffer kept).
  // recordNotice tells the user why; cappedHandled makes the auto-save fire once.
  const [recordNotice, setRecordNotice] = useState<string | null>(null)
  const cappedHandled = useRef(false)

  const saveRecording = useCallback(async () => {
    const blob = await engine.stopRecording()
    if (blob) {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mvox-${Date.now()}.wav`
      a.click()
      // Revoking synchronously after click() can abort the download in Firefox;
      // defer so the browser has committed to the blob first (L9).
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  }, [engine])

  const record = useCallback(() => {
    if (engine.recording) void saveRecording()
    else {
      setRecordNotice(null)
      engine.startRecording()
    }
  }, [engine, saveRecording])

  // Route a mapped MIDI control to its destination. Continuous targets take the
  // 0..1 value; trigger targets fire on a rising edge through 0.5 (so a knob or
  // pedal doesn't retrigger while held). In learn mode the next learnable control
  // binds to the armed target instead.
  const applyMidiControl = useCallback(
    (e: MidiEvent) => {
      const armed = learnTargetRef.current
      if (armed) {
        const src = sourceFromEvent(e)
        if (src) {
          setMidiMappings((prev) => addMapping(prev, src, armed))
          setLearnTarget(null)
        }
        return
      }
      const mapping = findBySource(midiMappingsRef.current, e)
      if (!mapping) return
      let value: number
      if (e.type === 'cc' || e.type === 'pressure') value = e.value
      else if (e.type === 'pitchbend') value = (e.value + 1) / 2 // -1..1 → 0..1
      else return
      value = value < 0 ? 0 : value > 1 ? 1 : value
      const t = mapping.target
      if (isContinuousTarget(t)) {
        update((p) => {
          if (t.kind === 'macro') p.perf[p.mode].macros[t.index] = value
          else if (t.kind === 'xy') {
            if (t.axis === 'x') p.perf[p.mode].xyX = value
            else p.perf[p.mode].xyY = value
          } else if (t.kind === 'master') p.shared.masterGain = value * RANGES.masterGain.max
          else if (t.kind === 'monitor') p.shared.monitorMix = value
        })
      } else {
        // Rising-edge trigger.
        const key = sourceKey(mapping.source)
        const prev = lastCcValueRef.current.get(key) ?? 0
        lastCcValueRef.current.set(key, value)
        if (prev < 0.5 && value >= 0.5) {
          if (t.kind === 'panic') panic()
          else if (t.kind === 'record') record()
          else if (t.kind === 'latch') toggleLatch()
          else if (t.kind === 'mode') update((p) => { p.mode = t.mode })
        }
      }
    },
    [update, panic, record, toggleLatch],
  )

  const handleMidiEvent = useCallback(
    (e: MidiEvent) => {
      if (e.type === 'noteon') noteOn(e.note, e.velocity)
      else if (e.type === 'noteoff') noteOff(e.note)
      else if (e.type === 'sustain') setSustain(e.on)
      else if (e.type === 'program') programRef.current(e.program)
      else applyMidiControl(e)
    },
    [noteOn, noteOff, setSustain, applyMidiControl],
  )
  useEffect(() => { handleMidiEventRef.current = handleMidiEvent }, [handleMidiEvent])

  const selectMidiInput = useCallback((id: string | null) => {
    setMidiInputId(id)
    midiRef.current?.selectInput(id)
  }, [])
  const selectMidiChannel = useCallback((ch: number | null) => {
    setMidiChannel(ch)
    midiRef.current?.setChannel(ch)
  }, [])
  const learnMapping = useCallback((t: MappingTarget) => setLearnTarget(t), [])
  const clearMapping = useCallback((t: MappingTarget) => {
    setMidiMappings((prev) => removeMappingForTarget(prev, t))
  }, [])

  // --- Complete performance recall (A/B compare + numbered quick slots) -------
  // The portable performance state captured alongside the sound patch. Excludes
  // midiInputId (device-specific) — recalling a preset must not pin an input.
  const perfSnapshot = useMemo<PerfSnapshot>(
    () => ({ bpm: tempo, latch, midiMappings, midiChannel }),
    [tempo, latch, midiMappings, midiChannel],
  )

  // Apply a recalled patch (+ optional performance) to live state. Sound always
  // applies; performance applies only when the snapshot carries it (legacy/sound-
  // only presets leave BPM, latch and MIDI mappings untouched).
  const applyState = useCallback(
    (p: MvoxPatch, perf?: PerfSnapshot) => {
      setPatchState(p)
      if (perf) {
        setTempo(perf.bpm)
        latchRef.current = perf.latch
        setLatch(perf.latch)
        setMidiMappings(perf.midiMappings)
        setMidiChannel(perf.midiChannel)
        midiRef.current?.setChannel(perf.midiChannel)
      }
    },
    [],
  )

  // A/B: two in-memory (non-persisted) comparison slots.
  const [abSlots, setAbSlots] = useState<{ a: SessionSnapshot | null; b: SessionSnapshot | null }>({ a: null, b: null })
  const storeAb = useCallback(
    (slot: 'a' | 'b') => setAbSlots((prev) => ({ ...prev, [slot]: { patch, perf: perfSnapshot } })),
    [patch, perfSnapshot],
  )
  const recallAb = useCallback(
    (slot: 'a' | 'b') => {
      const snap = abSlots[slot]
      if (snap) applyState(snap.patch, snap.perf)
    },
    [abSlots, applyState],
  )

  // Numbered quick slots (persisted). storeMode turns a slot click into a save.
  const [slots, setSlots] = useState<SlotBank>(() => loadSlots())
  const [slotStoreMode, setSlotStoreMode] = useState(false)
  const slotAction = useCallback(
    (i: number) => {
      if (slotStoreMode) {
        setSlots((prev) => {
          const next = prev.slice()
          next[i] = { patch, perf: perfSnapshot }
          if (!saveSlots(next)) setRecordNotice('Could not save the slot (storage unavailable).')
          return next
        })
      } else {
        const snap = slots[i]
        if (snap) applyState(snap.patch, snap.perf)
      }
    },
    [slotStoreMode, slots, patch, perfSnapshot, applyState],
  )
  const clearSlot = useCallback((i: number) => {
    setSlots((prev) => {
      const next = prev.slice()
      next[i] = null
      saveSlots(next)
      return next
    })
  }, [])

  // MIDI program change N recalls quick slot N (if filled). Routed via a ref so
  // the stable MIDI dispatcher always sees the current slot bank.
  useEffect(() => {
    programRef.current = (program: number) => {
      if (program >= 0 && program < SLOT_COUNT) {
        const snap = slots[program]
        if (snap) applyState(snap.patch, snap.perf)
      }
    }
  }, [slots, applyState])

  // --- Device / quality application ------------------------------------------
  // Quality feeds the engine so the NEXT context creation uses the chosen buffer.
  useEffect(() => { engineSetQuality(quality) }, [quality, engineSetQuality])
  // Re-scan devices when audio starts (labels require mic permission) + on demand.
  const refreshDevices = useCallback(() => { void engineListDevices().then(setDevices) }, [engineListDevices])
  useEffect(() => { if (engineStatus === 'running') refreshDevices() }, [engineStatus, refreshDevices])
  // Apply stored device prefs once running: the input pref primes enableMic and
  // hot-swaps a live mic; the output pref routes via setSinkId.
  useEffect(() => {
    if (engineStatus === 'running' && audioInputId) void engineSetInputDevice(audioInputId)
  }, [engineStatus, audioInputId, engineSetInputDevice])
  useEffect(() => {
    if (engineStatus === 'running' && audioOutputId) void engineSetOutputDevice(audioOutputId)
  }, [engineStatus, audioOutputId, engineSetOutputDevice])
  const onInputDevice = useCallback((id: string | null) => {
    setAudioInputId(id)
    void engineSetInputDevice(id)
  }, [engineSetInputDevice])
  const onOutputDevice = useCallback((id: string) => {
    setAudioOutputId(id)
    void engineSetOutputDevice(id)
  }, [engineSetOutputDevice])

  // --- Performance (stage) mode ----------------------------------------------
  const [perfMode, setPerfMode] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenSupported = typeof document !== 'undefined' && !!document.fullscreenEnabled
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.()
    else void document.documentElement.requestFullscreen?.()
  }, [])
  const exitPerfMode = useCallback(() => {
    setPerfMode(false)
    if (document.fullscreenElement) void document.exitFullscreen?.()
  }, [])
  // Macro/XY/mode mutators + recall-only slot handler for the stage surface.
  const onMacro = useCallback((i: number, x: number) => update((p) => { p.perf[p.mode].macros[i] = x }), [update])
  const onXY = useCallback((x: number, y: number) => update((p) => { p.perf[p.mode].xyX = x; p.perf[p.mode].xyY = y }), [update])
  const setMode = useCallback((m: EngineMode) => update((p) => { p.mode = m }), [update])
  const recallSlot = useCallback((i: number) => {
    const snap = slots[i]
    if (snap) applyState(snap.patch, snap.perf)
  }, [slots, applyState])
  // Tapping mic on the stage reuses the same headphone-warning flow as the editor.
  const onStageMic = useCallback(() => {
    if (engine.micOn) engine.disableMic()
    else {
      setMicDenied(false)
      setShowMicWarn(true)
    }
  }, [engine])

  // One-click gate calibration: sample live input level for a bounded interval
  // while the user stays quiet, then set the noise gate just above the measured
  // floor. Reads telemetry through getTelemetry() (live, not the ~60fps mirror).
  const [calibrating, setCalibrating] = useState(false)
  const calibrateTimer = useRef<number | null>(null)
  const calibrate = useCallback(() => {
    if (engine.status !== 'running' || calibrateTimer.current !== null) return
    setCalibrating(true)
    let peak = 0
    const start = performance.now()
    const DURATION_MS = 2500
    calibrateTimer.current = window.setInterval(() => {
      peak = Math.max(peak, engine.getTelemetry().inputLevel)
      if (performance.now() - start >= DURATION_MS) {
        window.clearInterval(calibrateTimer.current ?? undefined)
        calibrateTimer.current = null
        // inputLevel is min(1, RMS*4); recover approx RMS and sit a little above the
        // measured noise floor. Heuristic — the gate knob is there to fine-tune.
        const threshold = Math.min(0.5, (peak / 4) * 1.5 + 0.005)
        update((p) => { p.shared.gateThreshold = threshold })
        setCalibrating(false)
        setRecordNotice(`Gate calibrated to ${threshold.toFixed(3)} (just above measured noise).`)
      }
    }, 50)
  }, [engine, update])
  // Cancel a running calibration on unmount so its timer can't outlive the app.
  useEffect(() => () => {
    if (calibrateTimer.current !== null) window.clearInterval(calibrateTimer.current)
  }, [])

  // Finalize the capped capture automatically so its audio isn't lost.
  const { recordingCapped } = engine
  useEffect(() => {
    if (!recordingCapped) {
      cappedHandled.current = false
      return
    }
    if (cappedHandled.current) return
    cappedHandled.current = true
    setRecordNotice('Recording reached the 10-minute limit — saved automatically.')
    void saveRecording()
  }, [recordingCapped, saveRecording])

  const running = engine.status === 'running'
  const macros = MACROS[patch.mode]
  const xy = XY[patch.mode]
  const perf = patch.perf[patch.mode]
  // Key/scale/tuning are consumed only by the pitch-quantized engines; the
  // vocoder and formant paths ignore them, so grey the selectors out there.
  const pitchAware = patch.mode === 'harmony' || patch.mode === 'follow'

  // The mic-warning dialog is shared by both the editor and the stage view (it's a
  // modal overlay), so define it once and render it in whichever branch is active.
  const micWarnModal = showMicWarn ? (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="mic-warn-title" ref={micWarnRef}>
      <div className="modal__box">
        <h2 id="mic-warn-title">Use headphones</h2>
        <p>
          mvox processes your microphone on-device — nothing is uploaded. Wear headphones before
          enabling the mic to avoid feedback howl. The dry voice is not monitored by default.
        </p>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={() => setShowMicWarn(false)}>
            Cancel
          </button>
          {/* autoFocus moves keyboard focus into the dialog so Tab/Escape work. */}
          <button type="button" className="btn btn--primary" onClick={confirmMic} autoFocus>
            I'm on headphones — enable mic
          </button>
        </div>
      </div>
    </div>
  ) : null

  // Performance (stage) mode is an alternate view over the SAME state, so switching
  // in/out never loses anything. Rendered after all hooks, so hook order is stable.
  if (perfMode) {
    return (
      <>
        <PerformanceMode
          patch={patch}
          telemetry={engine.telemetry}
          clip={engine.inputClipHold}
          running={running}
          micOn={engine.micOn}
          recording={engine.recording}
          slots={slots}
          fullscreenSupported={fullscreenSupported}
          isFullscreen={isFullscreen}
          onMode={setMode}
          onMacro={onMacro}
          onXY={onXY}
          onMic={onStageMic}
          onRecord={record}
          onPanic={panic}
          onSlot={recallSlot}
          onFullscreen={toggleFullscreen}
          onExit={exitPerfMode}
        />
        {micWarnModal}
      </>
    )
  }

  return (
    <div className={`app app--${patch.mode}`}>
      <header className="app__header">
        {/* Brand mark: the mvox wordmark lockup (glyph + name). */}
        <h1 className="app__title">
          <img
            className="app__wordmark"
            src={`${import.meta.env.BASE_URL}mvox-wordmark.svg`}
            alt="mvox"
            width={120}
            height={40}
          />
          <span className="app__version">v{__APP_VERSION__}</span>
        </h1>
        <span className="app__tag">Your voice is the patch</span>
        {/* Always-visible master/monitor sliders — bind to the same shared patch
            state as the panel knobs, so the two stay in sync. */}
        <div className="app__master">
          <label className="hslider">
            <span className="hslider__label">Master</span>
            <input
              className="hslider__input"
              type="range"
              min={RANGES.masterGain.min}
              max={RANGES.masterGain.max}
              step={(RANGES.masterGain.max - RANGES.masterGain.min) / 100}
              value={patch.shared.masterGain}
              onChange={(e) => update((p) => { p.shared.masterGain = parseFloat(e.target.value) })}
            />
            <span className="hslider__value">{patch.shared.masterGain.toFixed(2)}</span>
          </label>
          <label className="hslider">
            <span className="hslider__label">Monitor</span>
            <input
              className="hslider__input"
              type="range"
              min={RANGES.monitorMix.min}
              max={RANGES.monitorMix.max}
              step={(RANGES.monitorMix.max - RANGES.monitorMix.min) / 100}
              value={patch.shared.monitorMix}
              onChange={(e) => update((p) => { p.shared.monitorMix = parseFloat(e.target.value) })}
            />
            <span className="hslider__value">{patch.shared.monitorMix.toFixed(2)}</span>
          </label>
        </div>
        <button
          type="button"
          className={engine.busPublishing ? 'btn btn--on' : 'btn'}
          aria-pressed={engine.busPublishing}
          title={engine.busPublishing
            ? 'Publishing to the mbus patchbay (via the local link-bridge)'
            : 'Publish the master output to the mbus patchbay (needs the local link-bridge; harmless without it)'}
          onClick={engine.toggleBusPublish}
        >
          {engine.busPublishing ? 'bus on' : 'bus'}
        </button>
      </header>

      {engine.error ? <div className="app__error">{engine.error}</div> : null}
      {micDenied ? (
        <div className="app__error">Mic access was blocked — check your browser's microphone permission.</div>
      ) : null}
      {recordNotice ? (
        <div className="app__notice" role="status">
          {recordNotice}
          <button type="button" className="app__notice-x" onClick={() => setRecordNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}
      {sessionNotice ? (
        <div className="app__notice" role="status">
          {sessionNotice}
          <button type="button" className="app__notice-x" onClick={() => setSessionNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}

      <div className="transport">
        <button type="button" className="btn" onClick={() => setPerfMode(true)} title="Stage-friendly performance view (your sound + settings are kept)">
          ◧ Stage
        </button>
        {running && engine.suspended ? (
          // The browser suspended the context (tab backgrounded / interruption);
          // status is still 'running' but audio is silent until a user gesture
          // resumes it. engine.start() resumes a suspended running context.
          <button type="button" className="btn btn--primary" onClick={engine.start}>
            ▶ Resume audio
          </button>
        ) : null}
        {!running ? (
          <button type="button" className="btn btn--primary" onClick={engine.start}>
            {engine.status === 'starting' ? 'Starting…' : '▶ Start audio'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`btn ${engine.micOn ? 'btn--on' : ''}`}
              onClick={() => (engine.micOn ? engine.disableMic() : (setMicDenied(false), setShowMicWarn(true)))}
            >
              {engine.micOn ? '🎤 Mic on' : '🎤 Enable mic'}
            </button>
            <span className="transport__src">
              {engine.micOn ? 'live voice' : 'demo voice — enable mic to sing in'}
            </span>
            <button type="button" className={`btn ${midiOn ? 'btn--on' : ''}`} onClick={toggleMidi}>
              MIDI
            </button>
            <button
              type="button"
              className={`btn ${latch ? 'btn--on' : ''}`}
              aria-pressed={latch}
              onClick={toggleLatch}
              title="Latch: hold notes hands-free (a sustain pedal also works). Press a held note again to release it."
            >
              {latch ? '⤾ Latch on' : '⤾ Latch'}
            </button>
            <button type="button" className={`btn ${engine.recording ? 'btn--rec' : ''}`} onClick={record}>
              {engine.recording ? '⏺ Stop & save' : '⏺ Record'}
            </button>
            <button type="button" className="btn btn--danger" onClick={panic} title="Release all stuck notes">
              PANIC
            </button>
            <label className="transport__tempo">
              BPM
              <input
                type="number"
                min={40}
                max={300}
                value={tempoText}
                onChange={(e) => setTempoText(e.target.value)}
                onBlur={commitTempo}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTempo()
                }}
              />
            </label>
          </>
        )}
      </div>

      {running ? (
        <div className="meters">
          <Meter label="Input" value={engine.telemetry.inputLevel} tone="accent" />
          <span className={`meters__clip ${engine.inputClipHold ? 'meters__clip--on' : ''}`} title="Input clipping — lower In Gain">CLIP</span>
          <Meter label="Output" value={engine.telemetry.outputPeak} tone="signal" />
          <Meter label="Pitch conf." value={engine.telemetry.confidence} tone="accent" />
          <span className="meters__pitch">
            {engine.telemetry.f0 > 0
              ? `${engine.telemetry.f0.toFixed(0)} Hz ${hzToNoteName(engine.telemetry.f0)}`
              : '—'}
            {engine.telemetry.targetHz > 0 ? ` → ${hzToNoteName(engine.telemetry.targetHz)}` : ''} · {engine.telemetry.activeVoices} voices
          </span>
        </div>
      ) : null}

      <nav className="tabs" role="tablist">
        {ENGINE_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={patch.mode === m}
            aria-controls="mode-panel"
            className={`tab ${patch.mode === m ? 'tab--active' : ''}`}
            onClick={() => update((p) => { p.mode = m })}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </nav>
      <p className="mode-desc">{MODE_DESCRIPTIONS[patch.mode]}</p>

      <section className="panel" id="mode-panel" role="tabpanel">
        <div className="panel__shared">
          <Select label="Key" value={String(patch.shared.keyRoot)} options={rootOptions} onChange={(v) => update((p) => { p.shared.keyRoot = Number(v) })} disabled={!pitchAware} />
          <Select label="Scale" value={patch.shared.scaleMode} options={scaleOptions} onChange={(v: Mode) => update((p) => { p.shared.scaleMode = v })} disabled={!pitchAware} />
          <TuningControls patch={patch} update={update} disabled={!pitchAware} />
        </div>

        <ModeControls patch={patch} update={update} />

        <div className="perf">
          <div className="macros">
            {macros.map((m, i) => (
              <Knob
                key={i}
                label={m.name}
                min={0}
                max={1}
                value={perf.macros[i]}
                onChange={(x) => update((p) => { p.perf[p.mode].macros[i] = x })}
              />
            ))}
          </div>
          <XYPad
            x={perf.xyX}
            y={perf.xyY}
            xLabel={xy.xName}
            yLabel={xy.yName}
            onChange={(x, y) => update((p) => {
              p.perf[p.mode].xyX = x
              p.perf[p.mode].xyY = y
            })}
          />
        </div>

        <details className="fx">
          <summary>Input &amp; tracking</summary>
          <InputTrackingControls
            patch={patch}
            update={update}
            onCalibrate={calibrate}
            calibrating={calibrating}
          />
        </details>

        <details className="fx">
          <summary>FX tail</summary>
          <FxControls patch={patch} update={update} />
        </details>

        {midiOn ? (
          <details className="fx" open={learnTarget !== null}>
            <summary>MIDI learn</summary>
            <MidiLearnPanel
              mappings={midiMappings}
              learnTarget={learnTarget}
              onLearn={learnMapping}
              onClear={clearMapping}
              inputs={midiInputs}
              inputId={midiInputId}
              onInput={selectMidiInput}
              channel={midiChannel}
              onChannel={selectMidiChannel}
            />
          </details>
        ) : null}

        <details className="fx">
          <summary>Device &amp; CPU</summary>
          <DeviceControls
            info={engine.info}
            renderLoad={engine.renderLoad}
            quality={quality}
            onQuality={setQualityPref}
            devices={devices}
            inputId={audioInputId}
            outputId={audioOutputId}
            onInput={onInputDevice}
            onOutput={onOutputDevice}
            onRefresh={refreshDevices}
            running={running}
          />
        </details>
      </section>

      {/* Presets carry the sound patch and, when "with perf" was checked on save,
          the performance snapshot (BPM, latch, MIDI mappings, channel). */}
      <PresetBar patch={patch} perf={perfSnapshot} onLoad={applyState} />

      <PerformanceSlots
        ab={abSlots}
        onStoreAb={storeAb}
        onRecallAb={recallAb}
        slots={slots}
        storeMode={slotStoreMode}
        onToggleStore={() => setSlotStoreMode((v) => !v)}
        onSlot={slotAction}
        onClearSlot={clearSlot}
      />

      <div className="kbd-bar">
        <span className="kbd-bar__info">Oct {kbd.octave} (Z/X) · Vel {(kbd.velocity * 100) | 0}% (C/V)</span>
        <Keyboard octave={kbd.octave} activeNotes={activeNotes} onNoteOn={noteOn} onNoteOff={noteOff} />
      </div>

      {micWarnModal}
    </div>
  )
}

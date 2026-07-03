import './styles.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_PATCH,
  ENGINE_MODES,
  RANGES,
  sanitizePatch,
  type EngineMode,
  type MvoxPatch,
} from './audio/contracts'
import { MODES, NOTE_NAMES, type Mode } from './audio/dsp/scale'
import { applyPerformance, MACROS, XY } from './performance/macros'
import { patchFromUrl } from './sharing/codec'
import { MidiRouter } from './midi/router'
import { useEngine } from './ui/useEngine'
import { useKeyboard } from './ui/useKeyboard'
import { Knob, Meter, Select, XYPad } from './components/controls'
import { FxControls, ModeControls } from './components/ModeControls'
import { Keyboard } from './components/Keyboard'
import { PresetBar } from './components/PresetBar'

const MODE_LABELS: Record<EngineMode, string> = {
  vocoder: 'VOCODER',
  harmony: 'HARMONY',
  formant: 'FORMANT',
  follow: 'FOLLOW',
}

const scaleOptions = MODES.map((m) => ({ value: m, label: m }))
const rootOptions = NOTE_NAMES.map((n, i) => ({ value: String(i), label: n }))

function initialPatch(): MvoxPatch {
  const shared = patchFromUrl(window.location.hash)
  return shared ?? DEFAULT_PATCH
}

export default function App() {
  const engine = useEngine()
  const [patch, setPatchState] = useState<MvoxPatch>(initialPatch)
  const [tempo, setTempo] = useState(120)
  // Editable BPM text kept separate from the committed numeric tempo so an empty
  // or mid-edit field isn't snapped to a fallback while typing (L8).
  const [tempoText, setTempoText] = useState(String(tempo))
  const [activeNotes, setActiveNotes] = useState<Set<number>>(() => new Set())
  const [showMicWarn, setShowMicWarn] = useState(false)
  const [micDenied, setMicDenied] = useState(false)
  const [midiOn, setMidiOn] = useState(false)
  const midiRef = useRef<MidiRouter | null>(null)
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
  const { status: engineStatus, setPatch: engineSetPatch, setTempo: engineSetTempo } = engine
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

  // Note handlers shared by computer keys, MIDI, and the on-screen keyboard.
  const noteOn = useCallback(
    (midi: number, velocity: number) => {
      engine.noteOn(midi, velocity)
      setActiveNotes((prev) => new Set(prev).add(midi))
    },
    [engine],
  )
  const noteOff = useCallback(
    (midi: number) => {
      engine.noteOff(midi)
      setActiveNotes((prev) => {
        const next = new Set(prev)
        next.delete(midi)
        return next
      })
    },
    [engine],
  )

  const kbd = useKeyboard({ onNoteOn: noteOn, onNoteOff: noteOff, enabled: engine.status === 'running' })

  const panic = useCallback(() => {
    engine.panic()
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
      midiUnsub.current = router.onNote((e) => {
        if (e.type === 'noteon') noteOn(e.note, e.velocity)
        else if (e.type === 'noteoff') noteOff(e.note)
      })
      setMidiOn(true)
    } finally {
      midiInFlight.current = false
    }
  }, [midiOn, noteOn, noteOff])

  const confirmMic = useCallback(async () => {
    setShowMicWarn(false)
    // enableMic returns false when getUserMedia is denied/unavailable; leave the
    // toggle off (useEngine keeps micOn false) and surface why to the user (M7).
    const ok = await engine.enableMic()
    setMicDenied(!ok)
  }, [engine])

  const record = useCallback(async () => {
    if (engine.recording) {
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
    } else {
      engine.startRecording()
    }
  }, [engine])

  const running = engine.status === 'running'
  const macros = MACROS[patch.mode]
  const xy = XY[patch.mode]
  const perf = patch.perf[patch.mode]

  return (
    <div className={`app app--${patch.mode}`}>
      <header className="app__header">
        {/* Formant chart: the F1–F2 vowel trapezoid mvox works inside. */}
        <svg className="app__glyph" viewBox="0 0 34 26" aria-hidden="true">
          <polygon points="2,2 32,4 26,24 6,20" fill="none" stroke="var(--line-hi)" strokeWidth="1" />
          <circle cx="8" cy="6" r="1.6" fill="var(--voice)" />
          <circle cx="26" cy="7" r="1.6" fill="var(--synth)" />
          <circle cx="12" cy="19" r="1.6" fill="var(--muted)" />
        </svg>
        <h1 className="app__title">mvox</h1>
        <span className="app__tag">Your voice is the patch</span>
        <span className="app__version">v{__APP_VERSION__}</span>
      </header>

      {engine.error ? <div className="app__error">{engine.error}</div> : null}
      {micDenied ? (
        <div className="app__error">Mic access was blocked — check your browser's microphone permission.</div>
      ) : null}

      <div className="transport">
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
            <span className="transport__src">{engine.micOn ? 'live voice' : 'demo voice'}</span>
            <button type="button" className={`btn ${midiOn ? 'btn--on' : ''}`} onClick={toggleMidi}>
              MIDI
            </button>
            <button type="button" className={`btn ${engine.recording ? 'btn--rec' : ''}`} onClick={record}>
              {engine.recording ? '⏺ Stop & save' : '⏺ Record'}
            </button>
            <button type="button" className="btn btn--danger" onClick={panic}>
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
          <Meter label="Output" value={engine.telemetry.outputPeak} tone="signal" />
          <Meter label="Pitch conf." value={engine.telemetry.confidence} tone="accent" />
          <span className="meters__pitch">
            {engine.telemetry.f0 > 0 ? `${engine.telemetry.f0.toFixed(0)} Hz` : '—'} · {engine.telemetry.activeVoices} voices
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
            className={`tab ${patch.mode === m ? 'tab--active' : ''}`}
            onClick={() => update((p) => { p.mode = m })}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </nav>

      <section className="panel">
        <div className="panel__shared">
          <Select label="Key" value={String(patch.shared.keyRoot)} options={rootOptions} onChange={(v) => update((p) => { p.shared.keyRoot = Number(v) })} />
          <Select label="Scale" value={patch.shared.scaleMode} options={scaleOptions} onChange={(v: Mode) => update((p) => { p.shared.scaleMode = v })} />
          <Knob label="Monitor" min={0} max={1} value={patch.shared.monitorMix} onChange={(x) => update((p) => { p.shared.monitorMix = x })} />
          <Knob label="Master" min={RANGES.masterGain.min} max={RANGES.masterGain.max} value={patch.shared.masterGain} onChange={(x) => update((p) => { p.shared.masterGain = x })} />
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
          <summary>FX tail</summary>
          <FxControls patch={patch} update={update} />
        </details>
      </section>

      <PresetBar patch={patch} onLoad={(p) => { setPatchState(p); setTempo(120) }} />

      <div className="kbd-bar">
        <span className="kbd-bar__info">Oct {kbd.octave} (Z/X) · Vel {(kbd.velocity * 100) | 0}% (C/V)</span>
        <Keyboard octave={kbd.octave} activeNotes={activeNotes} onNoteOn={noteOn} onNoteOff={noteOff} />
      </div>

      {showMicWarn ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__box">
            <h2>Use headphones</h2>
            <p>
              mvox processes your microphone on-device — nothing is uploaded. Wear headphones before
              enabling the mic to avoid feedback howl. The dry voice is not monitored by default.
            </p>
            <div className="modal__actions">
              <button type="button" className="btn" onClick={() => setShowMicWarn(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" onClick={confirmMic}>
                I'm on headphones — enable mic
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

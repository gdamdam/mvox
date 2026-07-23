// Stage-friendly performance surface: an alternate VIEW over the same App state as
// the editor, so switching in/out loses nothing. Shows only performance controls
// (large macros + XY, meters, quick slots, mode/mic/record/panic) to minimise
// accidental edits. Fully keyboard-accessible (native buttons + the arrow-key XY
// pad + range knobs); large touch targets; reduced-motion handled in CSS.

import { ENGINE_MODES, type EngineMode, type MvoxPatch, type Telemetry } from '../audio/contracts'
import { hzToMidi, NOTE_NAMES } from '../audio/dsp/scale'
import { MACROS, XY } from '../performance/macros'
import type { SlotBank } from '../persistence/slots'
import { Knob, Meter, XYPad } from './controls'

function noteName(hz: number): string {
  if (!(hz > 0)) return '—'
  const midi = Math.round(hzToMidi(hz))
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

const MODE_LABELS: Record<EngineMode, string> = { vocoder: 'VOC', harmony: 'HARM', formant: 'FORM', follow: 'FOL' }

interface Props {
  patch: MvoxPatch
  telemetry: Telemetry
  clip: boolean
  running: boolean
  micOn: boolean
  recording: boolean
  slots: SlotBank
  fullscreenSupported: boolean
  isFullscreen: boolean
  onMode: (m: EngineMode) => void
  onMacro: (i: number, x: number) => void
  onXY: (x: number, y: number) => void
  onMic: () => void
  onRecord: () => void
  onPanic: () => void
  onSlot: (i: number) => void
  onFullscreen: () => void
  onExit: () => void
}

export function PerformanceMode(props: Props) {
  const { patch, telemetry, clip, running, micOn, recording, slots } = props
  const macros = MACROS[patch.mode]
  const xy = XY[patch.mode]
  const perf = patch.perf[patch.mode]

  return (
    <div className="perf-stage" role="region" aria-label="Performance mode">
      <div className="perf-stage__top">
        <div className="perf-stage__modes" role="group" aria-label="Engine mode">
          {ENGINE_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`perf-btn ${patch.mode === m ? 'perf-btn--on' : ''}`}
              aria-pressed={patch.mode === m}
              onClick={() => props.onMode(m)}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="perf-stage__actions">
          {props.fullscreenSupported ? (
            <button type="button" className="perf-btn" onClick={props.onFullscreen}>
              {props.isFullscreen ? '⤢ Windowed' : '⤢ Fullscreen'}
            </button>
          ) : null}
          <button type="button" className="perf-btn" onClick={props.onExit}>
            ✕ Editor
          </button>
        </div>
      </div>

      <div className="perf-stage__meters">
        <Meter label="In" value={telemetry.inputLevel} tone="accent" />
        <span className={`meters__clip ${clip ? 'meters__clip--on' : ''}`}>CLIP</span>
        <Meter label="Out" value={telemetry.outputPeak} tone="signal" />
        <Meter label="Conf" value={telemetry.confidence} tone="accent" />
        <span className="perf-stage__pitch">
          {telemetry.f0 > 0 ? `${noteName(telemetry.f0)}` : '—'}
          {telemetry.targetHz > 0 ? ` → ${noteName(telemetry.targetHz)}` : ''}
        </span>
        <span className="perf-stage__state">
          {!running ? 'stopped' : micOn ? 'live' : 'demo'}
          {telemetry.confidence >= 0.5 && telemetry.f0 > 0 ? ' · tracking' : ''}
        </span>
      </div>

      <div className="perf-stage__body">
        <div className="perf-stage__macros">
          {macros.map((m, i) => (
            <div className="perf-macro" key={i}>
              <Knob label={m.name} min={0} max={1} value={perf.macros[i]} onChange={(x) => props.onMacro(i, x)} />
            </div>
          ))}
        </div>
        <div className="perf-stage__xy">
          <XYPad x={perf.xyX} y={perf.xyY} xLabel={xy.xName} yLabel={xy.yName} onChange={props.onXY} />
        </div>
      </div>

      <div className="perf-stage__slots" role="group" aria-label="Quick recall">
        {slots.map((snap, i) => (
          <button
            key={i}
            type="button"
            className={`perf-btn perf-slot ${snap ? 'perf-slot--filled' : ''}`}
            disabled={!snap}
            onClick={() => props.onSlot(i)}
            aria-label={snap ? `Recall slot ${i + 1}` : `Slot ${i + 1} empty`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <div className="perf-stage__transport">
        <button type="button" className={`perf-btn perf-btn--big ${micOn ? 'perf-btn--on' : ''}`} onClick={props.onMic} disabled={!running}>
          {micOn ? '🎤 Mic on' : '🎤 Mic'}
        </button>
        <button type="button" className={`perf-btn perf-btn--big ${recording ? 'perf-btn--rec' : ''}`} onClick={props.onRecord} disabled={!running}>
          {recording ? '⏺ Stop' : '⏺ Rec'}
        </button>
        <button type="button" className="perf-btn perf-btn--big perf-btn--danger" onClick={props.onPanic}>
          PANIC
        </button>
      </div>
    </div>
  )
}

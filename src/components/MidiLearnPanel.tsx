// Compact MIDI-learn UI: input + channel selectors and a list of mappable
// destinations, each showing its current binding with Learn / Clear. Kept out of
// the main control surface (only shown when MIDI is on) so it doesn't clutter
// every knob. Presentational — all state lives in App.

import { ENGINE_MODES, type EngineMode } from '../audio/contracts'
import { describeSource, targetKey, type MidiMapping, type MappingTarget } from '../midi/mapping'

interface Props {
  mappings: MidiMapping[]
  learnTarget: MappingTarget | null
  onLearn: (t: MappingTarget) => void
  onClear: (t: MappingTarget) => void
  inputs: { id: string; name: string }[]
  inputId: string | null
  onInput: (id: string | null) => void
  channel: number | null
  onChannel: (ch: number | null) => void
}

interface Row {
  target: MappingTarget
  label: string
}

const CONTINUOUS: Row[] = [
  { target: { kind: 'macro', index: 0 }, label: 'Macro 1' },
  { target: { kind: 'macro', index: 1 }, label: 'Macro 2' },
  { target: { kind: 'macro', index: 2 }, label: 'Macro 3' },
  { target: { kind: 'macro', index: 3 }, label: 'Macro 4' },
  { target: { kind: 'xy', axis: 'x' }, label: 'XY · X' },
  { target: { kind: 'xy', axis: 'y' }, label: 'XY · Y' },
  { target: { kind: 'master' }, label: 'Master' },
  { target: { kind: 'monitor' }, label: 'Monitor' },
]

const TRIGGERS: Row[] = [
  { target: { kind: 'panic' }, label: 'Panic' },
  { target: { kind: 'record' }, label: 'Record' },
  { target: { kind: 'latch' }, label: 'Latch' },
  ...ENGINE_MODES.map((m: EngineMode) => ({ target: { kind: 'mode', mode: m } as MappingTarget, label: `Mode: ${m}` })),
]

export function MidiLearnPanel({ mappings, learnTarget, onLearn, onClear, inputs, inputId, onInput, channel, onChannel }: Props) {
  const bindingFor = (t: MappingTarget): MidiMapping | undefined =>
    mappings.find((m) => targetKey(m.target) === targetKey(t))

  const renderRow = (row: Row) => {
    const binding = bindingFor(row.target)
    const arming = learnTarget !== null && targetKey(learnTarget) === targetKey(row.target)
    return (
      <div className="midimap__row" key={targetKey(row.target)}>
        <span className="midimap__name">{row.label}</span>
        <span className="midimap__src">{binding ? describeSource(binding.source) : '—'}</span>
        <button
          type="button"
          className={arming ? 'btn btn--on midimap__learn' : 'btn midimap__learn'}
          onClick={() => onLearn(row.target)}
        >
          {arming ? 'Listening…' : 'Learn'}
        </button>
        <button
          type="button"
          className="btn midimap__clear"
          disabled={!binding}
          aria-label={`Clear mapping for ${row.label}`}
          onClick={() => onClear(row.target)}
        >
          ✕
        </button>
      </div>
    )
  }

  return (
    <div className="midimap">
      <div className="midimap__head">
        <label className="select">
          <span className="select__label">Input</span>
          <select value={inputId ?? ''} onChange={(e) => onInput(e.target.value || null)}>
            <option value="">All inputs</option>
            {inputs.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span className="select__label">Channel</span>
          <select value={channel === null ? '' : String(channel)} onChange={(e) => onChannel(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">All</option>
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        {learnTarget ? (
          <span className="midimap__hint">Move a knob / press a pad / bend to bind…</span>
        ) : (
          <span className="midimap__hint">Click Learn, then move a MIDI control.</span>
        )}
      </div>
      <div className="midimap__group">
        <h4 className="midimap__title">Continuous</h4>
        {CONTINUOUS.map(renderRow)}
      </div>
      <div className="midimap__group">
        <h4 className="midimap__title">Triggers</h4>
        {TRIGGERS.map(renderRow)}
      </div>
    </div>
  )
}

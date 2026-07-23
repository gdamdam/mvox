// Per-voice harmony controls: independent enable / interval / level / pan / detune
// for each of the four harmony voices, laid out as one row per voice. Kept in its
// own component so the harmony panel in ModeControls stays readable.

import { RANGES, type MvoxPatch } from '../audio/contracts'
import { Knob, Toggle } from './controls'

interface Props {
  patch: MvoxPatch
  update: (mut: (p: MvoxPatch) => void) => void
}

const INTERVAL_NAMES = ['unison', '2nd', '3rd', '4th', '5th', '6th', '7th', 'octave', '9th', '10th', '11th', '12th', '13th', '14th', '15th']
function intervalName(degree: number): string {
  const n = Math.abs(degree)
  const base = INTERVAL_NAMES[n] ?? `${n + 1}th`
  if (degree === 0) return base
  return `${degree > 0 ? '+' : '−'}${base}`
}

export function HarmonyVoices({ patch, update }: Props) {
  const h = patch.harmony
  return (
    <div className="hvoices">
      {[0, 1, 2, 3].map((v) => (
        <div className={`hvoices__row ${h.voiceEnabled[v] ? '' : 'hvoices__row--off'}`} key={v}>
          <span className="hvoices__n">V{v + 1}</span>
          <Toggle
            label="On"
            value={h.voiceEnabled[v]}
            onChange={(b) => update((p) => { p.harmony.voiceEnabled[v] = b })}
          />
          <Knob
            label="Int"
            title={`Voice ${v + 1} interval (− is below the sung note)`}
            min={-14}
            max={14}
            step={1}
            value={h.intervals[v]}
            format={intervalName}
            onChange={(x) => update((p) => { p.harmony.intervals[v] = x })}
          />
          <Knob label="Lvl" min={0} max={1} value={h.voiceLevel[v]} onChange={(x) => update((p) => { p.harmony.voiceLevel[v] = x })} />
          <Knob label="Pan" min={-1} max={1} value={h.voicePan[v]} onChange={(x) => update((p) => { p.harmony.voicePan[v] = x })} />
          <Knob label="Det" title="Per-voice detune offset (cents)" min={RANGES.harmonyVoiceDetune.min} max={RANGES.harmonyVoiceDetune.max} unit="¢" value={h.voiceDetune[v]} onChange={(x) => update((p) => { p.harmony.voiceDetune[v] = x })} />
        </div>
      ))}
    </div>
  )
}

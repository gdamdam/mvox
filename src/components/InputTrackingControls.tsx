// Input conditioning + pitch-tracking controls. Reads its slice of the patch and
// mutates via update(), like ModeControls. Range presets set tracking.minHz/maxHz;
// editing min/max flips the preset to 'custom'. Calibration is driven from App
// (it needs live telemetry), so it arrives as props.

import { RANGES, VOCAL_RANGES, type MvoxPatch, type VocalRange } from '../audio/contracts'
import { boundsForRange, rangeForBounds } from '../audio/vocalRange'
import { Knob, Select } from './controls'

interface Props {
  patch: MvoxPatch
  update: (mut: (p: MvoxPatch) => void) => void
  onCalibrate: () => void
  calibrating: boolean
}

const rangeOptions = VOCAL_RANGES.map((r) => ({ value: r, label: r }))

export function InputTrackingControls({ patch, update, onCalibrate, calibrating }: Props) {
  const s = patch.shared
  const t = patch.tracking
  const custom = t.rangePreset === 'custom'

  const setRange = (preset: VocalRange) =>
    update((p) => {
      p.tracking.rangePreset = preset
      const b = boundsForRange(preset)
      if (b) {
        p.tracking.minHz = b.minHz
        p.tracking.maxHz = b.maxHz
      }
    })

  // Editing a bound switches to whichever preset now matches (or 'custom').
  const setMin = (hz: number) =>
    update((p) => {
      p.tracking.minHz = hz
      p.tracking.rangePreset = rangeForBounds(hz, p.tracking.maxHz)
    })
  const setMax = (hz: number) =>
    update((p) => {
      p.tracking.maxHz = hz
      p.tracking.rangePreset = rangeForBounds(p.tracking.minHz, hz)
    })

  return (
    <div className="controls-grid">
      <Knob label="In Gain" title="Input pre-gain (before analysis + processing)" min={RANGES.inputGain.min} max={RANGES.inputGain.max} value={s.inputGain} onChange={(x) => update((p) => { p.shared.inputGain = x })} />
      <Knob label="Gate" title="Noise-gate threshold — 0 disables the gate" min={RANGES.gateThreshold.min} max={RANGES.gateThreshold.max} value={s.gateThreshold} onChange={(x) => update((p) => { p.shared.gateThreshold = x })} />
      <Knob label="Gate Rel" title="How slowly the gate closes" min={0} max={1} value={s.gateRelease} onChange={(x) => update((p) => { p.shared.gateRelease = x })} />
      <button
        type="button"
        className={calibrating ? 'btn btn--on calib' : 'btn calib'}
        onClick={onCalibrate}
        title="Measure the room/noise level for a moment and set the gate just above it. Stay quiet."
      >
        {calibrating ? 'Calibrating… (quiet)' : 'Calibrate gate'}
      </button>
      <Select label="Range" value={t.rangePreset} options={rangeOptions} onChange={setRange} />
      <Knob label="Min Hz" title="Lowest tracked pitch" min={RANGES.trackMinHz.min} max={RANGES.trackMinHz.max} step={1} unit="Hz" value={t.minHz} onChange={setMin} disabled={!custom} />
      <Knob label="Max Hz" title="Highest tracked pitch" min={RANGES.trackMaxHz.min} max={RANGES.trackMaxHz.max} step={1} unit="Hz" value={t.maxHz} onChange={setMax} disabled={!custom} />
      <Knob label="Smooth" title="Pitch smoothing / response" min={0} max={1} value={t.smoothing} onChange={(x) => update((p) => { p.tracking.smoothing = x })} />
      <Knob label="Hyst" title="Note-change hysteresis — resists boundary chatter" min={0} max={1} value={t.hysteresis} onChange={(x) => update((p) => { p.tracking.hysteresis = x })} />
    </div>
  )
}

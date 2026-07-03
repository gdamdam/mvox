// Per-engine parameter panels. Each reads its slice of the patch and calls
// update() with an immutable mutator. Ranges come from the single RANGES source
// so control bounds never drift from the sanitizer.

import { CARRIER_WAVES, RANGES, type MvoxPatch } from '../audio/contracts'
import { Knob, Select, Toggle } from './controls'

interface Props {
  patch: MvoxPatch
  update: (mut: (p: MvoxPatch) => void) => void
}

const waveOptions = CARRIER_WAVES.map((w) => ({ value: w, label: w }))

export function ModeControls({ patch, update }: Props) {
  switch (patch.mode) {
    case 'vocoder': {
      const v = patch.vocoder
      return (
        <div className="controls-grid">
          <Knob label="Bands" min={RANGES.vocoderBands.min} max={RANGES.vocoderBands.max} step={1} value={v.bands} onChange={(x) => update((p) => { p.vocoder.bands = x })} />
          <Knob label="Bass" min={0} max={1} value={v.bassBoost} onChange={(x) => update((p) => { p.vocoder.bassBoost = x })} />
          <Knob label="Air/Sib" min={0} max={1} value={v.sibilance} onChange={(x) => update((p) => { p.vocoder.sibilance = x })} />
          <Knob label="Release" min={0} max={1} value={v.release} onChange={(x) => update((p) => { p.vocoder.release = x })} />
          <Knob label="Carrier" min={0} max={1} value={v.carrierMix} onChange={(x) => update((p) => { p.vocoder.carrierMix = x })} />
          <Select label="Wave" value={v.carrierWave} options={waveOptions} onChange={(w) => update((p) => { p.vocoder.carrierWave = w })} />
        </div>
      )
    }
    case 'harmony': {
      const h = patch.harmony
      return (
        <div className="controls-grid">
          <Knob label="Voices" min={0} max={4} step={1} value={h.voiceCount} onChange={(x) => update((p) => { p.harmony.voiceCount = x })} />
          <Knob label="Level" min={0} max={1} value={h.level} onChange={(x) => update((p) => { p.harmony.level = x })} />
          <Knob label="Spread" min={0} max={1} value={h.spread} onChange={(x) => update((p) => { p.harmony.spread = x })} />
          <Knob label="Detune" min={0} max={50} unit="¢" value={h.detune} onChange={(x) => update((p) => { p.harmony.detune = x })} />
          <Knob label="Formant" min={0} max={1} value={h.formantPreserve} onChange={(x) => update((p) => { p.harmony.formantPreserve = x })} />
          {h.intervals.map((iv, i) => (
            <Knob key={i} label={`Int ${i + 1}`} min={-14} max={14} step={1} value={iv} onChange={(x) => update((p) => { p.harmony.intervals[i] = x })} />
          ))}
        </div>
      )
    }
    case 'formant': {
      const f = patch.formant
      return (
        <div className="controls-grid">
          <Knob label="Shift" min={-12} max={12} step={1} unit="st" value={f.shift} onChange={(x) => update((p) => { p.formant.shift = x })} />
          <Knob label="Size" min={0.5} max={2} value={f.size} onChange={(x) => update((p) => { p.formant.size = x })} />
          <Knob label="Robot" min={0} max={1} value={f.robot} onChange={(x) => update((p) => { p.formant.robot = x })} />
          <Knob label="Whisper" min={0} max={1} value={f.whisper} onChange={(x) => update((p) => { p.formant.whisper = x })} />
          <Knob label="Ring Hz" min={0} max={800} step={1} unit="Hz" value={f.ringHz} onChange={(x) => update((p) => { p.formant.ringHz = x })} />
          <Knob label="Ring" min={0} max={1} value={f.ringAmount} onChange={(x) => update((p) => { p.formant.ringAmount = x })} />
        </div>
      )
    }
    case 'follow': {
      const f = patch.follow
      return (
        <div className="controls-grid">
          <Knob label="Glide" min={0} max={1} value={f.glide} onChange={(x) => update((p) => { p.follow.glide = x })} />
          <Knob label="Blend" min={0} max={1} value={f.blend} onChange={(x) => update((p) => { p.follow.blend = x })} />
          <Knob label="Gate" min={0} max={1} value={f.confidenceGate} onChange={(x) => update((p) => { p.follow.confidenceGate = x })} />
          <Select label="Wave" value={f.wave} options={waveOptions} onChange={(w) => update((p) => { p.follow.wave = w })} />
        </div>
      )
    }
  }
}

export function FxControls({ patch, update }: Props) {
  const fx = patch.fx
  return (
    <div className="controls-grid">
      <Knob label="Drive" min={0} max={1} value={fx.drive} onChange={(x) => update((p) => { p.fx.drive = x })} />
      <Knob label="Chorus" min={0} max={1} value={fx.chorus} onChange={(x) => update((p) => { p.fx.chorus = x })} />
      <Knob label="Delay" min={0} max={1.5} unit="s" value={fx.delayTime} onChange={(x) => update((p) => { p.fx.delayTime = x })} />
      <Knob label="Fbk" min={0} max={0.95} value={fx.delayFeedback} onChange={(x) => update((p) => { p.fx.delayFeedback = x })} />
      <Knob label="Dly Mix" min={0} max={1} value={fx.delayMix} onChange={(x) => update((p) => { p.fx.delayMix = x })} />
      <Knob label="Reverb" min={0} max={1} value={fx.reverb} onChange={(x) => update((p) => { p.fx.reverb = x })} />
      <Toggle label="Sync" value={fx.delaySync} onChange={(b) => update((p) => { p.fx.delaySync = b })} />
    </div>
  )
}

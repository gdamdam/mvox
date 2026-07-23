// Per-engine parameter panels. Each reads its slice of the patch and calls
// update() with an immutable mutator. Ranges come from the single RANGES source
// so control bounds never drift from the sanitizer.

import { CARRIER_WAVES, RANGES, type MvoxPatch } from '../audio/contracts'
import { Knob, Select, Toggle } from './controls'
import { HarmonyVoices } from './HarmonyVoices'

interface Props {
  patch: MvoxPatch
  update: (mut: (p: MvoxPatch) => void) => void
}

const waveOptions = CARRIER_WAVES.map((w) => ({ value: w, label: w }))

// Voicing presets set the four voice intervals (scale-degree offsets) and how many
// voices are active — a quick starting point; per-voice knobs fine-tune from there.
type Quad = [number, number, number, number]
const VOICINGS: Record<string, { intervals: Quad; count: number }> = {
  Octaves: { intervals: [7, -7, 0, 0], count: 2 },
  '3rd + 5th': { intervals: [2, 4, 0, 0], count: 2 },
  Triad: { intervals: [2, 4, 7, 0], count: 3 },
  'Stacked 3rds': { intervals: [2, 4, 6, 8], count: 4 },
  Cluster: { intervals: [1, -1, 2, -2], count: 4 },
}
const voicingOptions = [{ value: '', label: 'Voicing…' }, ...Object.keys(VOICINGS).map((k) => ({ value: k, label: k }))]

export function ModeControls({ patch, update }: Props) {
  switch (patch.mode) {
    case 'vocoder': {
      const v = patch.vocoder
      return (
        <div className="controls-grid">
          <Knob label="Bands" min={RANGES.vocoderBands.min} max={RANGES.vocoderBands.max} step={1} value={v.bands} onChange={(x) => update((p) => { p.vocoder.bands = x })} />
          <Knob label="Bass" min={0} max={1} value={v.bassBoost} onChange={(x) => update((p) => { p.vocoder.bassBoost = x })} />
          <Knob label="Air/Sib" title="Sibilance/air band level (s and t sounds)" min={0} max={1} value={v.sibilance} onChange={(x) => update((p) => { p.vocoder.sibilance = x })} />
          <Knob label="Attack" title="Analysis-envelope attack" min={RANGES.vocoderAttack.min} max={RANGES.vocoderAttack.max} unit="ms" value={v.attack} onChange={(x) => update((p) => { p.vocoder.attack = x })} />
          <Knob label="Release" min={0} max={1} value={v.release} onChange={(x) => update((p) => { p.vocoder.release = x })} />
          <Knob label="Tone" title="Carrier low-pass (1 = open)" min={0} max={1} value={v.tone} onChange={(x) => update((p) => { p.vocoder.tone = x })} />
          <Knob label="Carrier" min={0} max={1} value={v.carrierMix} onChange={(x) => update((p) => { p.vocoder.carrierMix = x })} />
          <Knob label="Octave" title="Carrier transpose (octaves)" min={RANGES.vocoderCarrierOctave.min} max={RANGES.vocoderCarrierOctave.max} step={1} value={v.carrierOctave} onChange={(x) => update((p) => { p.vocoder.carrierOctave = x })} />
          <Knob label="Unison" title="Detuned carrier voices per note" min={RANGES.vocoderUnison.min} max={RANGES.vocoderUnison.max} step={1} value={v.unison} onChange={(x) => update((p) => { p.vocoder.unison = x })} />
          <Knob label="Uni ¢" title="Unison detune spread (cents)" min={0} max={50} unit="¢" value={v.unisonDetune} onChange={(x) => update((p) => { p.vocoder.unisonDetune = x })} />
          <Knob label="PW" title="Pulse width / duty (pulse wave)" min={RANGES.vocoderPulseWidth.min} max={RANGES.vocoderPulseWidth.max} value={v.pulseWidth} onChange={(x) => update((p) => { p.vocoder.pulseWidth = x })} />
          <Select label="Wave" value={v.carrierWave} options={waveOptions} onChange={(w) => update((p) => { p.vocoder.carrierWave = w })} />
          <Toggle label="Freeze" value={v.freeze} onChange={(b) => update((p) => { p.vocoder.freeze = b })} />
        </div>
      )
    }
    case 'harmony': {
      const h = patch.harmony
      const applyVoicing = (name: string) => {
        const preset = VOICINGS[name]
        if (!preset) return
        update((p) => {
          p.harmony.intervals = [...preset.intervals] as Quad
          p.harmony.voiceCount = preset.count
          for (let i = 0; i < 4; i += 1) p.harmony.voiceEnabled[i] = i < preset.count
        })
      }
      return (
        <div className="harmony-panel">
          <div className="controls-grid">
            <Knob label="Voices" min={0} max={4} step={1} value={h.voiceCount} onChange={(x) => update((p) => { p.harmony.voiceCount = x })} />
            <Knob label="Wet" title="Harmony voices level" min={0} max={1} value={h.level} onChange={(x) => update((p) => { p.harmony.level = x })} />
            <Knob label="Dry" title="Dry lead level" min={0} max={1} value={h.dryLevel} onChange={(x) => update((p) => { p.harmony.dryLevel = x })} />
            <Knob label="Spread" min={0} max={1} value={h.spread} onChange={(x) => update((p) => { p.harmony.spread = x })} />
            <Knob label="Detune" title="Global detune / humanize" min={0} max={50} unit="¢" value={h.detune} onChange={(x) => update((p) => { p.harmony.detune = x })} />
            <Knob label="Formant" min={0} max={1} value={h.formantPreserve} onChange={(x) => update((p) => { p.harmony.formantPreserve = x })} />
            <Knob label="Response" title="Pitch-shift glide response — 1 snaps instantly, lower glides" min={0} max={1} value={h.response} onChange={(x) => update((p) => { p.harmony.response = x })} />
            <Select label="Voicing" value="" options={voicingOptions} onChange={applyVoicing} />
            <Toggle label="Held keys" value={h.keyboardHarmony} onChange={(b) => update((p) => { p.harmony.keyboardHarmony = b })} />
          </div>
          <HarmonyVoices patch={patch} update={update} />
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
          <Knob label="Ring Hz" title="Ring modulator frequency" min={0} max={800} step={1} unit="Hz" value={f.ringHz} onChange={(x) => update((p) => { p.formant.ringHz = x })} />
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
          <Knob label="Gate" title="Pitch-confidence gate — higher ignores uncertain pitch" min={0} max={1} value={f.confidenceGate} onChange={(x) => update((p) => { p.follow.confidenceGate = x })} />
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
      <Knob label="Fbk" title="Delay feedback" min={0} max={0.95} value={fx.delayFeedback} onChange={(x) => update((p) => { p.fx.delayFeedback = x })} />
      <Knob label="Dly Mix" title="Delay wet/dry mix" min={0} max={1} value={fx.delayMix} onChange={(x) => update((p) => { p.fx.delayMix = x })} />
      <Knob label="Reverb" min={0} max={1} value={fx.reverb} onChange={(x) => update((p) => { p.fx.reverb = x })} />
      <Knob label="Ceiling" title="Output limiter ceiling" min={RANGES.fxLimiterCeiling.min} max={RANGES.fxLimiterCeiling.max} step={0.5} unit="dB" value={fx.limiterCeiling} onChange={(x) => update((p) => { p.fx.limiterCeiling = x })} />
      <Toggle label="Sync" value={fx.delaySync} onChange={(b) => update((p) => { p.fx.delaySync = b })} />
    </div>
  )
}

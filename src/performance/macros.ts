// Performance-surface parameter mapping: 4 macros + one assignable XY pad per
// engine mode. This is a PURE transform — given a base patch and the per-mode
// perf state stored on it, applyPerformance() produces a NEW effective patch to
// send to the engine without ever mutating the base.
//
// DESIGN — additive identity:
//   Every macro is defined so that v=0 is a strict no-op and v=1 is the full
//   curated push. We achieve this by interpolating each target param FROM its
//   current (base) value TOWARD a curated endpoint: lerp(base, endpoint, v).
//   At v=0 that returns `base` unchanged; at v=1 it lands on the endpoint. The
//   XY pad is bipolar around its centre (0.5, 0.5): the offset is scaled by
//   (t - 0.5) * 2, so the neutral centre contributes exactly zero.
//   Consequences: with all macros at 0 and XY at (0.5, 0.5), applyPerformance
//   returns a patch deep-equal to sanitizePatch(base) — a true identity — which
//   is what the tests assert. This keeps the surface predictable: performers can
//   always "zero out" back to the stored patch. Values are intentionally NOT
//   clamped inside each macro; a curated endpoint may push a param to its range
//   edge, and the whole result is funnelled through sanitizePatch() once at the
//   end so nothing out-of-range ever reaches the DSP core.

import type { MvoxPatch, EngineMode } from '../audio/contracts'
import { RANGES, sanitizePatch } from '../audio/contracts'

export interface MacroDef {
  name: string
  // Mutates `patch` in place. `v` is the macro position in 0..1.
  apply: (patch: MvoxPatch, v: number) => void
}

export interface XYDef {
  xName: string
  yName: string
  // Mutates `patch` in place. `x`/`y` are pad coordinates in 0..1 (0.5 = neutral).
  apply: (patch: MvoxPatch, x: number, y: number) => void
}

// lerp(base -> endpoint) so t=0 is identity and t=1 hits the curated endpoint.
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

// Bipolar mapping for XY: centre (0.5) -> 0, so the pad rest position is neutral.
const bip = (t: number): number => (t - 0.5) * 2

// "Space" behaves identically across the modes that expose it (add air via
// reverb + delay), so it is defined once and shared. Primary target: fx.reverb.
const spaceMacro: MacroDef = {
  name: 'Space',
  apply: (p, v) => {
    p.fx.reverb = lerp(p.fx.reverb, RANGES.fxReverb.max, v)
    p.fx.delayMix = lerp(p.fx.delayMix, RANGES.fxDelayMix.max, v)
  },
}

export const MACROS: Record<EngineMode, [MacroDef, MacroDef, MacroDef, MacroDef]> = {
  vocoder: [
    // Bands: coarse->fine resynthesis by opening up the vocoder band count.
    { name: 'Bands', apply: (p, v) => { p.vocoder.bands = lerp(p.vocoder.bands, RANGES.vocoderBands.max, v) } },
    // Air: push HF/unvoiced passthrough, with a touch of reverb for sheen.
    { name: 'Air', apply: (p, v) => { p.vocoder.sibilance = lerp(p.vocoder.sibilance, RANGES.vocoderSibilance.max, v); p.fx.reverb += 0.25 * v } },
    // Growl: low-end emphasis plus saturation for a gritty, chesty tone.
    { name: 'Growl', apply: (p, v) => { p.vocoder.bassBoost = lerp(p.vocoder.bassBoost, RANGES.vocoderBassBoost.max, v); p.fx.drive += 0.6 * v } },
    spaceMacro,
  ],
  harmony: [
    // Voices: from unison up to the full four harmony voices.
    { name: 'Voices', apply: (p, v) => { p.harmony.voiceCount = lerp(p.harmony.voiceCount, RANGES.harmonyVoiceCount.max, v) } },
    // Width: stereo spread widened together with per-voice detune.
    { name: 'Width', apply: (p, v) => { p.harmony.spread = lerp(p.harmony.spread, RANGES.harmonySpread.max, v); p.harmony.detune = lerp(p.harmony.detune, RANGES.harmonyDetune.max, v) } },
    // Blend: how loud the harmony voices sit under the lead.
    { name: 'Blend', apply: (p, v) => { p.harmony.level = lerp(p.harmony.level, RANGES.harmonyLevel.max, v) } },
    spaceMacro,
  ],
  formant: [
    // Shift: spectral-envelope shift swept from base toward the +12 st extreme.
    { name: 'Shift', apply: (p, v) => { p.formant.shift = lerp(p.formant.shift, RANGES.formantShift.max, v) } },
    // Size: gender/size morph toward the "larger" end of the range.
    { name: 'Size', apply: (p, v) => { p.formant.size = lerp(p.formant.size, RANGES.formantSize.max, v) } },
    // Robot: pitch-flatten, with a hint of whisper excitation for texture.
    { name: 'Robot', apply: (p, v) => { p.formant.robot = lerp(p.formant.robot, RANGES.formantRobot.max, v); p.formant.whisper += 0.3 * v } },
    // Ring: ring-mod amount plus its frequency for metallic overtones.
    { name: 'Ring', apply: (p, v) => { p.formant.ringAmount = lerp(p.formant.ringAmount, RANGES.formantRingAmount.max, v); p.formant.ringHz = lerp(p.formant.ringHz, RANGES.formantRingHz.max, v) } },
  ],
  follow: [
    // Glide: portamento time of the pitch-following synth.
    { name: 'Glide', apply: (p, v) => { p.follow.glide = lerp(p.follow.glide, RANGES.followGlide.max, v) } },
    // Blend: synth-vs-voice mix. Base default is fully synth (1.0), so this macro
    // sweeps DOWNWARD toward the dry voice; v=1 = all voice. Primary target still
    // changes monotonically, just in the decreasing direction.
    { name: 'Blend', apply: (p, v) => { p.follow.blend = lerp(p.follow.blend, RANGES.followBlend.min, v) } },
    // Tone: the follow engine has no timbre param of its own, so Tone reaches the
    // shared fx.drive to add harmonic edge to the synth tone.
    { name: 'Tone', apply: (p, v) => { p.fx.drive = lerp(p.fx.drive, 0.8, v) } },
    spaceMacro,
  ],
}

export const XY: Record<EngineMode, XYDef> = {
  // Half-spans are chosen so the pad reaches meaningfully into each param's range
  // from its centre; the final sanitizePatch() clamps any overshoot.
  vocoder: {
    xName: 'Sibilance',
    yName: 'BassBoost',
    apply: (p, x, y) => { p.vocoder.sibilance += bip(x) * 0.5; p.vocoder.bassBoost += bip(y) * 0.5 },
  },
  harmony: {
    xName: 'Spread',
    yName: 'Level',
    apply: (p, x, y) => { p.harmony.spread += bip(x) * 0.5; p.harmony.level += bip(y) * 0.5 },
  },
  formant: {
    xName: 'Shift',
    yName: 'Size',
    apply: (p, x, y) => { p.formant.shift += bip(x) * 12; p.formant.size += bip(y) * 0.75 },
  },
  follow: {
    xName: 'Glide',
    yName: 'Blend',
    apply: (p, x, y) => { p.follow.glide += bip(x) * 0.5; p.follow.blend += bip(y) * 0.5 },
  },
}

/**
 * Pure. Deep-clones `base`, reads base.perf[base.mode], applies that mode's 4
 * macros followed by its XY pad, then runs the result through sanitizePatch() so
 * the returned patch is always fully in range. Never mutates `base`.
 */
export function applyPerformance(base: MvoxPatch): MvoxPatch {
  const draft = structuredClone(base)
  const perf = base.perf[base.mode]
  const macros = MACROS[base.mode]
  for (let i = 0; i < 4; i++) macros[i].apply(draft, perf.macros[i])
  XY[base.mode].apply(draft, perf.xyX, perf.xyY)
  return sanitizePatch(draft)
}

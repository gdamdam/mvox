/**
 * Pure microtuning math for mvox HARMONY (snap + voice targets) and FOLLOW
 * (synth pitch), degree-indexed and tonic-anchored like mkeys/mraga — never the
 * C-anchored `midi % 12` table mchord regretted.
 *
 * Framework-free and Node-testable (no React/DOM/worklet globals). A tuning is
 * the vendored core's shape: `scaleCents[]` (ascending, `[0] === 0`, one entry
 * per degree within a period) + `period` in cents (1200 = octave, but non-octave
 * periods like Bohlen-Pierce resolve too). The absolute pitch of degree 0 —
 * `tonicHz` — is DERIVED from the selected key root's 12-TET pitch, so switching
 * the root transposes the whole tuning with it.
 *
 * The render-hot functions (snapHzToTuning, degreeOffsetHz) read a plain
 * cents array/Float32Array and allocate nothing; snapHzToTuning writes its result
 * into a caller-owned scratch object so the audio thread stays allocation-free.
 */

import { midiToHz } from './scale'

/** Hard cap on scale length — validated at every trust boundary (worklet /
 *  IndexedDB / URL), matching the suite's "clamp everything crossing" rule. */
export const TUNING_MAX_DEGREES = 128

/** Cap on the repeat period (cents). 4 octaves is far beyond any real scale and
 *  keeps the octave-search loop bounded. Must be > 0. */
export const TUNING_MAX_PERIOD = 4800

/** Result of snapping a frequency to a tuning: the degree index + how many whole
 *  periods above degree-0 it lands, and the resolved absolute frequency. */
export interface SnapResult {
  degree: number
  octave: number
  hz: number
}

/** A tuning resolved for the audio engine. `custom === false` means "use the
 *  legacy 12-TET scale-mode path" (an empty scale) — see engineCore. */
export interface ResolvedTuning {
  custom: boolean
  tonicHz: number
  periodCents: number
  cents: number[]
  count: number
}

const LEGACY: ResolvedTuning = { custom: false, tonicHz: 0, periodCents: 1200, cents: [], count: 0 }

/**
 * Validate + resolve a stored tuning (scaleCents + period + the selected root)
 * into engine-ready form. An empty scale, or any malformed one (non-finite,
 * non-ascending, not rooted at 0, over the length cap, non-positive/too-large
 * period, or a period not exceeding the top degree) resolves to the legacy
 * non-custom path so the DSP falls back to byte-identical 12-TET behaviour.
 */
export function resolveTuning(
  scaleCents: readonly number[],
  period: number,
  keyRoot: number,
): ResolvedTuning {
  if (!Array.isArray(scaleCents) || scaleCents.length === 0) return LEGACY
  if (scaleCents.length > TUNING_MAX_DEGREES) return LEGACY
  if (scaleCents[0] !== 0) return LEGACY
  for (let i = 0; i < scaleCents.length; i++) {
    const c = scaleCents[i]
    if (typeof c !== 'number' || !Number.isFinite(c)) return LEGACY
    if (i > 0 && c <= scaleCents[i - 1]) return LEGACY
  }
  if (typeof period !== 'number' || !Number.isFinite(period) || period <= 0 || period > TUNING_MAX_PERIOD) {
    return LEGACY
  }
  // The period must sit strictly above the last degree, or wraps overlap.
  if (scaleCents[scaleCents.length - 1] >= period) return LEGACY

  const tonicHz = midiToHz(((keyRoot % 12) + 12) % 12)
  return {
    custom: true,
    tonicHz,
    periodCents: period,
    cents: scaleCents.slice(),
    count: scaleCents.length,
  }
}

/**
 * Snap a frequency to the nearest tuning degree, searching the period the pitch
 * falls in plus its two neighbours so a pitch near a period boundary can snap to
 * the far side. Ties resolve to the lower pitch (the search visits ascending
 * absolute cents and keeps the first, strictly-closer match). Allocation-free:
 * pass `out` to reuse a scratch object on the render hot path.
 */
export function snapHzToTuning(
  hz: number,
  tonicHz: number,
  cents: readonly number[] | Float32Array,
  count: number,
  periodCents: number,
  out: SnapResult = { degree: 0, octave: 0, hz: 0 },
): SnapResult {
  if (!Number.isFinite(hz) || hz <= 0 || !Number.isFinite(tonicHz) || tonicHz <= 0 || count <= 0) {
    out.degree = 0
    out.octave = 0
    out.hz = tonicHz > 0 ? tonicHz : 0
    return out
  }
  const centsFromTonic = 1200 * Math.log2(hz / tonicHz)
  const base = Math.floor(centsFromTonic / periodCents)
  let bestDeg = 0
  let bestOct = base
  let bestDist = Infinity
  for (let oct = base - 1; oct <= base + 1; oct++) {
    const octCents = periodCents * oct
    for (let i = 0; i < count; i++) {
      const dist = Math.abs(cents[i] + octCents - centsFromTonic)
      if (dist < bestDist) {
        bestDist = dist
        bestDeg = i
        bestOct = oct
      }
    }
  }
  out.degree = bestDeg
  out.octave = bestOct
  out.hz = tonicHz * Math.pow(2, (cents[bestDeg] + periodCents * bestOct) / 1200)
  return out
}

/**
 * Frequency of the degree `offset` scale-steps away from (`baseDegree`,
 * `baseOctave`), carrying octaves through the period like mkeys'
 * `degreeOctaveToHz`: a +2 harmony voice on the top degree lands in the next
 * period. Allocation-free.
 */
export function degreeOffsetHz(
  baseDegree: number,
  baseOctave: number,
  offset: number,
  tonicHz: number,
  cents: readonly number[] | Float32Array,
  count: number,
  periodCents: number,
): number {
  if (count <= 0) return tonicHz
  const idx = baseDegree + offset
  const step = ((idx % count) + count) % count
  const carry = Math.floor(idx / count)
  return tonicHz * Math.pow(2, (cents[step] + periodCents * (baseOctave + carry)) / 1200)
}

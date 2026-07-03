/**
 * Pure music-theory core for mvox HARMONY mode and the key/scale selector.
 *
 * Framework-free and Node-testable: no React/DOM/Vite imports, no side effects.
 * Ported from mchord's `src/harmony/scales.ts` (SCALE_TABLE + mod12 shape) and
 * extended with a 'chromatic' passthrough mode plus MIDI/Hz/cents helpers so
 * the whole audio-domain math lives in one dependency-light module.
 */

export type Mode =
  | 'major'
  | 'natural-minor'
  | 'dorian'
  | 'mixolydian'
  | 'phrygian'
  | 'lydian'
  | 'harmonic-minor'
  | 'chromatic'

/**
 * Canonical mode order. APPEND-ONLY: these indices are reused as share-codec
 * values elsewhere, so reordering or removing entries would break saved links.
 * New modes must be added at the end only.
 */
export const MODES: readonly Mode[] = [
  'major',
  'natural-minor',
  'dorian',
  'mixolydian',
  'phrygian',
  'lydian',
  'harmonic-minor',
  'chromatic',
] as const

/** Pitch-class names, index === pitch class (C=0 … B=11). Sharps only. */
export const NOTE_NAMES: readonly string[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const

/**
 * Semitone interval sets (from tonic) for each heptatonic mode. Values match
 * mchord's SCALE_TABLE verbatim. 'chromatic' is intentionally absent here — it
 * is synthesised in scaleSemitones as all 12 pitch classes.
 */
const SCALE_TABLE: Record<Exclude<Mode, 'chromatic'>, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  'natural-minor': [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
}

/**
 * Normalise any integer (including negatives) to a pitch class 0–11.
 * Uses the double-mod idiom because JS `%` keeps the sign of the dividend.
 * Non-integer input is floored first so callers never leak fractional classes.
 */
export function mod12(n: number): number {
  if (!Number.isFinite(n)) return 0
  const i = Math.floor(n)
  return ((i % 12) + 12) % 12
}

/**
 * Ascending semitone intervals from the tonic for `mode`.
 * chromatic => [0..11] so every pitch class is "in scale" (snapping is a no-op).
 * Returns a fresh array so callers cannot mutate the shared table.
 */
export function scaleSemitones(mode: Mode): number[] {
  if (mode === 'chromatic') {
    return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  }
  return [...SCALE_TABLE[mode]]
}

/** The pitch classes of `mode` rooted at `root` (0–11), ascending from root. */
export function scalePitchClasses(root: number, mode: Mode): number[] {
  const r = mod12(root)
  return scaleSemitones(mode).map((iv) => mod12(r + iv))
}

/**
 * Snap a (possibly float) MIDI note to the nearest member of the key/scale.
 *
 * Strategy: search pitch-class distance outward from the input class (0,±1,±2…)
 * and pick the closest scale class. Ties resolve DOWN (per spec) by probing the
 * negative offset before the positive one. The chosen class is then placed in
 * whichever octave lands nearest the input MIDI, so the result is the closest
 * absolute pitch — e.g. snapping toward a class 1 semitone below never jumps an
 * octave up. chromatic returns the (rounded) input unchanged.
 */
export function snapMidiToScale(midi: number, root: number, mode: Mode): number {
  // Coerce non-finite input to 0 rather than returning it verbatim: callers
  // (diatonicHarmony) rely on the result always being an in-scale pitch class.
  const safeMidi = Number.isFinite(midi) ? midi : 0
  if (mode === 'chromatic') return Math.round(safeMidi)

  const rounded = Math.round(safeMidi)
  const inputClass = mod12(rounded)
  const pcs = scalePitchClasses(root, mode)

  // Find the nearest scale pitch class. Probe -d before +d so exact ties (d===6,
  // and the d=0.. loop's first equal-distance hit) resolve to the lower class.
  let bestClass = inputClass
  for (let d = 0; d <= 6; d++) {
    const down = mod12(inputClass - d)
    if (pcs.includes(down)) {
      bestClass = down
      break
    }
    const up = mod12(inputClass + d)
    if (pcs.includes(up)) {
      bestClass = up
      break
    }
  }

  // Place bestClass in the octave nearest `rounded`. Start from the input's
  // octave base, then nudge by ±12 if an adjacent octave is closer.
  const base = rounded - inputClass
  let best = base + bestClass
  for (const cand of [best - 12, best + 12]) {
    if (Math.abs(cand - rounded) < Math.abs(best - rounded)) {
      best = cand
    }
  }
  return best
}

/**
 * Diatonic harmony voice: snap `midi` into the scale, then move it by
 * `degreeOffset` scale-degrees (may be negative), preserving octave wrap so the
 * interval stays diatonic. e.g. +2 on C (C major) => E; -3 wraps down an octave.
 * chromatic has no degrees, so we shift by whole semitones instead.
 */
export function diatonicHarmony(
  midi: number,
  root: number,
  mode: Mode,
  degreeOffset: number,
): number {
  const snapped = snapMidiToScale(midi, root, mode)
  const offset = Number.isFinite(degreeOffset) ? Math.trunc(degreeOffset) : 0
  if (offset === 0) return snapped

  if (mode === 'chromatic') {
    // No scale degrees: treat one "degree" as one semitone.
    return snapped + offset
  }

  const pcs = scalePitchClasses(root, mode)
  const n = pcs.length
  const snappedClass = mod12(snapped)
  const startIdx = pcs.indexOf(snappedClass)
  // snapped is guaranteed diatonic, so startIdx is always >= 0.
  const targetIdx = startIdx + offset

  // How many octaves we cross (floor handles negatives correctly).
  const octaveShift = Math.floor(targetIdx / n)
  const wrappedIdx = ((targetIdx % n) + n) % n

  // Semitone distance within the scale, from start degree to target degree,
  // ignoring octaves; the octaveShift term re-adds the crossed octaves.
  const semitoneDelta = pcs[wrappedIdx] - pcs[startIdx] + octaveShift * 12
  return snapped + semitoneDelta
}

/** Float MIDI note number for a frequency in Hz (A4 = MIDI 69 = 440 Hz). */
export function hzToMidi(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return 0
  return 69 + 12 * Math.log2(hz / 440)
}

/** Frequency in Hz for a (float) MIDI note number. */
export function midiToHz(midi: number): number {
  if (!Number.isFinite(midi)) return 0
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * Cents deviation of frequency `hz` from the pitch of MIDI note `midi`.
 * Positive => `hz` is sharp of the note. 1200 cents === one octave.
 */
export function centsOff(hz: number, midi: number): number {
  const ref = midiToHz(midi)
  if (!Number.isFinite(hz) || hz <= 0 || ref <= 0) return 0
  return 1200 * Math.log2(hz / ref)
}

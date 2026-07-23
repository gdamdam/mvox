import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, type MvoxPatch } from '../contracts'
import { MvoxEngineCore } from './engineCore'

const FS = 48000
const BLOCK = 128

function sineBlock(freq: number, start: number): Float32Array {
  const b = new Float32Array(BLOCK)
  const w = (2 * Math.PI * freq) / FS
  for (let i = 0; i < BLOCK; i += 1) b[i] = 0.6 * Math.sin(w * (start + i))
  return b
}

// Sum of |L|+|R| over the settled block — a stable scalar signature of the
// engine's output for a fixed deterministic input.
function runSignature(patch: MvoxPatch, freq: number): number {
  const eng = new MvoxEngineCore(FS)
  eng.setLiveInput(true)
  eng.setPatch(patch)
  const oL = new Float32Array(BLOCK)
  const oR = new Float32Array(BLOCK)
  for (let b = 0; b < 80; b += 1) eng.process(sineBlock(freq, b * BLOCK), oL, oR)
  let s = 0
  for (let i = 0; i < BLOCK; i += 1) s += Math.abs(oL[i]) + Math.abs(oR[i])
  return s
}

function bench(mode: 'harmony' | 'follow'): MvoxPatch {
  const p = structuredClone(DEFAULT_PATCH) as MvoxPatch
  p.mode = mode
  p.shared.monitorMix = 0
  p.fx.drive = 0
  p.fx.chorus = 0
  p.fx.delayMix = 0
  p.fx.reverb = 0
  if (mode === 'harmony') p.harmony.voiceCount = 3
  return p
}

describe('MvoxEngineCore — 12-TET byte-identical regression', () => {
  // Golden signatures captured from the engine BEFORE microtuning was added
  // (default patch, empty tuning). The default tuning must produce byte-
  // identical output — same snap targets, same harmony intervals, same Hz.
  //
  // GOLDEN_HARMONY was re-captured when default pitch smoothing (tracking.smoothing
  // = 0.2) was introduced: HARMONY's shift is a continuous function of the detected
  // f0, so smoothing the (slightly wobbling) f0 shifts the settled output by ~1e-4.
  // FOLLOW is unaffected because its target is a discrete scale-snapped note, so
  // smoothing the f0 does not move it — GOLDEN_FOLLOW is the original value.
  const GOLDEN_HARMONY = 120.08689869288355
  const GOLDEN_FOLLOW = 55.45544666843489

  it('default-tuning HARMONY output is unchanged to the last bit', () => {
    expect(runSignature(bench('harmony'), 220)).toBe(GOLDEN_HARMONY)
  })

  it('default-tuning FOLLOW output is unchanged to the last bit', () => {
    expect(runSignature(bench('follow'), 330)).toBe(GOLDEN_FOLLOW)
  })

  it('a patch with the tuning field entirely absent sounds identical to the default', () => {
    const p = bench('follow')
    delete (p.shared as Partial<MvoxPatch['shared']>).tuning
    expect(runSignature(p, 330)).toBe(GOLDEN_FOLLOW)
  })
})

describe('MvoxEngineCore — active microtuning', () => {
  const JI5 = [0, 111.73, 203.91, 315.64, 386.31, 498.04, 582.51, 701.96, 813.69, 884.36, 996.09, 1088.27]

  it('a non-12-TET tuning changes the HARMONY output (new path engages)', () => {
    const def = bench('harmony')
    const tuned = bench('harmony')
    tuned.shared.tuning = { name: 'Just 5-limit', scaleCents: JI5, period: 1200 }
    const dSig = runSignature(def, 220)
    const tSig = runSignature(tuned, 220)
    expect(Math.abs(dSig - tSig)).toBeGreaterThan(1e-4)
  })

  it('a non-octave tuning changes the FOLLOW output', () => {
    const period = 1200 * Math.log2(3)
    const bp = Array.from({ length: 13 }, (_, i) => (i * period) / 13)
    const tuned = bench('follow')
    tuned.shared.tuning = { name: 'Bohlen-Pierce', scaleCents: bp, period }
    expect(Math.abs(runSignature(bench('follow'), 330) - runSignature(tuned, 330))).toBeGreaterThan(1e-4)
  })
})

describe('MvoxEngineCore — FOLLOW retarget across a fine tuning', () => {
  // 24-EDO: 24 quarter-tone degrees per octave. The even degrees land exactly on
  // 12-TET semitones; the odd degrees sit BETWEEN them. With keyRoot 0 the tonic
  // is a 12-TET pitch, so every degree is either an integer or a half-integer
  // MIDI note — which lets us classify a target without knowing the tonic Hz.
  const EDO24 = Array.from({ length: 24 }, (_, i) => i * 50)

  it('a slow sweep reaches BOTH semitone and between-semitone (quarter-tone) degrees', () => {
    // Regression for the rounded-MIDI retarget gate: the sung pitch can cross a
    // 24-EDO degree WITHOUT changing its rounded 12-TET MIDI, so gating on rounded
    // MIDI made ~half the degrees unreachable. Gating on the resolved degree makes
    // every degree reachable as the pitch sweeps through it.
    const p = bench('follow')
    p.shared.keyRoot = 0
    p.follow.confidenceGate = 0.3 // clean sine → high confidence; keep the gate open
    p.shared.tuning = { name: '24-EDO', scaleCents: EDO24, period: 1200 }

    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    eng.setPatch(p)

    // Exponential sweep 220 -> 440 Hz over ~2 s: exactly one octave (24 degrees),
    // slow enough that each degree persists for many render blocks.
    const durSec = 2
    const total = FS * durSec
    const f0 = 220
    const f1 = 440
    const oL = new Float32Array(BLOCK)
    const oR = new Float32Array(BLOCK)

    let phase = 0
    let sample = 0
    // Distinct target frequencies visited (rounded to 0.01 Hz to fold FP noise).
    const targets = new Set<string>()
    while (sample < total) {
      const buf = new Float32Array(BLOCK)
      for (let i = 0; i < BLOCK; i += 1) {
        const t = sample / total
        const f = f0 * Math.pow(f1 / f0, t)
        buf[i] = 0.6 * Math.sin(phase)
        phase += (2 * Math.PI * f) / FS
        sample += 1
      }
      eng.process(buf, oL, oR)
      const tgt = eng.followTargetHzForTest
      if (tgt > 0) targets.add(tgt.toFixed(2))
    }

    // Classify each visited target as on-semitone or between-semitone by its
    // 12-TET MIDI: integer -> semitone, half-integer -> quarter-tone.
    let semitone = 0
    let quarterTone = 0
    for (const s of targets) {
      const hz = Number(s)
      const midi = 69 + 12 * Math.log2(hz / 440)
      const frac = Math.abs(midi - Math.round(midi))
      if (frac < 0.08) semitone += 1
      else if (Math.abs(frac - 0.5) < 0.08) quarterTone += 1
    }

    // Both classes must be well represented. With the bug only one class is ever
    // targeted (the retarget fires only at rounded-MIDI boundaries), so the other
    // class collapses to ~0 and this fails.
    expect(semitone).toBeGreaterThanOrEqual(6)
    expect(quarterTone).toBeGreaterThanOrEqual(6)
    // Sanity: a full octave of 24-EDO offers 24 degrees; the fix reaches most.
    expect(targets.size).toBeGreaterThanOrEqual(18)
  })
})

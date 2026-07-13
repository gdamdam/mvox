import { describe, expect, it } from 'vitest'
import { midiToHz } from './scale'
import {
  degreeOffsetHz,
  resolveTuning,
  snapHzToTuning,
  TUNING_MAX_DEGREES,
  type SnapResult,
} from './microtuning'

// 12-EDO degree table (the same cents the vendored "Equal (12-TET)" preset ships).
const EDO12 = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]
// 5-limit just intonation (vendored "Just 5-limit").
const JI5 = [0, 111.73, 203.91, 315.64, 386.31, 498.04, 582.51, 701.96, 813.69, 884.36, 996.09, 1088.27]
// Bohlen-Pierce: 13 equal divisions of the tritave (3:1 = 1901.955¢). Non-octave.
const BP_PERIOD = 1200 * Math.log2(3) // 1901.955…
const BP_STEP = BP_PERIOD / 13
const BP = Array.from({ length: 13 }, (_, i) => i * BP_STEP) // degrees 0..12, period is the 13th
// A 7-degree octave scale for harmony-offset tests.
const MAJOR7 = [0, 200, 400, 500, 700, 900, 1100]

describe('resolveTuning', () => {
  it('treats an empty scale as the non-custom (legacy 12-TET) path', () => {
    const r = resolveTuning([], 1200, 0)
    expect(r.custom).toBe(false)
  })

  it('derives tonicHz from the selected root (tonic-anchored, transposes with root)', () => {
    // Root A (keyRoot 9): tonic pitch class must match 12-TET A.
    const r = resolveTuning(JI5, 1200, 9)
    expect(r.custom).toBe(true)
    expect(r.tonicHz).toBeCloseTo(midiToHz(9), 9)
    // Switching root to C (0) moves the tonic with it.
    const c = resolveTuning(JI5, 1200, 0)
    expect(c.tonicHz).toBeCloseTo(midiToHz(0), 9)
    expect(c.tonicHz).not.toBeCloseTo(r.tonicHz, 3)
  })

  it('rejects NaN cents, oversized tables, and non-positive periods to the legacy path', () => {
    expect(resolveTuning([0, NaN, 400], 1200, 0).custom).toBe(false)
    expect(resolveTuning([0, 100, 90], 1200, 0).custom).toBe(false) // non-ascending
    expect(resolveTuning([100, 200], 1200, 0).custom).toBe(false) // not rooted at 0
    expect(resolveTuning(EDO12, -1200, 0).custom).toBe(false) // negative period
    expect(resolveTuning(EDO12, 0, 0).custom).toBe(false) // zero period
    const huge = Array.from({ length: TUNING_MAX_DEGREES + 1 }, (_, i) => i)
    expect(resolveTuning(huge, TUNING_MAX_DEGREES + 5, 0).custom).toBe(false)
  })
})

describe('snapHzToTuning', () => {
  it('reproduces 12-TET note frequencies for a 12-EDO table', () => {
    const t = resolveTuning(EDO12, 1200, 9) // root A, tonic = A (13.75 Hz octave)
    // Sing A4 (440 Hz): exact tonic pitch class, must snap pure.
    const a4 = snapHzToTuning(440, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(a4.degree).toBe(0)
    expect(a4.hz).toBeCloseTo(440, 6)
    // Sing C5 (523.25 Hz, MIDI 72): degree 3 above A.
    const c5 = snapHzToTuning(midiToHz(72), t.tonicHz, t.cents, t.count, t.periodCents)
    expect(c5.hz).toBeCloseTo(midiToHz(72), 4)
    // A slightly-flat E5 snaps to the exact E of the scale.
    const e5 = snapHzToTuning(midiToHz(76) * 0.995, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(e5.hz).toBeCloseTo(midiToHz(76), 4)
  })

  it('snaps to the nearest just degree and keeps the tonic pure', () => {
    const t = resolveTuning(JI5, 1200, 0) // root C
    // Exactly the just major third (386.31¢): degree 4.
    const third = t.tonicHz * Math.pow(2, 386.31 / 1200)
    const s = snapHzToTuning(third, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(s.degree).toBe(4)
    expect(s.hz).toBeCloseTo(third, 6)
    // 350¢ is closer to degree 3 (315.64) than degree 4 (386.31).
    const between = t.tonicHz * Math.pow(2, 350 / 1200)
    expect(snapHzToTuning(between, t.tonicHz, t.cents, t.count, t.periodCents).degree).toBe(3)
    // Tonic (any octave) stays exactly on degree 0.
    const tonic2 = snapHzToTuning(t.tonicHz * 2, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(tonic2.degree).toBe(0)
    expect(tonic2.octave).toBe(1)
    expect(tonic2.hz).toBeCloseTo(t.tonicHz * 2, 6)
  })

  it('snaps across non-octave period wraps (Bohlen-Pierce)', () => {
    const t = resolveTuning(BP, BP_PERIOD, 0)
    expect(t.custom).toBe(true)
    // One tritave + one step above the tonic → degree 1, octave 1.
    const target = t.tonicHz * Math.pow(2, (BP_PERIOD + BP_STEP) / 1200)
    const s = snapHzToTuning(target, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(s.degree).toBe(1)
    expect(s.octave).toBe(1)
    expect(s.hz).toBeCloseTo(target, 4)
    // A pitch a little sharp of the top degree (12·step) — still nearer to it
    // than to the next tonic (degree 0 of octave 1) — snaps to degree 12,
    // octave 0, proving the wrap search checks adjacent periods.
    const nearTop = t.tonicHz * Math.pow(2, (BP_STEP * 12 + 25) / 1200)
    const top = snapHzToTuning(nearTop, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(top.degree).toBe(12)
    expect(top.octave).toBe(0)
  })

  it('writes into a provided scratch object without allocating', () => {
    const out: SnapResult = { degree: -1, octave: -1, hz: -1 }
    const t = resolveTuning(EDO12, 1200, 0)
    const ret = snapHzToTuning(t.tonicHz, t.tonicHz, t.cents, t.count, t.periodCents, out)
    expect(ret).toBe(out)
    expect(out.degree).toBe(0)
  })
})

describe('degreeOffsetHz', () => {
  it('moves by scale degrees within a 7-degree scale, wrapping octaves', () => {
    const t = resolveTuning(MAJOR7, 1200, 0)
    // From the tonic, +2 degrees is the major third (400¢).
    const up2 = degreeOffsetHz(0, 0, 2, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(up2).toBeCloseTo(t.tonicHz * Math.pow(2, 400 / 1200), 6)
    // -1 degree wraps down to the leading tone one octave below (1100 - 1200 = -100¢).
    const down1 = degreeOffsetHz(0, 0, -1, t.tonicHz, t.cents, t.count, t.periodCents)
    expect(down1).toBeCloseTo(t.tonicHz * Math.pow(2, -100 / 1200), 6)
  })

  it('carries octaves correctly in a non-7-degree scale (Bohlen-Pierce, 13 degrees)', () => {
    const t = resolveTuning(BP, BP_PERIOD, 0)
    // From the top degree (12) of octave 0, +2 degrees → degree 1 of octave 1.
    const hz = degreeOffsetHz(12, 0, 2, t.tonicHz, t.cents, t.count, t.periodCents)
    const expected = t.tonicHz * Math.pow(2, (t.cents[1] + BP_PERIOD * 1) / 1200)
    expect(hz).toBeCloseTo(expected, 4)
  })
})

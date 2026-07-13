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
  const GOLDEN_HARMONY = 120.08698529552203
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

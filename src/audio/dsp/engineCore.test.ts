import { describe, it, expect } from 'vitest'
import { DEFAULT_PATCH, type MvoxPatch } from '../contracts'
import { MvoxEngineCore } from './engineCore'

const FS = 48000
const BLOCK = 128

// A clean, easily-tracked sine so HARMONY reaches its voiced branch (pitch
// confidence > 0.4) and the pitch shifters actually run.
function sineBlock(freq: number, startSample: number, amp = 0.6): Float32Array {
  const buf = new Float32Array(BLOCK)
  const w = (2 * Math.PI * freq) / FS
  for (let i = 0; i < BLOCK; i += 1) buf[i] = amp * Math.sin(w * (startSample + i))
  return buf
}

// Build a HARMONY patch with all FX bypassed so the only source of L/R
// difference is the harmony spread we are testing.
function harmonyPatch(overrides: Partial<MvoxPatch['harmony']>): MvoxPatch {
  const p = structuredClone(DEFAULT_PATCH) as MvoxPatch
  p.mode = 'harmony'
  p.shared.monitorMix = 0
  p.harmony.voiceCount = 3
  Object.assign(p.harmony, overrides)
  p.fx.drive = 0
  p.fx.chorus = 0
  p.fx.delayMix = 0
  p.fx.reverb = 0
  return p
}

// Run the engine live for `blocks` render quanta of a steady sine, returning the
// last block's stereo output (after warmup: mode-switch fade settled + pitch
// locked). `capture` lets a test snapshot a specific block.
function runHarmony(patch: MvoxPatch, blocks = 80, freq = 220) {
  const eng = new MvoxEngineCore(FS)
  eng.setLiveInput(true)
  eng.setPatch(patch)
  const outL = new Float32Array(BLOCK)
  const outR = new Float32Array(BLOCK)
  let f0 = 0
  let confidence = 0
  for (let b = 0; b < blocks; b += 1) {
    const input = sineBlock(freq, b * BLOCK)
    const tel = eng.process(input, outL, outR)
    f0 = tel.f0
    confidence = tel.confidence
  }
  return { outL: outL.slice(), outR: outR.slice(), f0, confidence }
}

function sumAbsDiff(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i])
  return s
}

describe('MvoxEngineCore HARMONY', () => {
  it('tracks the sine so harmony voices are engaged', () => {
    const { confidence, f0 } = runHarmony(harmonyPatch({}))
    // Sanity: the tests below are meaningless if the voice is never voiced.
    expect(confidence).toBeGreaterThan(0.4)
    expect(f0).toBeGreaterThan(0)
  })

  it('spread = 0 produces identical L/R (backward compatible)', () => {
    const { outL, outR } = runHarmony(harmonyPatch({ spread: 0 }))
    expect(sumAbsDiff(outL, outR)).toBeLessThan(1e-9)
  })

  it('spread > 0 pans harmony voices into a real stereo image', () => {
    const { outL, outR } = runHarmony(harmonyPatch({ spread: 1 }))
    // Panning must create an audible L/R difference the mono path never had.
    expect(sumAbsDiff(outL, outR)).toBeGreaterThan(0.01)
  })

  it('formantPreserve changes the shifted-voice timbre', () => {
    const off = runHarmony(harmonyPatch({ spread: 0, formantPreserve: 0 }))
    const on = runHarmony(harmonyPatch({ spread: 0, formantPreserve: 1 }))
    // The shelf tilt must measurably alter the output vs the raw granular shifter.
    expect(sumAbsDiff(off.outL, on.outL)).toBeGreaterThan(0.01)
  })
})

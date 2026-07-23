import { describe, it, expect } from 'vitest'
import { CarrierSynth } from './carrier'

const FS = 48000

/** Collect `n` mono output samples from a synth. */
function collect(synth: CarrierSynth, n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(synth.process())
  return out
}

/** A noise voice at full velocity, past its attack ramp. */
function settledNoise(midi = 69): CarrierSynth {
  const s = new CarrierSynth(FS)
  s.setWave('noise')
  s.noteOn(midi, 1)
  for (let i = 0; i < 512; i++) s.process() // settle the attack envelope
  return s
}

// --- Noise oscillator (regression for the `x / 0x7fffffff` distribution) ------
// The old oscillator applied a redundant `% 1` that was a no-op for in-range
// values yet silently zeroed the ±full-scale endpoints. These tests pin the
// corrected behavior: deterministic, bounded, bipolar, ~zero-mean noise.

describe('CarrierSynth noise oscillator', () => {
  it('produces finite, bounded, bipolar noise with no DC offset', () => {
    const s = settledNoise()
    const xs = collect(s, 20000)
    expect(xs.every(Number.isFinite)).toBe(true)

    let min = Infinity
    let max = -Infinity
    let sum = 0
    for (const x of xs) {
      if (x < min) min = x
      if (x > max) max = x
      sum += x
    }
    // Bounded within the carrier's 0.4 headroom scaling (noise ∈ ~[-1,1]).
    expect(max).toBeLessThanOrEqual(0.5)
    expect(min).toBeGreaterThanOrEqual(-0.5)
    // Genuinely bipolar — not a rectified / one-sided distribution.
    expect(min).toBeLessThan(-0.05)
    expect(max).toBeGreaterThan(0.05)
    // Near-zero long-term mean: no strong DC offset. (20k samples, SE ≈ 0.0016.)
    expect(Math.abs(sum / xs.length)).toBeLessThan(0.01)
  })

  it('is deterministic and reproducible from the fixed per-voice seed', () => {
    const a = new CarrierSynth(FS)
    a.setWave('noise')
    a.noteOn(60, 1)
    const b = new CarrierSynth(FS)
    b.setWave('noise')
    b.noteOn(60, 1)
    expect(collect(a, 5000)).toEqual(collect(b, 5000))
  })

  it('has no short cycle (xorshift period, not a repeating table)', () => {
    const s = settledNoise(72)
    const xs = collect(s, 2000)
    // A short-period generator would revisit a small value set; a healthy PRNG
    // keeps almost every 32-bit-derived sample distinct.
    expect(new Set(xs).size).toBeGreaterThan(1000)
  })
})

// --- Voice allocation / ownership --------------------------------------------

describe('CarrierSynth voice ownership', () => {
  it('panic() clears every voice and silences output immediately', () => {
    const s = new CarrierSynth(FS)
    s.setWave('saw')
    s.noteOn(60, 1)
    s.noteOn(64, 1)
    for (let i = 0; i < 256; i++) s.process()
    expect(s.activeCount()).toBeGreaterThan(0)
    s.panic()
    expect(s.activeCount()).toBe(0)
    expect(s.process()).toBe(0)
  })

  it('a note-off for a stolen voice\'s old pitch does not release the stealer', () => {
    // MAX_VOICES is 8; playing 9 distinct notes forces the 9th to steal the
    // oldest (midi 60). A stale note-off for 60 must find no owner and release
    // nothing — the stolen slot now belongs to 68.
    const s = new CarrierSynth(FS)
    s.setWave('saw')
    for (let m = 60; m <= 68; m++) {
      s.noteOn(m, 1)
      s.process()
    }
    expect(s.activeCount()).toBe(8)
    s.noteOff(60) // 60's ownership was transferred to 68 on steal
    for (let i = 0; i < 8; i++) s.process()
    // All 8 voices still sounding: the stale off matched nothing.
    expect(s.activeCount()).toBe(8)
  })

  it('reset() restores a silent initial state', () => {
    const s = new CarrierSynth(FS)
    s.setWave('saw')
    s.noteOn(60, 1)
    for (let i = 0; i < 128; i++) s.process()
    s.reset()
    expect(s.activeCount()).toBe(0)
    expect(s.process()).toBe(0)
  })
})

// --- Carrier shaping: transpose / unison / pulse width ------------------------

/** Count positive-going zero crossings → fundamental Hz over the window. */
function zeroCrossHz(xs: number[]): number {
  let crossings = 0
  for (let i = 1; i < xs.length; i++) {
    if (xs[i - 1] < 0 && xs[i] >= 0) crossings += 1
  }
  return (crossings * FS) / xs.length
}

/** Fraction of samples that are strictly positive. */
function posFraction(xs: number[]): number {
  let p = 0
  for (const x of xs) if (x > 0) p += 1
  return p / xs.length
}

/** A settled saw voice; optional transpose (semitones). */
function settledSaw(midi: number, transpose?: number): CarrierSynth {
  const s = new CarrierSynth(FS)
  s.setWave('saw')
  if (transpose !== undefined) s.setTranspose(transpose)
  s.noteOn(midi, 1)
  for (let i = 0; i < 512; i++) s.process()
  return s
}

describe('CarrierSynth transpose', () => {
  it('setTranspose(+12) doubles the detected pitch; default tracks the note', () => {
    const base = zeroCrossHz(collect(settledSaw(69), 24000)) // A4 = 440 Hz
    expect(base).toBeGreaterThan(430)
    expect(base).toBeLessThan(450)
    const up = zeroCrossHz(collect(settledSaw(69, 12), 24000))
    expect(up / base).toBeGreaterThan(1.9)
    expect(up / base).toBeLessThan(2.1)
  })

  it('setTranspose(0) is bit-identical to no transpose', () => {
    const a = new CarrierSynth(FS)
    a.setWave('saw')
    a.setTranspose(0)
    a.noteOn(60, 1)
    const b = new CarrierSynth(FS)
    b.setWave('saw')
    b.noteOn(60, 1)
    expect(collect(a, 4000)).toEqual(collect(b, 4000))
  })
})

describe('CarrierSynth unison', () => {
  it('unison=1, detune=0 is bit-identical to the single-oscillator path', () => {
    const a = new CarrierSynth(FS)
    a.setWave('saw')
    a.setUnison(1, 0)
    a.noteOn(60, 1)
    const b = new CarrierSynth(FS)
    b.setWave('saw')
    b.noteOn(60, 1)
    expect(collect(a, 4000)).toEqual(collect(b, 4000))
  })

  it('unison=3 with detune spreads the carrier vs a single oscillator', () => {
    const single = new CarrierSynth(FS)
    single.setWave('saw')
    single.setUnison(1, 0)
    single.noteOn(60, 1)
    const uni = new CarrierSynth(FS)
    uni.setWave('saw')
    uni.setUnison(3, 25)
    uni.noteOn(60, 1)
    for (let i = 0; i < 512; i++) {
      single.process()
      uni.process()
    }
    const a = collect(single, 8000)
    const b = collect(uni, 8000)
    let diff = 0
    let energy = 0
    for (let i = 0; i < a.length; i++) {
      diff += Math.abs(a[i] - b[i])
      energy += b[i] * b[i]
    }
    // Detuned stack diverges from the single oscillator (audible spread/beating)...
    expect(diff).toBeGreaterThan(1)
    // ...while still producing real carrier energy (not muted by the normalization).
    expect(energy).toBeGreaterThan(0)
  })
})

describe('CarrierSynth pulse width', () => {
  function settledPulse(pw?: number): CarrierSynth {
    const s = new CarrierSynth(FS)
    s.setWave('pulse')
    if (pw !== undefined) s.setPulseWidth(pw)
    s.noteOn(69, 1)
    for (let i = 0; i < 512; i++) s.process()
    return s
  }

  it('setPulseWidth changes the duty cycle (positive fraction)', () => {
    const square = posFraction(collect(settledPulse(0.5), 24000))
    const narrow = posFraction(collect(settledPulse(0.2), 24000))
    expect(square).toBeGreaterThan(0.4)
    expect(square).toBeLessThan(0.6)
    expect(narrow).toBeLessThan(0.35)
    expect(narrow).toBeLessThan(square - 0.1)
  })

  it('setPulseWidth(0.5) is bit-identical to the default two-saw square', () => {
    const a = new CarrierSynth(FS)
    a.setWave('pulse')
    a.setPulseWidth(0.5)
    a.noteOn(60, 1)
    const b = new CarrierSynth(FS)
    b.setWave('pulse')
    b.noteOn(60, 1)
    expect(collect(a, 4000)).toEqual(collect(b, 4000))
  })
})

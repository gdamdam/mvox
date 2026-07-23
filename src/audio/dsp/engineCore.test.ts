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

  it('disabling a voice removes only its contribution', () => {
    // Center everything (spread 0) so all voices land in mono and a disabled
    // voice's absence is a pure level change, not a pan artifact.
    const all = runHarmony(harmonyPatch({ spread: 0 }))
    const off1 = runHarmony(harmonyPatch({ spread: 0, voiceEnabled: [true, false, true, true] }))
    // Voice 1 gone → the output changes...
    expect(sumAbsDiff(all.outL, off1.outL)).toBeGreaterThan(0.01)
    // ...but disabling the SAME already-inactive voice again is a no-op vs off1
    // (voiceCount is 3, so voice 3 never renders regardless).
    const off1and3 = runHarmony(
      harmonyPatch({ spread: 0, voiceEnabled: [true, false, true, false] }),
    )
    expect(sumAbsDiff(off1.outL, off1and3.outL)).toBeLessThan(1e-9)
  })

  it('per-voice level 0 mutes just that voice (like disabling it)', () => {
    const muted = runHarmony(harmonyPatch({ spread: 0, voiceLevel: [1, 0, 1, 1] }))
    const disabled = runHarmony(harmonyPatch({ spread: 0, voiceEnabled: [true, false, true, true] }))
    // level 0 still runs the shifter but contributes nothing → same as disabled.
    expect(sumAbsDiff(muted.outL, disabled.outL)).toBeLessThan(1e-9)
  })

  it('per-voice detune shifts just that voice', () => {
    const base = runHarmony(harmonyPatch({ spread: 0 }))
    const detuned = runHarmony(harmonyPatch({ spread: 0, voiceDetune: [0, 40, 0, 0] }))
    expect(sumAbsDiff(base.outL, detuned.outL)).toBeGreaterThan(0.001)
  })

  it('dryLevel scales the lead; default 1 is unchanged, 0 removes the dry voice', () => {
    // With no harmony voices the output IS the dry lead, so dryLevel is a clean
    // scalar on it. voiceCount 0 → only the dry path contributes.
    const unity = runHarmony(harmonyPatch({ voiceCount: 0, spread: 0, dryLevel: 1 }))
    const half = runHarmony(harmonyPatch({ voiceCount: 0, spread: 0, dryLevel: 0.5 }))
    const zero = runHarmony(harmonyPatch({ voiceCount: 0, spread: 0, dryLevel: 0 }))
    let uSum = 0
    let hSum = 0
    let zSum = 0
    for (let i = 0; i < BLOCK; i += 1) {
      uSum += Math.abs(unity.outL[i])
      hSum += Math.abs(half.outL[i])
      zSum += Math.abs(zero.outL[i])
    }
    expect(uSum).toBeGreaterThan(0)
    expect(hSum).toBeCloseTo(uSum * 0.5, 5)
    expect(zSum).toBeLessThan(1e-9)
  })
})

// Build a VOCODER patch with FX bypassed and monitor off so the only possible
// output source is the vocoder engine itself.
function vocoderPatch(overrides: Partial<MvoxPatch['vocoder']>): MvoxPatch {
  const p = structuredClone(DEFAULT_PATCH) as MvoxPatch
  p.mode = 'vocoder'
  p.shared.monitorMix = 0
  Object.assign(p.vocoder, overrides)
  p.fx.drive = 0
  p.fx.chorus = 0
  p.fx.delayMix = 0
  p.fx.reverb = 0
  return p
}

describe('MvoxEngineCore VOCODER', () => {
  it('silent voice input + held notes + bassBoost > 0 produces silence (no drone)', () => {
    // Regression: the bass-boost term reinforced the CARRIER (which runs
    // continuously from held notes), so a held chord droned a low tone even with
    // no voice input. The boost is now gated by the voice low-band envelope, so
    // silence in must yield silence out.
    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    eng.setPatch(vocoderPatch({ bassBoost: 1, sibilance: 0 }))
    // Hold a low chord so the carrier is definitely running.
    eng.noteOn(40, 1)
    eng.noteOn(47, 1)

    const silence = new Float32Array(BLOCK) // all zeros
    const outL = new Float32Array(BLOCK)
    const outR = new Float32Array(BLOCK)
    let peak = 0
    for (let b = 0; b < 200; b += 1) {
      eng.process(silence, outL, outR)
      for (let i = 0; i < BLOCK; i += 1) {
        peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]))
      }
    }
    // With the bug this drones audibly (>> 0.01); gated bass keeps it at zero.
    expect(peak).toBeLessThan(1e-9)
  })

  it('voiced input with bassBoost > 0 still produces output', () => {
    // Guard against "fix by muting everything": real voice input must still drive
    // the vocoder (the bass gate opens on voiced low-band energy).
    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    eng.setPatch(vocoderPatch({ bassBoost: 1 }))
    eng.noteOn(40, 1)
    eng.noteOn(47, 1)
    const outL = new Float32Array(BLOCK)
    const outR = new Float32Array(BLOCK)
    let peak = 0
    for (let b = 0; b < 200; b += 1) {
      eng.process(sineBlock(150, b * BLOCK), outL, outR)
      for (let i = 0; i < BLOCK; i += 1) peak = Math.max(peak, Math.abs(outL[i]))
    }
    expect(peak).toBeGreaterThan(0.001)
  })

  // Golden signature of the DEFAULT vocoder (voiced input + a held chord, FX off).
  // Captured before the tone/freeze/attack params were added; the new defaults
  // (attack 3, tone 1 = bypass, freeze false) must keep this byte-identical.
  const GOLDEN_VOCODER = 70.818986000726

  // Run the vocoder with a steady sine voice over a held chord and return the
  // settled block's |L|+|R| sum plus its peak.
  function runVocoder(overrides: Partial<MvoxPatch['vocoder']>, voiceAmp = 0.6, blocks = 80) {
    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    eng.setPatch(vocoderPatch(overrides))
    eng.noteOn(48, 1)
    eng.noteOn(55, 1)
    const oL = new Float32Array(BLOCK)
    const oR = new Float32Array(BLOCK)
    for (let b = 0; b < blocks; b += 1) {
      const input = voiceAmp > 0 ? sineBlock(220, b * BLOCK, voiceAmp) : new Float32Array(BLOCK)
      eng.process(input, oL, oR)
    }
    let sig = 0
    let peak = 0
    for (let i = 0; i < BLOCK; i += 1) {
      sig += Math.abs(oL[i]) + Math.abs(oR[i])
      peak = Math.max(peak, Math.abs(oL[i]))
    }
    return { sig, peak, oL: oL.slice() }
  }

  it('default vocoder output is byte-identical to the golden signature', () => {
    expect(runVocoder({}).sig).toBe(GOLDEN_VOCODER)
  })

  it('tone = 1 is bypassed → identical to the default (golden) output', () => {
    // tone default is 1; setting it explicitly must still take the bypass path.
    expect(runVocoder({ tone: 1 }).sig).toBe(GOLDEN_VOCODER)
  })

  it('tone < 1 darkens the carrier (lower output energy) and silence stays silent', () => {
    const open = runVocoder({ tone: 1 }).sig
    const dark = runVocoder({ tone: 0.05 }).sig
    // Low-passing the carrier removes high-band energy → measurably less output.
    expect(dark).toBeLessThan(open)
    // A darkened carrier must not resurrect a drone: silent voice → silent out.
    const silent = runVocoder({ tone: 0.05, bassBoost: 0, sibilance: 0 }, 0, 200).peak
    expect(silent).toBeLessThan(1e-9)
  })

  it('freeze holds the pad when the voice goes silent; unfrozen it decays', () => {
    // Warm each engine on a voiced tone, then feed silence and compare the tail.
    // bassBoost/sibilance off so the comparison isolates the frozen band pad.
    const settle = (freeze: boolean) => {
      const eng = new MvoxEngineCore(FS)
      eng.setLiveInput(true)
      // Warm up UNFROZEN so the band envelopes charge on the voiced tone — freeze
      // holds whatever level is present, so it must be engaged after playing (as
      // in real use), not from a cold start where the envelopes are still zero.
      eng.setPatch(vocoderPatch({ freeze: false, bassBoost: 0, sibilance: 0 }))
      eng.noteOn(48, 1)
      eng.noteOn(55, 1)
      const oL = new Float32Array(BLOCK)
      const oR = new Float32Array(BLOCK)
      for (let b = 0; b < 80; b += 1) eng.process(sineBlock(220, b * BLOCK), oL, oR)
      // Engage freeze (or not) now that the envelopes are warm.
      eng.setPatch(vocoderPatch({ freeze, bassBoost: 0, sibilance: 0 }))
      // Now a long stretch of silence: frozen holds the envelopes, unfrozen lets
      // them decay through the band release time (~81 ms) toward zero.
      let peak = 0
      for (let b = 0; b < 400; b += 1) {
        eng.process(new Float32Array(BLOCK), oL, oR)
        if (b >= 395) for (let i = 0; i < BLOCK; i += 1) peak = Math.max(peak, Math.abs(oL[i]))
      }
      return peak
    }
    const frozen = settle(true)
    const decayed = settle(false)
    expect(decayed).toBeLessThan(1e-3) // envelopes follow the silence down
    expect(frozen).toBeGreaterThan(0.01) // pad sustains from the held levels
    expect(frozen).toBeGreaterThan(decayed * 20) // freeze clearly holds vs decays
  })
})

// --- Input conditioning -----------------------------------------------------

// A patch that passes the conditioned voice through unchanged: FORMANT with the
// default vowel controls (shift 0, size 1 → formant amount 0, robot/whisper/ring
// off) returns the input sample verbatim, so the only thing shaping the output is
// the input gain + noise gate we are exercising. FX bypassed, monitor off.
function conditioningPatch(shared: Partial<MvoxPatch['shared']>, tracking: Partial<MvoxPatch['tracking']> = {}): MvoxPatch {
  const p = structuredClone(DEFAULT_PATCH) as MvoxPatch
  p.mode = 'formant'
  p.shared.monitorMix = 0
  Object.assign(p.shared, shared)
  Object.assign(p.tracking, tracking)
  p.fx.drive = 0
  p.fx.chorus = 0
  p.fx.delayMix = 0
  p.fx.reverb = 0
  return p
}

// Run a steady sine (amp 0 → silence) and return the last telemetry + the output
// peak over the final blocks (after the mode-switch fade has settled).
function runConditioning(patch: MvoxPatch, amp: number, blocks = 60, freq = 400) {
  const eng = new MvoxEngineCore(FS)
  eng.setLiveInput(true)
  eng.setPatch(patch)
  const outL = new Float32Array(BLOCK)
  const outR = new Float32Array(BLOCK)
  let tel = eng.process(new Float32Array(BLOCK), outL, outR)
  let peak = 0
  for (let b = 0; b < blocks; b += 1) {
    const input = amp > 0 ? sineBlock(freq, b * BLOCK, amp) : new Float32Array(BLOCK)
    tel = eng.process(input, outL, outR)
    if (b >= blocks - 5) {
      for (let i = 0; i < BLOCK; i += 1) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]))
    }
  }
  return { tel, peak }
}

describe('MvoxEngineCore input conditioning', () => {
  it('inputGain scales the reported inputLevel; unity gain is unchanged and unclipped', () => {
    const unity = runConditioning(conditioningPatch({ inputGain: 1 }), 0.1, 4).tel
    const boosted = runConditioning(conditioningPatch({ inputGain: 3 }), 0.1, 4).tel
    // Both stay below the RMS clamp, so the level tracks the gain roughly linearly.
    expect(boosted.inputLevel).toBeGreaterThan(unity.inputLevel * 2.5)
    expect(unity.inputClip).toBe(false)
  })

  it('inputClip trips when the post-gain input reaches full scale', () => {
    // 0.5 peak * 4 gain = 2.0 → clips; 0.5 peak * 1 gain = 0.5 → no clip.
    const clipped = runConditioning(conditioningPatch({ inputGain: 4 }), 0.5, 2).tel
    const clean = runConditioning(conditioningPatch({ inputGain: 1 }), 0.5, 2).tel
    expect(clipped.inputClip).toBe(true)
    expect(clean.inputClip).toBe(false)
  })

  it('noise gate: closes below threshold, opens above; threshold 0 is fully open and silence stays silent', () => {
    const thr = 0.1
    // Loud tone (env above threshold) passes through.
    const loud = runConditioning(conditioningPatch({ gateThreshold: thr }), 0.5).peak
    expect(loud).toBeGreaterThan(0.1)
    // Quiet tone (env below threshold) is gated to ~0 (fast close for the test).
    const quiet = runConditioning(conditioningPatch({ gateThreshold: thr, gateRelease: 0 }), 0.02, 80).peak
    expect(quiet).toBeLessThan(0.005)
    // Same quiet tone, gate OFF → passes (fully open, path unchanged bar gain).
    const open = runConditioning(conditioningPatch({ gateThreshold: 0 }), 0.02).peak
    expect(open).toBeGreaterThan(0.01)
    // Silence in stays silent even with the gate open.
    const silent = runConditioning(conditioningPatch({ gateThreshold: 0 }), 0).peak
    expect(silent).toBeLessThan(1e-9)
  })
})

// --- Pitch smoothing --------------------------------------------------------

// Capture the reported f0 per block while the input pitch steps from 220→440 Hz
// (continuous phase so the tracker stays voiced across the jump).
function f0Sequence(smoothing: number): number[] {
  const p = structuredClone(DEFAULT_PATCH) as MvoxPatch
  p.mode = 'follow'
  p.shared.monitorMix = 0
  p.tracking.smoothing = smoothing
  p.fx.drive = 0
  p.fx.chorus = 0
  p.fx.delayMix = 0
  p.fx.reverb = 0
  const eng = new MvoxEngineCore(FS)
  eng.setLiveInput(true)
  eng.setPatch(p)
  const outL = new Float32Array(BLOCK)
  const outR = new Float32Array(BLOCK)
  const f0s: number[] = []
  let phase = 0
  for (let b = 0; b < 70; b += 1) {
    const freq = b < 30 ? 220 : 440
    const buf = new Float32Array(BLOCK)
    for (let i = 0; i < BLOCK; i += 1) {
      buf[i] = 0.6 * Math.sin(phase)
      phase += (2 * Math.PI * freq) / FS
    }
    f0s.push(eng.process(buf, outL, outR).f0)
  }
  return f0s
}

describe('MvoxEngineCore pitch smoothing', () => {
  it('smoothed f0 lags a step change while smoothing=0 tracks it immediately', () => {
    const noSmooth = f0Sequence(0)
    const heavy = f0Sequence(0.9)
    // Both settle at the new pitch by the end.
    expect(noSmooth[69]).toBeGreaterThan(400)
    expect(heavy[69]).toBeGreaterThan(400)
    // At the block where the un-smoothed reading first reaches the new pitch, the
    // heavily-smoothed reading is still well below it (lagging).
    const idx = noSmooth.findIndex((f, i) => i >= 30 && f > 420)
    expect(idx).toBeGreaterThanOrEqual(30)
    expect(heavy[idx]).toBeLessThan(noSmooth[idx] - 5)
  })
})

// --- Pitch-tracker search range ---------------------------------------------

function detectF0(minHz: number, maxHz: number, freq: number): number {
  const p = structuredClone(DEFAULT_PATCH) as MvoxPatch
  p.mode = 'follow'
  p.shared.monitorMix = 0
  p.tracking.rangePreset = 'custom'
  p.tracking.minHz = minHz
  p.tracking.maxHz = maxHz
  p.fx.drive = 0
  p.fx.chorus = 0
  p.fx.delayMix = 0
  p.fx.reverb = 0
  const eng = new MvoxEngineCore(FS)
  eng.setLiveInput(true)
  eng.setPatch(p)
  const outL = new Float32Array(BLOCK)
  const outR = new Float32Array(BLOCK)
  let tel = eng.process(new Float32Array(BLOCK), outL, outR)
  for (let b = 0; b < 60; b += 1) tel = eng.process(sineBlock(freq, b * BLOCK), outL, outR)
  return tel.f0
}

describe('MvoxEngineCore pitch-tracker range', () => {
  it('setPatch reconstructs the tracker so a wider range detects an out-of-range tone', () => {
    // Default range (maxHz 1000, matches the initial tracker → no reconstruct)
    // cannot lock a 1500 Hz tone; a widened range (triggers reconstruct) does.
    const rejected = detectF0(70, 1000, 1500)
    const detected = detectF0(200, 2000, 1500)
    expect(detected).toBeGreaterThan(1400)
    expect(detected).toBeLessThan(1600)
    expect(Math.abs(rejected - 1500)).toBeGreaterThan(200)
  })
})

// --- targetHz telemetry -----------------------------------------------------

function runTelemetry(patch: MvoxPatch, freq: number, blocks = 80) {
  const eng = new MvoxEngineCore(FS)
  eng.setLiveInput(true)
  eng.setPatch(patch)
  const outL = new Float32Array(BLOCK)
  const outR = new Float32Array(BLOCK)
  let tel = eng.process(new Float32Array(BLOCK), outL, outR)
  for (let b = 0; b < blocks; b += 1) tel = eng.process(sineBlock(freq, b * BLOCK), outL, outR)
  return tel
}

describe('MvoxEngineCore targetHz telemetry', () => {
  it('reports the engine target for FOLLOW and HARMONY when voiced, and 0 for VOCODER', () => {
    const followP = structuredClone(DEFAULT_PATCH) as MvoxPatch
    followP.mode = 'follow'
    followP.shared.monitorMix = 0
    followP.fx.drive = 0
    followP.fx.chorus = 0
    followP.fx.delayMix = 0
    followP.fx.reverb = 0
    const fTel = runTelemetry(followP, 330)
    expect(fTel.confidence).toBeGreaterThan(0.4)
    // 330 Hz → E4 snapped to C-major → ~329.6 Hz.
    expect(fTel.targetHz).toBeGreaterThan(300)
    expect(fTel.targetHz).toBeLessThan(360)

    // 220 Hz → A3 in C-major → ~220 Hz snapped base.
    const hTel = runTelemetry(harmonyPatch({}), 220)
    expect(hTel.targetHz).toBeGreaterThan(200)
    expect(hTel.targetHz).toBeLessThan(240)

    const vTel = runTelemetry(vocoderPatch({}), 220)
    expect(vTel.targetHz).toBe(0)
  })
})

// --- HARMONY response glide + keyboard harmony -------------------------------

// Pump a steady sine through the engine, returning the last telemetry. A shared
// sample counter keeps the sine's phase continuous across calls so the tracker
// stays voiced.
function pump(eng: MvoxEngineCore, freq: number, blocks: number, start: { n: number }) {
  const oL = new Float32Array(BLOCK)
  const oR = new Float32Array(BLOCK)
  let tel = eng.process(new Float32Array(BLOCK), oL, oR)
  for (let b = 0; b < blocks; b += 1) {
    tel = eng.process(sineBlock(freq, start.n), oL, oR)
    start.n += BLOCK
  }
  return tel
}

describe('MvoxEngineCore HARMONY response glide', () => {
  it('response = 1 snaps the shift instantly (no glide)', () => {
    // Keyboard harmony gives a clean, discrete shift target we can read directly.
    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    eng.setPatch(harmonyPatch({ keyboardHarmony: true, response: 1, detune: 0, spread: 0 }))
    eng.noteOn(64, 1) // hold E4; sing A3 (220 Hz, MIDI 57) → shift ≈ +7
    const start = { n: 0 }
    pump(eng, 220, 80, start)
    const shift = eng.harmonyShiftForTest
    expect(shift[0]).toBeGreaterThan(6.5)
    expect(shift[0]).toBeLessThan(7.5)
  })

  it('response < 1 glides the effective shift toward a changed target', () => {
    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    eng.setPatch(harmonyPatch({ keyboardHarmony: true, response: 0.5, detune: 0, spread: 0 }))
    eng.noteOn(60, 1) // hold C4; sing A3 (MIDI 57) → target shift ≈ +3
    const start = { n: 0 }
    pump(eng, 220, 120, start) // settle the glide at ~+3
    const settled = eng.harmonyShiftForTest[0]
    expect(settled).toBeGreaterThan(2.5)
    expect(settled).toBeLessThan(3.5)

    // Move the target up to +7 (hold E4 instead of C4) and glide a few blocks.
    eng.noteOff(60)
    eng.noteOn(67, 1) // G4 → target shift ≈ +10
    pump(eng, 220, 4, start)
    const mid = eng.harmonyShiftForTest[0]
    // Strictly between the old (+3) and new (+10) target — a partial glide.
    expect(mid).toBeGreaterThan(settled + 0.05)
    expect(mid).toBeLessThan(9.5)

    // Continue and it keeps approaching the new target without reaching it yet.
    pump(eng, 220, 20, start)
    const later = eng.harmonyShiftForTest[0]
    expect(later).toBeGreaterThan(mid)
    expect(later).toBeLessThan(10)
  })
})

describe('MvoxEngineCore keyboard harmony', () => {
  it('harmony voices target the held keyboard notes (held − sung)', () => {
    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    // response 1 (instant) so the read-back shift equals the raw target; detune 0
    // so the shift is exactly held − sungMidi.
    eng.setPatch(harmonyPatch({ keyboardHarmony: true, response: 1, detune: 0, spread: 0 }))
    eng.noteOn(60, 1) // C4
    eng.noteOn(64, 1) // E4 — held sorted = [60, 64]
    const start = { n: 0 }
    pump(eng, 220, 80, start) // sing A3 (MIDI 57)
    const shift = eng.harmonyShiftForTest
    // Voice 0 → 60 − 57 = +3, voice 1 → 64 − 57 = +7.
    expect(shift[0]).toBeGreaterThan(2.6)
    expect(shift[0]).toBeLessThan(3.4)
    expect(shift[1]).toBeGreaterThan(6.6)
    expect(shift[1]).toBeLessThan(7.4)
  })

  it('keyboardHarmony true but no notes held → dry lead only (no harmony voices)', () => {
    const eng = new MvoxEngineCore(FS)
    eng.setLiveInput(true)
    eng.setPatch(harmonyPatch({ keyboardHarmony: true, spread: 0 }))
    const start = { n: 0 }
    pump(eng, 220, 80, start)
    // No held notes → every harmony voice inactive → its shift stays unseeded.
    for (const s of eng.harmonyShiftForTest) expect(Number.isNaN(s)).toBe(true)
  })

  it('keyboardHarmony changes the output vs the default interval path', () => {
    const withKeys = new MvoxEngineCore(FS)
    withKeys.setLiveInput(true)
    withKeys.setPatch(harmonyPatch({ keyboardHarmony: true, spread: 0 }))
    withKeys.noteOn(60, 1)
    withKeys.noteOn(67, 1)
    const s1 = { n: 0 }
    pump(withKeys, 220, 80, s1)
    const kOut = new Float32Array(BLOCK)
    withKeys.process(sineBlock(220, s1.n), kOut, new Float32Array(BLOCK))

    // Default interval path (keyboardHarmony false) with the same held notes.
    const noKeys = new MvoxEngineCore(FS)
    noKeys.setLiveInput(true)
    noKeys.setPatch(harmonyPatch({ keyboardHarmony: false, spread: 0 }))
    noKeys.noteOn(60, 1)
    noKeys.noteOn(67, 1)
    const s2 = { n: 0 }
    pump(noKeys, 220, 80, s2)
    const iOut = new Float32Array(BLOCK)
    noKeys.process(sineBlock(220, s2.n), iOut, new Float32Array(BLOCK))

    expect(sumAbsDiff(kOut, iOut)).toBeGreaterThan(0.01)
  })
})

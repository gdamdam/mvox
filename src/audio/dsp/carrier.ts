// Pure poly carrier synth: the tone the voice modulates (VOCODER) or that tracks
// the sung pitch (FOLLOW). Up to 8 voices, oldest-note stealing, click-free via
// short attack/release ramps, no hung notes (panic()/reset() clear everything).
// PolyBLEP anti-aliasing on saw/pulse so high notes don't alias harshly.

import type { CarrierWave } from '../contracts'

const MAX_VOICES = 8
const MAX_UNISON = 4
const ATTACK_S = 0.006
const RELEASE_S = 0.05

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

// PolyBLEP residual correction around discontinuities (t in [0,1), dt = phase inc).
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

interface Voice {
  midi: number
  active: boolean
  releasing: boolean
  // One phase accumulator per possible unison sub-oscillator (SAW/PULSE). At
  // unison=1 only phases[0] is used, so the render is identical to the old single
  // `phase` field. A double[] (not Float32Array) so phase accumulation keeps the
  // exact double precision of the old `phase: number` — required for bit-identity.
  // Preallocated (fixed length MAX_UNISON) so no per-note/per-sample allocation.
  phases: number[]
  env: number // current gain 0..1
  target: number // envelope target
  velocity: number
  age: number // increments per allocation; higher = newer
  noiseState: number
}

export class CarrierSynth {
  private readonly voices: Voice[] = []
  private readonly attackCoeff: number
  private readonly releaseCoeff: number
  private wave: CarrierWave = 'saw'
  private ageCounter = 0
  // Carrier transpose (semitones) added to every note's pitch; 0 = unchanged.
  private transposeSemis = 0
  // Unison: `unisonCount` detuned sub-oscillators per note (SAW/PULSE only),
  // spread symmetrically by ±unisonDetuneCents. Defaults (1, 0) collapse to a
  // single oscillator so the render is bit-identical to the pre-unison path.
  private unisonCount = 1
  private unisonDetuneCents = 0
  // Pulse duty cycle and its precomputed helpers. pw=0.5 gives pulseFall=0.5 and
  // pulseDc=0, reducing the pulse oscillator exactly to the old two-saw square.
  private pulseWidth = 0.5
  private pulseFall = 0.5 // 1 - pw: phase offset of the falling edge
  private pulseDc = 0 // 2*pw - 1: DC of a duty-pw square, subtracted to re-center

  constructor(private readonly sampleRate: number) {
    // One-pole smoothing coefficients for the amp envelope ramps.
    this.attackCoeff = 1 - Math.exp(-1 / (ATTACK_S * sampleRate))
    this.releaseCoeff = 1 - Math.exp(-1 / (RELEASE_S * sampleRate))
    for (let i = 0; i < MAX_VOICES; i += 1) {
      this.voices.push({
        midi: 0,
        active: false,
        releasing: false,
        phases: new Array(MAX_UNISON).fill(0),
        env: 0,
        target: 0,
        velocity: 0,
        age: 0,
        noiseState: 12345 + i * 1013,
      })
    }
  }

  setWave(wave: CarrierWave): void {
    this.wave = wave
  }

  /** Carrier transpose in semitones (default 0 → identical pitch). */
  setTranspose(semitones: number): void {
    this.transposeSemis = Number.isFinite(semitones) ? semitones : 0
  }

  /** Unison voice count (clamped 1..4) and symmetric detune spread in cents.
   *  (1, 0) → a single oscillator, bit-identical to the pre-unison render. */
  setUnison(count: number, detuneCents: number): void {
    this.unisonCount = Math.max(1, Math.min(MAX_UNISON, Math.round(count)))
    this.unisonDetuneCents = Number.isFinite(detuneCents) ? detuneCents : 0
  }

  /** Pulse duty cycle (0.5 = square). At 0.5 the pulse is bit-identical to the
   *  old hardcoded two-saw square (pulseFall 0.5, pulseDc 0). */
  setPulseWidth(pw: number): void {
    const w = Number.isFinite(pw) ? Math.max(0.05, Math.min(0.95, pw)) : 0.5
    this.pulseWidth = w
    this.pulseFall = 1 - w
    this.pulseDc = 2 * w - 1
  }

  private allocate(): Voice {
    // Prefer a fully-idle voice; otherwise steal the oldest sounding one.
    let idle: Voice | null = null
    let oldest = this.voices[0]
    for (const v of this.voices) {
      if (!v.active && v.env < 0.001) {
        idle = v
        break
      }
      if (v.age < oldest.age) oldest = v
    }
    return idle ?? oldest
  }

  noteOn(midi: number, velocity: number): void {
    const clampedMidi = Math.max(0, Math.min(127, Math.round(midi)))
    const v = this.allocate()
    v.midi = clampedMidi
    v.active = true
    v.releasing = false
    v.target = 1
    v.velocity = Math.max(0, Math.min(1, velocity))
    v.age = ++this.ageCounter
    // Reset phases only when re-triggering a silent voice, to avoid clicks on steal.
    if (v.env < 0.001) v.phases.fill(0)
  }

  noteOff(midi: number): void {
    const clampedMidi = Math.max(0, Math.min(127, Math.round(midi)))
    // Release the newest voice for that pitch.
    let target: Voice | null = null
    for (const v of this.voices) {
      if (v.active && !v.releasing && v.midi === clampedMidi) {
        if (!target || v.age > target.age) target = v
      }
    }
    if (target) {
      target.releasing = true
      target.target = 0
    }
  }

  panic(): void {
    for (const v of this.voices) {
      v.active = false
      v.releasing = false
      v.target = 0
      v.env = 0
    }
  }

  reset(): void {
    this.panic()
    this.ageCounter = 0
    for (const v of this.voices) {
      v.phases.fill(0)
    }
  }

  activeCount(): number {
    let n = 0
    for (const v of this.voices) if (v.active || v.env > 0.001) n += 1
    return n
  }

  // One SAW/PULSE sub-oscillator sample at the given phase and phase increment.
  // Anti-aliased with polyBLEP at the waveform's discontinuities.
  private waveSample(phase: number, dt: number): number {
    if (this.wave === 'saw') {
      let s = 2 * phase - 1
      s -= polyBlep(phase, dt)
      return s
    }
    // PULSE: a duty-`pulseWidth` square. Rising edge at phase 0, falling edge at
    // phase = pulseWidth (offset pulseFall = 1 - pw). Subtract the square's DC
    // (2*pw - 1) so non-50% duties stay centered. At pw=0.5 pulseFall is 0.5 and
    // pulseDc is 0, so this reduces exactly to the old two-saw square.
    let s = phase < this.pulseWidth ? 1 : -1
    s += polyBlep(phase, dt)
    s -= polyBlep((phase + this.pulseFall) % 1, dt)
    s -= this.pulseDc
    return s
  }

  // Deterministic xorshift noise per voice (broadband — pitch/unison-independent).
  private noiseSample(v: Voice): number {
    let x = v.noiseState | 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    v.noiseState = x
    // x is a full-range int32; map to ~[-1, 1). The old `% 1` was a no-op
    // for in-range values and silently zeroed the ±full-scale endpoints.
    return x / 0x7fffffff
  }

  /** Render one mono sample: the summed, enveloped carrier. Always finite. */
  process(): number {
    let out = 0
    for (const v of this.voices) {
      if (!v.active && v.env < 0.001) continue
      const coeff = v.releasing ? this.releaseCoeff : this.attackCoeff
      v.env += (v.target - v.env) * coeff
      if (v.releasing && v.env < 0.001) {
        v.active = false
        v.env = 0
        continue
      }
      let sample: number
      if (this.wave === 'noise') {
        // NOISE stays a single generator; unison/transpose/pulseWidth don't apply.
        sample = this.noiseSample(v)
      } else {
        const hz = midiToHz(v.midi + this.transposeSemis)
        const count = this.unisonCount
        let sum = 0
        for (let k = 0; k < count; k += 1) {
          // Symmetric detune: k spans [-detune, +detune] cents across the stack.
          const cents = count > 1 ? this.unisonDetuneCents * ((2 * k) / (count - 1) - 1) : 0
          const subHz = hz * Math.pow(2, cents / 1200)
          const dt = subHz / this.sampleRate
          sum += this.waveSample(v.phases[k], dt)
          v.phases[k] += dt
          if (v.phases[k] >= 1) v.phases[k] -= 1
        }
        // Normalize by count so unison=1 is exactly one oscillator × 1.
        sample = sum / count
      }
      out += sample * v.env * v.velocity
    }
    // Soft headroom scaling so 8 stacked voices don't clip the carrier stage.
    const scaled = out * 0.4
    return Number.isFinite(scaled) ? scaled : 0
  }
}

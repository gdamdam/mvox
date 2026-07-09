// Pure poly carrier synth: the tone the voice modulates (VOCODER) or that tracks
// the sung pitch (FOLLOW). Up to 8 voices, oldest-note stealing, click-free via
// short attack/release ramps, no hung notes (panic()/reset() clear everything).
// PolyBLEP anti-aliasing on saw/pulse so high notes don't alias harshly.

import type { CarrierWave } from '../contracts'

const MAX_VOICES = 8
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
  phase: number
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

  constructor(private readonly sampleRate: number) {
    // One-pole smoothing coefficients for the amp envelope ramps.
    this.attackCoeff = 1 - Math.exp(-1 / (ATTACK_S * sampleRate))
    this.releaseCoeff = 1 - Math.exp(-1 / (RELEASE_S * sampleRate))
    for (let i = 0; i < MAX_VOICES; i += 1) {
      this.voices.push({
        midi: 0,
        active: false,
        releasing: false,
        phase: 0,
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
    // Reset phase only when re-triggering a silent voice, to avoid clicks on steal.
    if (v.env < 0.001) v.phase = 0
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
      v.phase = 0
    }
  }

  activeCount(): number {
    let n = 0
    for (const v of this.voices) if (v.active || v.env > 0.001) n += 1
    return n
  }

  private oscillator(v: Voice, dt: number): number {
    switch (this.wave) {
      case 'saw': {
        let s = 2 * v.phase - 1
        s -= polyBlep(v.phase, dt)
        return s
      }
      case 'pulse': {
        // 50% square via two saws.
        let s = v.phase < 0.5 ? 1 : -1
        s += polyBlep(v.phase, dt)
        const t2 = (v.phase + 0.5) % 1
        s -= polyBlep(t2, dt)
        return s
      }
      case 'noise': {
        // Deterministic xorshift noise per voice.
        let x = v.noiseState | 0
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        v.noiseState = x
        // x is a full-range int32; map to ~[-1, 1). The old `% 1` was a no-op
        // for in-range values and silently zeroed the ±full-scale endpoints.
        return x / 0x7fffffff
      }
    }
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
      const hz = midiToHz(v.midi)
      const dt = hz / this.sampleRate
      const sample = this.oscillator(v, dt)
      if (this.wave !== 'noise') {
        v.phase += dt
        if (v.phase >= 1) v.phase -= 1
      }
      out += sample * v.env * v.velocity
    }
    // Soft headroom scaling so 8 stacked voices don't clip the carrier stage.
    const scaled = out * 0.4
    return Number.isFinite(scaled) ? scaled : 0
  }
}

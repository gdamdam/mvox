// A short, looping synthetic "aah" vowel so mvox is playable with no mic
// permission. Built from a glottal-ish sawtooth at a vibrato'd pitch shaped by
// three fixed formants — rich enough to exercise the pitch tracker and vocoder
// realistically. Pure and deterministic (no RNG): same sample rate → same buffer.

const VOWEL_FORMANTS = [
  { hz: 700, gain: 1.0, bw: 80 }, // F1 (~/a/)
  { hz: 1220, gain: 0.5, bw: 90 }, // F2
  { hz: 2600, gain: 0.25, bw: 120 }, // F3
]

const BASE_HZ = 146.83 // D3 — a comfortable sung pitch
const VIBRATO_HZ = 5.2
const VIBRATO_CENTS = 18
const DURATION_S = 2.5

export function makeDemoVoice(sampleRate: number): Float32Array {
  const length = Math.max(1, Math.round(sampleRate * DURATION_S))
  const out = new Float32Array(length)

  // One resonator (state-variable style two-pole) per formant.
  const states = VOWEL_FORMANTS.map(() => ({ y1: 0, y2: 0 }))
  const coeffs = VOWEL_FORMANTS.map((f) => {
    const r = Math.exp((-Math.PI * f.bw) / sampleRate)
    const theta = (2 * Math.PI * f.hz) / sampleRate
    // Two-pole resonator: y[n] = x + 2r cosθ y[n-1] − r² y[n-2]
    return { a1: 2 * r * Math.cos(theta), a2: r * r, gain: f.gain * (1 - r) }
  })

  let phase = 0
  let peak = 0
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate
    const vibrato = Math.pow(2, (VIBRATO_CENTS / 1200) * Math.sin(2 * Math.PI * VIBRATO_HZ * t))
    const hz = BASE_HZ * vibrato
    phase += hz / sampleRate
    if (phase >= 1) phase -= 1
    // Band-limited-ish sawtooth excitation (naive saw is fine as a source here).
    const excitation = 2 * phase - 1

    let sample = 0
    for (let f = 0; f < coeffs.length; f += 1) {
      const c = coeffs[f]
      const s = states[f]
      const y = c.gain * excitation + c.a1 * s.y1 - c.a2 * s.y2
      s.y2 = s.y1
      s.y1 = y
      sample += y
    }
    out[i] = sample
    const abs = Math.abs(sample)
    if (abs > peak) peak = abs
  }

  // Normalize + a short fade at both ends so the loop is click-free.
  const norm = peak > 0 ? 0.9 / peak : 1
  const fade = Math.min(Math.round(sampleRate * 0.02), Math.floor(length / 2))
  for (let i = 0; i < length; i += 1) {
    let g = norm
    if (i < fade) g *= i / fade
    else if (i >= length - fade) g *= (length - i) / fade
    out[i] *= g
  }
  return out
}

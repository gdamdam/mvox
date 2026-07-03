// RBJ "Audio EQ Cookbook" biquad filters.
//
// We use Direct Form II Transposed (DF2T). WHY: DF2T needs only two state
// registers (s1, s2) instead of four (two input + two output histories) and is
// numerically well-behaved for the modest Q values used by a vocoder band bank.
// Its update also maps cleanly onto a single scalar `process(x)` call, which is
// all we need for a per-sample software vocoder running off the audio thread's
// hot path.
//
// All coefficients are normalized so a0 == 1 (we divide through by a0 at design
// time), so the runtime never has to touch a0.

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

// Guard rails so a bad UI value can never produce NaN/Inf coefficients.
// freq must sit strictly inside (0, nyquist); Q must be positive and bounded.
const MIN_Q = 1e-4;
const MAX_Q = 1000;

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// Normalized angular frequency w0 = 2*pi*f/fs, with f clamped away from 0 and
// nyquist so cos/sin never collapse and alpha never blows up.
function omega(sampleRate: number, freq: number): number {
  const fs = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const nyquist = fs / 2;
  // Keep a hair inside the band edges: 1 Hz .. nyquist-1 Hz (but valid for low fs too).
  const hi = Math.max(1, nyquist - 1);
  const f = clamp(freq, 1e-6, hi);
  return (2 * Math.PI * f) / fs;
}

function normalize(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoeffs {
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

// Constant 0 dB peak-gain bandpass. WHY this variant (RBJ "BPF, constant 0 dB
// peak gain") rather than the constant-skirt one: for a vocoder each band should
// pass a tone at its center frequency at ~unity, independent of Q, so that the
// synthesized spectrum tracks the modulator's spectral envelope rather than the
// filter's Q. The constant-skirt-gain BPF peaks at Q instead, which would make
// narrow bands artificially loud.
export function bandpassCoeffs(
  sampleRate: number,
  freq: number,
  q: number,
): BiquadCoeffs {
  const w0 = omega(sampleRate, freq);
  const qc = clamp(q, MIN_Q, MAX_Q);
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * qc);

  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return normalize(b0, b1, b2, a0, a1, a2);
}

export function lowpassCoeffs(
  sampleRate: number,
  freq: number,
  q: number,
): BiquadCoeffs {
  const w0 = omega(sampleRate, freq);
  const qc = clamp(q, MIN_Q, MAX_Q);
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * qc);

  const b1 = 1 - cos;
  const b0 = b1 / 2;
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return normalize(b0, b1, b2, a0, a1, a2);
}

export function highpassCoeffs(
  sampleRate: number,
  freq: number,
  q: number,
): BiquadCoeffs {
  const w0 = omega(sampleRate, freq);
  const qc = clamp(q, MIN_Q, MAX_Q);
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * qc);

  const onePlusCos = 1 + cos;
  const b0 = onePlusCos / 2;
  const b1 = -onePlusCos;
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return normalize(b0, b1, b2, a0, a1, a2);
}

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  // DF2T state registers.
  private s1 = 0;
  private s2 = 0;

  setCoeffs(c: BiquadCoeffs): void {
    this.b0 = c.b0;
    this.b1 = c.b1;
    this.b2 = c.b2;
    this.a1 = c.a1;
    this.a2 = c.a2;
  }

  // Direct Form II Transposed:
  //   y  = b0*x + s1
  //   s1 = b1*x - a1*y + s2
  //   s2 = b2*x - a2*y
  process(x: number): number {
    const y = this.b0 * x + this.s1;
    this.s1 = this.b1 * x - this.a1 * y + this.s2;
    this.s2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.s1 = 0;
    this.s2 = 0;
  }
}

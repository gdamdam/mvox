// Channel-vocoder band math + envelope follower.
//
// VOCODER mode splits the modulator (voice) into a bank of bandpass filters,
// tracks each band's amplitude envelope, and uses those envelopes to gain the
// same bands of a synth carrier. This module provides the framework-free math:
// where to put the band centers, how sharp each band should be, and the
// envelope follower itself. The AudioNode wiring lives elsewhere.

// Band count bounds. Fewer than ~4 bands is not a vocoder; more than ~40 gives
// diminishing intelligibility gains for a lot of CPU, and very high counts push
// adjacent centers close enough that Q would have to be impractically high.
const MIN_BANDS = 4;
const MAX_BANDS = 40;

const DEFAULT_LOW_HZ = 120;
const DEFAULT_HIGH_HZ = 8000;

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  const r = Math.round(value);
  if (r < lo) return lo;
  if (r > hi) return hi;
  return r;
}

export function clampBandCount(bandCount: number): number {
  return clampInt(bandCount, MIN_BANDS, MAX_BANDS);
}

// Log-spaced center frequencies. WHY log spacing: pitch and speech-formant
// perception are roughly logarithmic, so equal ratios between adjacent bands
// (constant octave fraction) allocate resolution the way the ear expects,
// instead of wasting most bands above a few kHz as linear spacing would.
//
// Centers are placed at the geometric-mean points of `count` log-equal steps,
// so the first and last centers sit just inside [low, high] rather than exactly
// on the edges — this keeps a symmetric guard band at both ends.
export function vocoderBandFrequencies(
  bandCount: number,
  lowHz: number = DEFAULT_LOW_HZ,
  highHz: number = DEFAULT_HIGH_HZ,
): number[] {
  const count = clampBandCount(bandCount);

  // Sanitize the range; fall back to defaults on garbage, and ensure low < high.
  let low = Number.isFinite(lowHz) && lowHz > 0 ? lowHz : DEFAULT_LOW_HZ;
  let high = Number.isFinite(highHz) && highHz > 0 ? highHz : DEFAULT_HIGH_HZ;
  if (high <= low) {
    low = DEFAULT_LOW_HZ;
    high = DEFAULT_HIGH_HZ;
  }

  const logLow = Math.log(low);
  const logHigh = Math.log(high);
  const freqs: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    // Center of the i-th of `count` equal log slices → (i + 0.5)/count.
    const t = (i + 0.5) / count;
    freqs[i] = Math.exp(logLow + (logHigh - logLow) * t);
  }
  return freqs;
}

// Q chosen so a band's bandwidth ~ its spacing to neighbors, giving sensible
// overlap. Adjacent centers differ by the ratio r = (high/low)^(1/count), so the
// fractional bandwidth is roughly (r - 1/r). Q = center/bandwidth ≈ 1/(r - 1/r).
// This makes Q grow with bandCount (narrower bands when there are more of them),
// as requested. Clamped to stay positive and finite.
export function vocoderBandQ(centerHz: number, bandCount: number): number {
  const count = clampBandCount(bandCount);
  // The ratio depends on the whole range; use the defaults' span as the basis so
  // callers get a stable Q from just (center, count). This matches the default
  // band layout; custom ranges scale similarly.
  const r = Math.pow(DEFAULT_HIGH_HZ / DEFAULT_LOW_HZ, 1 / count);
  const fractionalBandwidth = r - 1 / r; // > 0 since r > 1
  const q = 1 / fractionalBandwidth;
  if (!Number.isFinite(q) || q <= 0) return 1;
  // Keep away from absurd extremes regardless of centerHz (unused directly here,
  // but kept in the signature for future per-band shaping).
  void centerHz;
  return Math.min(Math.max(q, 0.5), 60);
}

// One-pole (leaky integrator) envelope follower with separate attack/release
// time constants. WHY rectify + one-pole: it's the classic, cheap, artifact-free
// amplitude tracker — full-wave rectification gives instantaneous magnitude, and
// asymmetric attack/release smoothing lets the envelope snap up quickly on
// transients while decaying gently, which is what makes vocoded consonants
// intelligible without zipper noise.
export class EnvelopeFollower {
  private readonly sampleRate: number;
  private env = 0;
  private attackCoeff = 0;
  private releaseCoeff = 0;

  constructor(sampleRate: number, attackMs: number, releaseMs: number) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    this.setTimes(attackMs, releaseMs);
  }

  // Convert a time constant in ms to a one-pole coefficient. coeff = e^(-1/(tau*fs))
  // where tau is in seconds. A 0ms time → coeff 0 (instant follow).
  private coeffFor(ms: number): number {
    const clamped = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (clamped <= 0) return 0;
    const tauSamples = (clamped / 1000) * this.sampleRate;
    if (tauSamples <= 0) return 0;
    return Math.exp(-1 / tauSamples);
  }

  setTimes(attackMs: number, releaseMs: number): void {
    this.attackCoeff = this.coeffFor(attackMs);
    this.releaseCoeff = this.coeffFor(releaseMs);
  }

  process(x: number): number {
    const rectified = Math.abs(x);
    // Rising vs falling picks which time constant applies.
    const coeff = rectified > this.env ? this.attackCoeff : this.releaseCoeff;
    this.env = rectified + coeff * (this.env - rectified);
    // Numerical floor: a one-pole can theoretically emit a tiny negative from FP
    // rounding; a vocoder gain must never go negative or NaN.
    if (!Number.isFinite(this.env) || this.env < 0) this.env = 0;
    return this.env;
  }

  // Current envelope WITHOUT advancing it. Used by the vocoder's freeze mode to
  // hold each band's last-tracked level while the modulator voice changes/goes
  // silent, sustaining the pad instead of following the input down.
  value(): number {
    return this.env;
  }

  reset(): void {
    this.env = 0;
  }
}

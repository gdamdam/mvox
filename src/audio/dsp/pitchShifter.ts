// Time-domain granular pitch shifter (two-tap overlapping variable-delay).
//
// This is the classic SoundTouch / Bode-style "granular" pitch shifter. We keep
// a ring buffer of recent input and read it back at a rate equal to the desired
// pitch ratio. Because the writer always advances at 1 sample/sample, reading at
// a different speed means the read delay must ramp: d(delay)/dt = 1 - ratio.
//
// A single ramping read pointer eventually runs off the end of its usable window
// and must be "relaunched" (wrapped) back to the start of the window. That wrap
// is a hard discontinuity in the signal. WHY TWO TAPS: we run a second read
// pointer offset by exactly half the grain window and cross-fade the two with a
// raised-cosine (Hann) window each. A Hann window at 50% overlap sums to unity,
// so total gain is constant 1, AND — critically — whenever one tap is at a
// window edge (gain 0, i.e. exactly where its relaunch discontinuity happens)
// the other tap is at window center (gain 1). The click is multiplied by zero
// and hidden behind the other tap. That is the whole trick.
//
// Quality: this is an honest "good v1". Granular shifting is not spectrally
// exact — expect some warble/amplitude modulation, especially far from ratio 1
// and on broadband/noisy input. Fundamental pitch tracking is solid (±few %),
// which is what HARMONY and FORMANT/robot modes need. Correctness, stability,
// and never emitting NaN/Inf are the hard requirements met here.

// Pitch ratio limits. ~2 octaves each way is plenty for harmony/robot modes and
// keeps the delay ramp well below the grain size so the wrap logic stays sane.
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

// Grain window bounds (milliseconds). Too short warbles badly; too long smears
// transients. 50-80ms is the usual sweet spot for a granular shifter.
const DEFAULT_GRAIN_MS = 60;
const MIN_GRAIN_MS = 10;
const MAX_GRAIN_MS = 200;

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export class PitchShifter {
  private readonly sampleRate: number;

  // Grain window length in (fractional) samples, and half of it (the tap offset).
  private readonly grain: number;
  private readonly halfGrain: number;

  // Ring buffer of recent input. Sized to comfortably hold a full grain window
  // plus margin for the +1 index used by linear interpolation.
  private readonly buffer: Float32Array;
  private readonly bufSize: number;

  // Monotonic write counter; the physical index is writePos % bufSize.
  private writePos = 0;

  // Grain phase in [0, grain). This IS the delay of tap A. It advances by
  // (1 - ratio) per sample and wraps modulo `grain` — each wrap is a relaunch.
  private phase = 0;

  private ratio = 1;

  constructor(sampleRate: number, opts?: { grainMs?: number }) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;

    const grainMs = clamp(opts?.grainMs ?? DEFAULT_GRAIN_MS, MIN_GRAIN_MS, MAX_GRAIN_MS);
    // At least a few samples even at absurdly low sample rates, so the Hann
    // window and half-grain offset are always well-defined.
    this.grain = Math.max(4, (grainMs / 1000) * this.sampleRate);
    this.halfGrain = this.grain / 2;

    // +4 sample margin: reads can sit at delay ~grain and interpolation touches
    // index i0+1, so we need strictly more than `grain` samples of history alive.
    this.bufSize = Math.ceil(this.grain) + 4;
    this.buffer = new Float32Array(this.bufSize);
  }

  setRatio(ratio: number): void {
    this.ratio = clamp(ratio, MIN_RATIO, MAX_RATIO);
  }

  setSemitones(semitones: number): void {
    // Equal temperament: each semitone is a factor of 2^(1/12).
    const s = Number.isFinite(semitones) ? semitones : 0;
    this.setRatio(Math.pow(2, s / 12));
  }

  reset(): void {
    this.buffer.fill(0);
    this.writePos = 0;
    this.phase = 0;
  }

  process(x: number): number {
    // Never let a bad input sample poison the ring buffer / state.
    const sample = Number.isFinite(x) ? x : 0;

    // 1) Write the incoming sample.
    this.buffer[this.writePos % this.bufSize] = sample;

    // 2) Advance the grain phase (= tap-A delay). Reading at speed `ratio` while
    //    writing at speed 1 requires the delay to change by (1 - ratio)/sample.
    let phase = this.phase + (1 - this.ratio);
    // Wrap into [0, grain). Manual positive modulo because the increment can be
    // negative (ratio > 1) and JS `%` keeps the sign of the dividend.
    phase = phase % this.grain;
    if (phase < 0) phase += this.grain;
    this.phase = phase;

    // Tap B trails tap A by half a window so their Hann windows interleave.
    let phaseB = phase + this.halfGrain;
    if (phaseB >= this.grain) phaseB -= this.grain;

    // 3) Raised-cosine (Hann) gains. For tap A: 0.5*(1 - cos(2*pi*phase/grain)),
    //    which is 0 at the window edges (phase = 0 and phase -> grain) where the
    //    relaunch discontinuity lives. Offsetting B by half the window makes
    //    gainA + gainB == 1 for all phase (unity gain), so the click is masked.
    const gainA = 0.5 * (1 - Math.cos((2 * Math.PI * phase) / this.grain));
    const gainB = 1 - gainA; // Hann @ 50% overlap sums to unity; cheaper than recomputing.

    const outA = this.readInterpolated(phase);
    const outB = this.readInterpolated(phaseB);

    // 4) Advance the writer for next call.
    this.writePos++;

    const out = gainA * outA + gainB * outB;
    return Number.isFinite(out) ? out : 0;
  }

  // Read the buffer at (writePos - delay) with linear interpolation over the
  // fractional part. `delay` is in [0, grain), guaranteed < bufSize, so the two
  // touched samples are always live history (never future/unwritten data).
  private readInterpolated(delay: number): number {
    const readPos = this.writePos - delay;
    const i0 = Math.floor(readPos);
    const frac = readPos - i0;

    // Positive modulo indexing for the ring. i0 can be negative early on (before
    // the buffer has filled); wrapping just reads the zero-initialized tail,
    // which is correct — there is no real history there yet.
    const idx0 = ((i0 % this.bufSize) + this.bufSize) % this.bufSize;
    const idx1 = (idx0 + 1) % this.bufSize;

    const s0 = this.buffer[idx0];
    const s1 = this.buffer[idx1];
    return s0 + (s1 - s0) * frac;
  }
}

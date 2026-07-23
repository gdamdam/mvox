/**
 * YIN-style monophonic pitch detector.
 *
 * Pure TypeScript: no DOM/Web Audio/React dependencies so it can be unit-tested
 * under Node and reused inside an AudioWorklet. The implementation follows
 * de Cheveigné & Kawahara (2002): difference function -> cumulative mean
 * normalized difference (CMND) -> absolute threshold -> parabolic interpolation,
 * plus a sub-octave guard for the classic period-doubling failure mode.
 */

export interface PitchResult {
  /** Fundamental frequency in Hz. 0 when unvoiced / below threshold / silent. */
  f0: number;
  /** Detection confidence in [0, 1]. 0 when unvoiced. */
  confidence: number;
}

export interface YinOptions {
  minHz?: number;
  maxHz?: number;
  threshold?: number;
}

/**
 * Preallocated scratch for {@link yinDetect}'s two O(tauMax) work buffers. The
 * streaming PitchTracker owns one of these (sized to its frame) and passes it on
 * every call so steady-state detection allocates nothing on the audio thread —
 * `new Float32Array` per frame at ~375 frames/sec is exactly the kind of churn
 * that triggers GC pauses and dropouts. Each buffer must be at least `tauMax + 1`
 * long for the frame in use; a shorter (or absent) buffer makes yinDetect fall
 * back to a lazy per-call allocation, so existing callers keep working unchanged.
 */
export interface YinScratch {
  diff: Float32Array;
  cmnd: Float32Array;
}

const DEFAULT_MIN_HZ = 65; // ~C2
const DEFAULT_MAX_HZ = 1000;
const DEFAULT_THRESHOLD = 0.15;
const DEFAULT_FRAME_SIZE = 1024;

/**
 * Upper bound on the derived analysis frame (see PitchTracker constructor).
 * Guards against a pathological `minHz` requesting an enormous buffer: 16384
 * samples still reaches ~12 Hz at 96 kHz — far below any musical fundamental —
 * so it never limits a legitimate vocal range, only absurd configurations.
 */
const MAX_FRAME_SIZE = 16384;

/**
 * RMS below this is treated as silence. The absolute-difference function is
 * scale dependent, so an explicit energy gate is cheaper and more reliable than
 * inferring silence from the CMND curve alone.
 */
const SILENCE_RMS = 1e-4;

/**
 * Extra CMND slack allowed when testing a half-period candidate. YIN's
 * "first dip below threshold" rule can lock onto twice the true period when the
 * true-period dip sits just above threshold; if the half-period dip is nearly as
 * deep we prefer the shorter (higher-octave) period.
 */
const OCTAVE_MARGIN = 0.1;

const UNVOICED: PitchResult = { f0: 0, confidence: 0 };

/**
 * How long PitchTracker holds the last voiced estimate through unvoiced frames
 * before clearing, expressed in TIME. A single consonant / plosive between
 * syllables yields an unvoiced frame; holding across a brief gap keeps FOLLOW
 * gated open and HARMONY voices sustained instead of flickering.
 *
 * Defined in milliseconds and converted to a frame count from the actual hop
 * (see constructor) so the musical hold duration stays stable regardless of
 * sample rate or hop size — a frame-count constant alone would silently
 * stretch to ~139 ms at hop=2048 or shrink to ~16 ms at 96 kHz/hop=512.
 * 35 ms ≈ the previous default (3 hops at 512/44.1 kHz), preserving feel.
 */
const UNVOICED_HOLD_MS = 35;

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Parabolic interpolation around an integer CMND minimum to obtain a
 * sub-sample period estimate. Returns `tau` unchanged at the array edges or
 * when the parabola is degenerate (flat), avoiding division by ~0.
 *
 * `tauMin` is the lowest searched lag: at `tau === tauMin` the left neighbor
 * `cmnd[tau - 1]` sits below the search floor and would bias the interpolated
 * period, so refinement is skipped there.
 *
 * `tauMax` is passed explicitly rather than derived from `cmnd.length` because a
 * reused scratch buffer (see YinScratch) is larger than the logical `tauMax + 1`
 * range; the entries past `tauMax` are stale from a previous call and must not be
 * read as the right neighbor of the top lag.
 */
function parabolicRefine(cmnd: Float32Array, tau: number, tauMin: number, tauMax: number): number {
  if (tau <= tauMin || tau >= tauMax) return tau;
  const s0 = cmnd[tau - 1];
  const s1 = cmnd[tau];
  const s2 = cmnd[tau + 1];
  const denom = 2 * (2 * s1 - s2 - s0);
  if (denom === 0 || !Number.isFinite(denom)) return tau;
  const delta = (s2 - s0) / denom;
  // A well-formed minimum shifts by less than one bin; reject wild values.
  if (!Number.isFinite(delta) || delta < -1 || delta > 1) return tau;
  return tau + delta;
}

/**
 * Run YIN pitch detection on a single frame.
 *
 * The frame is analyzed in place; callers own framing/overlap (see PitchTracker).
 * Always returns finite, bounded values.
 */
export function yinDetect(
  frame: Float32Array,
  sampleRate: number,
  opts: YinOptions = {},
  scratch?: YinScratch,
): PitchResult {
  const n = frame.length;
  if (n < 4 || !Number.isFinite(sampleRate) || sampleRate <= 0) return UNVOICED;

  const minHz = clamp(opts.minHz ?? DEFAULT_MIN_HZ, 1, sampleRate / 2);
  const maxHz = clamp(opts.maxHz ?? DEFAULT_MAX_HZ, minHz + 1, sampleRate / 2);
  const threshold = clamp(opts.threshold ?? DEFAULT_THRESHOLD, 0.01, 1);

  // Silence gate: reject near-zero energy frames before any period search.
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += frame[i] * frame[i];
  const rms = Math.sqrt(sumSq / n);
  if (rms < SILENCE_RMS) return UNVOICED;

  // Fixed integration window = half the frame; the largest lag we can evaluate
  // without reading past the frame is then W - 1. This caps the lowest
  // detectable pitch for a given frame size (a deliberate DSP trade-off).
  const w = n >> 1;
  const tauMaxAllowed = w - 1;
  if (tauMaxAllowed < 2) return UNVOICED;

  const tauMin = clamp(Math.floor(sampleRate / maxHz), 1, tauMaxAllowed);
  const tauMax = clamp(Math.ceil(sampleRate / minHz), tauMin + 1, tauMaxAllowed);

  // Work buffers hold indices 0..tauMax. Reuse the caller's scratch when it is
  // supplied and big enough (the streaming path); otherwise allocate lazily so
  // one-shot callers keep working. Only indices [0..tauMax] are written and read
  // below, so a larger reused buffer's stale tail is never observed.
  const need = tauMax + 1;
  let diff: Float32Array;
  let cmnd: Float32Array;
  if (scratch && scratch.diff.length >= need && scratch.cmnd.length >= need) {
    diff = scratch.diff;
    cmnd = scratch.cmnd;
  } else {
    diff = new Float32Array(need);
    cmnd = new Float32Array(need);
  }

  // Step 1: difference function d(tau) over the fixed window. Computed from
  // tau=1 (not tauMin) so the cumulative mean below sums over the full lag
  // range d(1..tau); truncating the sum at tauMin inflates the normalized dip
  // near tauMin and makes the detector octave-halve tones close to maxHz.
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const delta = frame[j] - frame[j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Step 2: cumulative mean normalized difference. d'(tau) = d(tau) divided by
  // the running mean of d(1..tau); this de-emphasizes the trivial tau=0 dip and
  // makes the absolute threshold meaningful across signal levels.
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  // Step 3: absolute threshold — take the FIRST lag whose CMND drops below the
  // threshold, then descend to the bottom of that dip. Choosing the first dip
  // (not the global min) is what prevents locking onto period multiples.
  let bestTau = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) return UNVOICED; // no periodicity below threshold -> unvoiced

  // Step 4: sub-octave guard. If half the chosen period lands on a comparably
  // deep dip, the chosen period was a harmonic of the true one; drop an octave
  // toward the fundamental. Repeat while the shorter period stays in range.
  for (;;) {
    const half = Math.round(bestTau / 2);
    if (half < tauMin) break;
    // Local min around the half-period bin, robust to interpolation offset.
    let subTau = half;
    let subVal = cmnd[half];
    if (half - 1 >= tauMin && cmnd[half - 1] < subVal) {
      subTau = half - 1;
      subVal = cmnd[half - 1];
    }
    if (half + 1 <= tauMax && cmnd[half + 1] < subVal) {
      subTau = half + 1;
      subVal = cmnd[half + 1];
    }
    // Only drop the octave when the half-period is itself a genuine dip (below
    // the absolute threshold). Comparing to cmnd[bestTau] alone lets a merely
    // "comparably shallow" half-lag win even when it is above threshold, which
    // halves the period of a real fundamental that happens to carry a strong
    // 2nd harmonic — an octave-too-high reading.
    if (subVal < threshold && subVal < cmnd[bestTau] + OCTAVE_MARGIN) {
      bestTau = subTau;
    } else {
      break;
    }
  }

  const refined = parabolicRefine(cmnd, bestTau, tauMin, tauMax);
  if (!Number.isFinite(refined) || refined <= 0) return UNVOICED;

  const f0 = sampleRate / refined;
  if (!Number.isFinite(f0) || f0 <= 0) return UNVOICED;

  // Confidence: how deep the winning dip is (1 - CMND), clamped. A perfect
  // periodic signal approaches 1; borderline dips near threshold stay low.
  const confidence = clamp(1 - cmnd[bestTau], 0, 1);

  // Guard the reported pitch against interpolation overshoot at the edges.
  if (f0 < minHz * 0.5 || f0 > maxHz * 2) return UNVOICED;

  return { f0, confidence };
}

export interface PitchTrackerOptions {
  minHz?: number;
  maxHz?: number;
  frameSize?: number;
  hopSize?: number;
}

/**
 * Streaming wrapper around {@link yinDetect}. Buffers arbitrary-sized input
 * blocks and runs detection on fixed frames advanced by `hopSize`, returning the
 * most recent estimate. Fully deterministic; `reset()` restores the initial state.
 */
export class PitchTracker {
  private readonly sampleRate: number;
  private readonly frameSize: number;
  private readonly hopSize: number;
  private readonly holdFrames: number;
  private readonly yinOpts: YinOptions;
  // Reusable scratch buffers: process() runs on the audio thread (~375×/sec), so
  // steady-state must not allocate — GC pauses there cause audible dropouts.
  private pending: Float32Array;
  private pendingLen: number;
  private frame: Float32Array;
  private readonly yinScratch: YinScratch;
  private last: PitchResult;
  private unvoicedRun: number;

  constructor(sampleRate: number, opts: PitchTrackerOptions = {}) {
    this.sampleRate = sampleRate;
    const requestedFrame = Math.max(4, Math.floor(opts.frameSize ?? DEFAULT_FRAME_SIZE));
    const minHz = clamp(opts.minHz ?? DEFAULT_MIN_HZ, 1, sampleRate / 2);
    const maxHz = clamp(opts.maxHz ?? DEFAULT_MAX_HZ, minHz + 1, sampleRate / 2);
    // Derived sizing: YIN's integration window is half the frame, so the largest
    // lag it can evaluate is (frameSize/2 - 1). To actually reach `minHz` at this
    // sample rate the frame must satisfy (frameSize/2 - 1) >= sampleRate/minHz;
    // a shorter frame silently floors detection well above the advertised minHz
    // (a 2048 frame at 96 kHz floors at ~94 Hz, missing C2/E2). Grow the frame to
    // the minimum that honors minHz — but never SHRINK a caller's explicit frame,
    // and never raise latency for a high-minHz caller whose request already
    // suffices. The +2 keeps the bottom lag off the interpolation edge; capped by
    // MAX_FRAME_SIZE so a pathological minHz can't request an enormous buffer.
    const requiredFrame = Math.min(MAX_FRAME_SIZE, 2 * (Math.ceil(sampleRate / minHz) + 2));
    this.frameSize = Math.max(requestedFrame, requiredFrame);
    // Default to 50% overlap; clamp to a valid [1, frameSize] range.
    const hop = opts.hopSize ?? this.frameSize >> 1;
    this.hopSize = clamp(Math.floor(hop), 1, this.frameSize);
    // Convert the time-based unvoiced hold to a frame count from the actual hop
    // so hold duration is stable across sample rate / hop (>= 1 frame).
    this.holdFrames = Math.max(1, Math.round((UNVOICED_HOLD_MS / 1000) * sampleRate / this.hopSize));
    this.yinOpts = { minHz, maxHz };
    // Leftover after framing is < frameSize, so frameSize + a typical quantum
    // fits in 2×frameSize; larger blocks grow the scratch once, then reuse it.
    this.pending = new Float32Array(this.frameSize * 2);
    this.pendingLen = 0;
    this.frame = new Float32Array(this.frameSize);
    // YIN's work buffers span lags 0..tauMax, and tauMax <= frameSize/2 - 1, so
    // (frameSize>>1)+1 entries always cover the largest possible range for this
    // frame. Allocated once here; process() passes it on every call so the
    // steady-state audio-thread path allocates nothing.
    const scratchLen = (this.frameSize >> 1) + 1;
    this.yinScratch = { diff: new Float32Array(scratchLen), cmnd: new Float32Array(scratchLen) };
    this.last = UNVOICED;
    this.unvoicedRun = 0;
  }

  process(block: Float32Array): PitchResult {
    // Append incoming samples to whatever remains unconsumed. Grows only when a
    // larger block than ever seen arrives; steady state allocates nothing.
    const needed = this.pendingLen + block.length;
    if (needed > this.pending.length) {
      const grown = new Float32Array(needed);
      grown.set(this.pending.subarray(0, this.pendingLen));
      this.pending = grown;
    }
    this.pending.set(block, this.pendingLen);
    this.pendingLen = needed;

    let offset = 0;
    while (this.pendingLen - offset >= this.frameSize) {
      // Copy into the reusable frame so yinDetect never sees overlapping-frame
      // mutation of live pending data.
      this.frame.set(this.pending.subarray(offset, offset + this.frameSize));
      const result = yinDetect(this.frame, this.sampleRate, this.yinOpts, this.yinScratch);
      // Keep the last *voiced* estimate through brief unvoiced gaps, but adopt
      // fresh voiced results immediately so a sweep tracks without lag.
      if (result.f0 > 0) {
        this.last = result;
        this.unvoicedRun = 0;
      } else if (this.unvoicedRun < this.holdFrames) {
        this.unvoicedRun++;
        // Hold this.last across the brief gap.
      } else {
        this.last = result;
      }
      offset += this.hopSize;
    }

    if (offset > 0) {
      this.pending.copyWithin(0, offset, this.pendingLen);
      this.pendingLen -= offset;
    }
    return this.last;
  }

  reset(): void {
    this.pendingLen = 0;
    this.last = UNVOICED;
    this.unvoicedRun = 0;
  }
}

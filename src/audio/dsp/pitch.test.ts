import { describe, it, expect } from 'vitest';
import { yinDetect, PitchTracker, type PitchResult, type YinScratch } from './pitch';

const SR = 44100;

/** Assert a result is finite, bounded, and self-consistent. */
function expectFiniteBounded(r: PitchResult): void {
  expect(Number.isFinite(r.f0)).toBe(true);
  expect(Number.isFinite(r.confidence)).toBe(true);
  expect(r.f0).toBeGreaterThanOrEqual(0);
  expect(r.confidence).toBeGreaterThanOrEqual(0);
  expect(r.confidence).toBeLessThanOrEqual(1);
}

/** Assert `actual` is within `pct` percent of `expected`. */
function expectWithinPercent(actual: number, expected: number, pct: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(pct / 100);
}

// --- Synthetic signal generators (in-test vectors, no fixtures) ------------

function synthSine(f0: number, sr: number, n: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  const step = (2 * Math.PI * f0) / sr;
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(step * i);
  return out;
}

/** Naive (aliasing) sawtooth: deliberately harmonic-rich to stress octave logic. */
function synthSaw(f0: number, sr: number, n: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * f0) / sr;
    out[i] = amp * 2 * (t - Math.floor(t + 0.5));
  }
  return out;
}

/** Linear frequency sweep via phase accumulation. */
function synthSweep(fStart: number, fEnd: number, sr: number, n: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = fStart + ((fEnd - fStart) * i) / (n - 1);
    out[i] = amp * Math.sin(phase);
    phase += (2 * Math.PI * f) / sr;
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so the noise test never flakes. */
function synthNoise(n: number, seed = 0x2545f491, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out[i] = amp * (r * 2 - 1);
  }
  return out;
}

// --- Tests -----------------------------------------------------------------

describe('yinDetect', () => {
  it('detects pure sine tones within 1% across octaves', () => {
    for (const f of [110, 220, 440, 880]) {
      const r = yinDetect(synthSine(f, SR, 2048), SR);
      expectFiniteBounded(r);
      expectWithinPercent(r.f0, f, 1);
      expect(r.confidence).toBeGreaterThan(0.8);
    }
  });

  it('detects high sine tones near maxHz without octave-halving', () => {
    // Regression: cumulative-mean normalization used to sum only over d(tauMin..tau),
    // inflating the dip near tauMin so tones in the top of the range locked onto
    // twice the period (half the frequency) with full confidence.
    for (const f of [940, 985, 1000]) {
      const r = yinDetect(synthSine(f, SR, 2048), SR, { maxHz: 1000 });
      expectFiniteBounded(r);
      expectWithinPercent(r.f0, f, 1);
      expect(r.confidence).toBeGreaterThan(0.8);
      // Must NOT report the sub-octave.
      expect(Math.abs(r.f0 - f / 2)).toBeGreaterThan(f * 0.1);
    }
  });

  it('detects harmonic-rich sawtooth at 220 Hz without octave error', () => {
    const r = yinDetect(synthSaw(220, SR, 2048), SR);
    expectFiniteBounded(r);
    expectWithinPercent(r.f0, 220, 1);
    // Explicitly reject the classic octave-up / octave-down confusions.
    expect(Math.abs(r.f0 - 110)).toBeGreaterThan(20);
    expect(Math.abs(r.f0 - 440)).toBeGreaterThan(20);
  });

  it('does not octave-up a weak fundamental carrying a strong 2nd harmonic', () => {
    // Regression: the sub-octave guard used to halve bestTau whenever the
    // half-period CMND was merely "comparably shallow", even when that half-lag
    // sat ABOVE the absolute threshold (i.e. not a real periodicity). A 180 Hz
    // tone with a dominant 2nd harmonic + noise then read as 360 Hz. The guard
    // now requires the half-period dip to be sub-threshold.
    const sr = 48000;
    const f = 180;
    const n = 2048;
    const sig = new Float32Array(n);
    let s = 0x9e37 >>> 0;
    for (let i = 0; i < n; i++) {
      let v = 0.15 * Math.sin((2 * Math.PI * f * i) / sr); // weak fundamental
      v += 0.6 * Math.sin((2 * Math.PI * 2 * f * i) / sr); // strong 2nd harmonic
      s = (s * 1664525 + 1013904223) >>> 0;
      v += 0.3 * (s / 2147483648 - 1); // deterministic noise
      sig[i] = v;
    }
    const r = yinDetect(sig, sr, { minHz: 70, maxHz: 1000 });
    expectFiniteBounded(r);
    expectWithinPercent(r.f0, f, 8);
    expect(Math.abs(r.f0 - 2 * f)).toBeGreaterThan(f * 0.2);
  });

  it('reports white noise as unvoiced (low confidence / no pitch)', () => {
    const r = yinDetect(synthNoise(2048), SR);
    expectFiniteBounded(r);
    if (r.f0 !== 0) {
      // If any spurious dip passed threshold, it must be weak.
      expect(r.confidence).toBeLessThan(0.5);
    } else {
      expect(r.confidence).toBe(0);
    }
  });

  it('reports silence as f0=0, confidence=0', () => {
    const r = yinDetect(new Float32Array(2048), SR);
    expect(r).toEqual({ f0: 0, confidence: 0 });
  });

  it('never returns NaN/Infinity for pathological input', () => {
    const cases = [
      new Float32Array(2048).fill(1), // DC
      synthSine(50, SR, 2048), // below default minHz
      synthSine(12000, SR, 2048), // above default maxHz
      new Float32Array(8), // too short
    ];
    for (const c of cases) expectFiniteBounded(yinDetect(c, SR));
  });

  it('is deterministic for identical input', () => {
    const buf = synthSine(330, SR, 2048);
    expect(yinDetect(buf, SR)).toEqual(yinDetect(buf, SR));
  });

  it('reuses supplied scratch buffers and matches the allocating path bit-for-bit', () => {
    // Regression for the audio-thread allocation defect: yinDetect must accept
    // preallocated work buffers so the streaming path never allocates. The result
    // must be identical whether scratch is supplied or lazily allocated.
    const frame = synthSine(220, SR, 2048);
    const scratch: YinScratch = {
      diff: new Float32Array(2048),
      cmnd: new Float32Array(2048),
    };
    const withScratch = yinDetect(frame, SR, {}, scratch);
    const withoutScratch = yinDetect(frame, SR, {});
    expect(withScratch).toEqual(withoutScratch);

    // The supplied buffers were actually written into (proof the scratch path ran
    // rather than a fresh internal allocation): a voiced frame yields non-zero
    // difference energy in the low lag bins.
    let touched = false;
    for (let i = 1; i < 64; i++) {
      if (scratch.diff[i] !== 0) {
        touched = true;
        break;
      }
    }
    expect(touched).toBe(true);

    // A too-small scratch must not corrupt output: yinDetect falls back to a lazy
    // allocation and still returns the correct pitch.
    const tiny: YinScratch = { diff: new Float32Array(4), cmnd: new Float32Array(4) };
    expect(yinDetect(frame, SR, {}, tiny)).toEqual(withoutScratch);
  });
});

describe('PitchTracker', () => {
  it('tracks a 200->400 Hz sweep with a monotone-ish rising f0', () => {
    const n = SR; // 1 second
    const sweep = synthSweep(200, 400, SR, n);
    // minHz:150 keeps the derived frame at the requested 1024 (this sweep is
    // mid-range; a 1024 window suffices above ~150 Hz).
    const tracker = new PitchTracker(SR, { minHz: 150, frameSize: 1024, hopSize: 512 });

    const estimates: number[] = [];
    const blockSize = 512;
    for (let i = 0; i < n; i += blockSize) {
      const r = tracker.process(sweep.subarray(i, Math.min(i + blockSize, n)));
      expectFiniteBounded(r);
      if (r.f0 > 0) estimates.push(r.f0);
    }

    expect(estimates.length).toBeGreaterThan(10);
    // Endpoints land near the sweep bounds.
    expect(estimates[0]).toBeLessThan(260);
    expect(estimates[estimates.length - 1]).toBeGreaterThan(340);
    // Rising overall.
    expect(estimates[estimates.length - 1]).toBeGreaterThan(estimates[0]);
    // Mostly non-decreasing: allow a few small dips from framing/interpolation.
    let drops = 0;
    for (let i = 1; i < estimates.length; i++) {
      if (estimates[i] < estimates[i - 1] - 5) drops++;
    }
    expect(drops).toBeLessThan(estimates.length * 0.2);
    // Bounded within the swept range (plus margin).
    for (const f of estimates) {
      expect(f).toBeGreaterThan(180);
      expect(f).toBeLessThan(430);
    }
  });

  it('tracks a low male fundamental (E2 ~82 Hz) with a 2048 frame', () => {
    // A 1024 frame floors detection at ~86 Hz (44.1k) and misses E2/F2 entirely;
    // frameSize 2048 (window = 1024) is needed to reach the engine's minHz=70.
    const e2 = 82.41;
    const tracker = new PitchTracker(SR, { minHz: 70, maxHz: 1000, frameSize: 2048, hopSize: 512 });
    let r: PitchResult = { f0: 0, confidence: 0 };
    // Feed enough blocks to fill a full frame and settle.
    for (let i = 0; i < 8; i++) r = tracker.process(synthSine(e2, SR, 1024));
    expect(r.f0).toBeGreaterThan(0);
    // Resolution at the very bottom of the range is coarse (period ~535 samples);
    // 6% still confirms the fundamental rather than an octave error or noise.
    expectWithinPercent(r.f0, e2, 6);
  });

  it('produces identical results on repeated identical input', () => {
    const buf = synthSine(220, SR, 4096);
    const a = new PitchTracker(SR);
    const b = new PitchTracker(SR);
    expect(a.process(buf)).toEqual(b.process(buf));
  });

  it('reset() restores the initial state (matches a fresh instance)', () => {
    const buf = synthSine(440, SR, 4096);
    const tracker = new PitchTracker(SR);
    const first = { ...tracker.process(buf) };

    tracker.reset();
    const afterReset = tracker.process(buf);
    expect(afterReset).toEqual(first);

    const fresh = new PitchTracker(SR).process(buf);
    expect(afterReset).toEqual(fresh);
  });

  it('holds the last voiced estimate through a brief unvoiced gap', () => {
    // No overlap so each block maps cleanly to one frame with no leftover.
    const tracker = new PitchTracker(SR, { minHz: 150, frameSize: 1024, hopSize: 1024 });
    const voiced = tracker.process(synthSine(220, SR, 1024));
    expect(voiced.f0).toBeGreaterThan(0);
    expectWithinPercent(voiced.f0, 220, 5);

    // A single unvoiced (silent) frame must not immediately drop the pitch.
    const held = tracker.process(new Float32Array(1024));
    expect(held).toEqual(voiced);
  });

  it('clears to unvoiced after a sustained unvoiced gap', () => {
    const tracker = new PitchTracker(SR, { minHz: 150, frameSize: 1024, hopSize: 1024 });
    tracker.process(synthSine(220, SR, 1024));
    // Well past the brief-hold window.
    let r: PitchResult = { f0: -1, confidence: -1 };
    for (let i = 0; i < 10; i++) r = tracker.process(new Float32Array(1024));
    expect(r).toEqual({ f0: 0, confidence: 0 });
  });

  it('returns unvoiced before a full frame is buffered', () => {
    const tracker = new PitchTracker(SR, { frameSize: 1024 });
    const r = tracker.process(synthSine(220, SR, 256));
    expect(r).toEqual({ f0: 0, confidence: 0 });
  });

  it('does not allocate Float32Array in steady-state process() (audio-thread safe)', () => {
    // Regression for GC-induced dropouts: process() runs ~375×/sec on the audio
    // thread, so once warmed up it must allocate zero Float32Arrays per call. We
    // count constructions deterministically (no timing/GC heuristics) by swapping
    // in a counting subclass around a steady run of same-sized blocks.
    const tracker = new PitchTracker(SR, { minHz: 150, frameSize: 1024, hopSize: 512 });
    const block = synthSine(220, SR, 512);
    // Warmup: lets any one-time internal buffer sizing settle before we measure.
    for (let i = 0; i < 20; i++) tracker.process(block);

    const RealF32 = globalThis.Float32Array;
    let allocations = 0;
    class CountingF32 extends RealF32 {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        super(...(args as []));
        allocations++;
      }
    }
    // subarray()/set()/copyWithin() use the SpeciesConstructor of the *existing*
    // (real) arrays, so they never route through this patched global — only a
    // literal `new Float32Array(...)` inside process() would bump the counter.
    (globalThis as unknown as { Float32Array: typeof Float32Array }).Float32Array =
      CountingF32 as unknown as typeof Float32Array;
    try {
      for (let i = 0; i < 100; i++) tracker.process(block);
    } finally {
      (globalThis as unknown as { Float32Array: typeof Float32Array }).Float32Array = RealF32;
    }
    expect(allocations).toBe(0);
  });
});

// --- Low-register detection across sample rates (derived frame sizing) ------
//
// Regression for the low-frequency floor bug: PitchTracker's analysis window is
// half the frame, so the max evaluable lag is frameSize/2 - 1. A fixed 2048
// frame reaches ~70 Hz at 44.1/48 kHz but floors at ~94 Hz at 96 kHz, silently
// missing C2/E2. The tracker now DERIVES the frame from minHz+sampleRate, so a
// configured minHz is honored at every rate. These tests would fail on a tracker
// that trusted the requested frame size at 96 kHz.

/** Feed a signal through a tracker in fixed blocks; return the final estimate. */
function feed(tracker: PitchTracker, sig: Float32Array, blockSize = 512): PitchResult {
  let r: PitchResult = { f0: 0, confidence: 0 };
  for (let i = 0; i < sig.length; i += blockSize) {
    r = tracker.process(sig.subarray(i, Math.min(i + blockSize, sig.length)));
  }
  return r;
}

/** Harmonic-rich tone: fundamental + decaying harmonics (formant-like energy). */
function synthHarmonic(f0: number, sr: number, n: number, harmonics = 5, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= harmonics; h++) s += (1 / h) * Math.sin((2 * Math.PI * f0 * h * i) / sr);
    out[i] = amp * s * 0.5;
  }
  return out;
}

/** Add deterministic low-level noise to a signal (mildly noisy voiced case). */
function addNoise(sig: Float32Array, amp = 0.04, seed = 0xc0ffee): Float32Array {
  const out = new Float32Array(sig.length);
  let s = seed >>> 0;
  for (let i = 0; i < sig.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = sig[i] + amp * (s / 2147483648 - 1);
  }
  return out;
}

describe('PitchTracker low-register across sample rates', () => {
  const RATES = [44100, 48000, 96000];
  // Note names -> Hz. C2/E2/A2 are the low male vocal range from the spec.
  const NOTES: Array<[string, number]> = [
    ['C2', 65.41],
    ['E2', 82.41],
    ['A2', 110.0],
  ];

  for (const sr of RATES) {
    for (const [name, hz] of NOTES) {
      it(`detects ${name} (${hz} Hz) sine at ${sr} Hz`, () => {
        // minHz:60 (below C2) + derived sizing must make the frame long enough.
        const tracker = new PitchTracker(sr, { minHz: 60, maxHz: 1000, hopSize: 512 });
        // Feed ~0.25 s so even the largest derived frame (96 kHz) fills and settles.
        const r = feed(tracker, synthSine(hz, sr, Math.round(sr * 0.25)));
        expect(r.f0).toBeGreaterThan(0);
        expectWithinPercent(r.f0, hz, 4);
        // Explicitly reject octave-up and octave-down errors.
        expect(Math.abs(r.f0 - hz * 2)).toBeGreaterThan(hz * 0.3);
        expect(Math.abs(r.f0 - hz / 2)).toBeGreaterThan(hz * 0.3);
      });
    }

    it(`detects harmonic-rich E2 at ${sr} Hz without octave error`, () => {
      const tracker = new PitchTracker(sr, { minHz: 60, maxHz: 1000, hopSize: 512 });
      const r = feed(tracker, synthHarmonic(82.41, sr, Math.round(sr * 0.25)));
      expect(r.f0).toBeGreaterThan(0);
      expectWithinPercent(r.f0, 82.41, 5);
      expect(Math.abs(r.f0 - 82.41 * 2)).toBeGreaterThan(82.41 * 0.3);
    });

    it(`detects mildly noisy A2 at ${sr} Hz`, () => {
      const tracker = new PitchTracker(sr, { minHz: 60, maxHz: 1000, hopSize: 512 });
      const r = feed(tracker, addNoise(synthSine(110, sr, Math.round(sr * 0.25))));
      expect(r.f0).toBeGreaterThan(0);
      expectWithinPercent(r.f0, 110, 5);
    });

    it(`detects a near-minimum tone (~minHz+3) at ${sr} Hz`, () => {
      const minHz = 70;
      const tracker = new PitchTracker(sr, { minHz, maxHz: 1000, hopSize: 512 });
      const r = feed(tracker, synthSine(minHz + 3, sr, Math.round(sr * 0.25)));
      expect(r.f0).toBeGreaterThan(0);
      expectWithinPercent(r.f0, minHz + 3, 6);
    });

    it(`rejects a below-minimum tone at ${sr} Hz (no confident false pitch)`, () => {
      const minHz = 90;
      const tracker = new PitchTracker(sr, { minHz, maxHz: 1000, hopSize: 512 });
      // 55 Hz is below minHz: its period exceeds the max lag, so no in-range dip.
      const r = feed(tracker, synthSine(55, sr, Math.round(sr * 0.25)));
      // Either unvoiced, or if some spurious dip passed it must not be a confident
      // in-range reading near the true (out-of-range) fundamental.
      if (r.f0 > 0) {
        expect(r.f0).toBeGreaterThanOrEqual(minHz * 0.5);
      } else {
        expect(r).toEqual({ f0: 0, confidence: 0 });
      }
    });
  }

  it('tracks a low->high transition (C2 -> A4)', () => {
    const sr = 48000;
    const tracker = new PitchTracker(sr, { minHz: 60, maxHz: 1000, hopSize: 512 });
    const low = feed(tracker, synthSine(65.41, sr, Math.round(sr * 0.25)));
    expect(low.f0).toBeGreaterThan(0);
    expectWithinPercent(low.f0, 65.41, 5);
    const high = feed(tracker, synthSine(440, sr, Math.round(sr * 0.25)));
    expectWithinPercent(high.f0, 440, 3);
    // The estimate actually moved up by roughly the true ratio, not stuck low.
    expect(high.f0).toBeGreaterThan(low.f0 * 4);
  });

  it('does not grow the frame beyond a high-minHz request (no added latency)', () => {
    // minHz:300 at 48 kHz needs only a ~324-sample frame, so a requested 1024
    // frame is NOT grown: one 1024-sample block fills exactly one frame and
    // yields a voiced estimate. A tracker that over-grew the frame would still
    // report unvoiced after a single block.
    const sr = 48000;
    const tracker = new PitchTracker(sr, { minHz: 300, maxHz: 2000, frameSize: 1024, hopSize: 512 });
    const r = tracker.process(synthSine(440, sr, 1024));
    expect(r.f0).toBeGreaterThan(0);
    expectWithinPercent(r.f0, 440, 3);
  });
});

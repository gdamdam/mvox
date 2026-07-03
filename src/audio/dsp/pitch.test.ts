import { describe, it, expect } from 'vitest';
import { yinDetect, PitchTracker, type PitchResult } from './pitch';

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
});

describe('PitchTracker', () => {
  it('tracks a 200->400 Hz sweep with a monotone-ish rising f0', () => {
    const n = SR; // 1 second
    const sweep = synthSweep(200, 400, SR, n);
    const tracker = new PitchTracker(SR, { frameSize: 1024, hopSize: 512 });

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
    const tracker = new PitchTracker(SR, { frameSize: 1024, hopSize: 1024 });
    const voiced = tracker.process(synthSine(220, SR, 1024));
    expect(voiced.f0).toBeGreaterThan(0);
    expectWithinPercent(voiced.f0, 220, 5);

    // A single unvoiced (silent) frame must not immediately drop the pitch.
    const held = tracker.process(new Float32Array(1024));
    expect(held).toEqual(voiced);
  });

  it('clears to unvoiced after a sustained unvoiced gap', () => {
    const tracker = new PitchTracker(SR, { frameSize: 1024, hopSize: 1024 });
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
});

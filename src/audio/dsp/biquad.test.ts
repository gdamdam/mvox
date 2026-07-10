import { describe, it, expect } from "vitest";
import {
  Biquad,
  bandpassCoeffs,
  lowpassCoeffs,
  highpassCoeffs,
  type BiquadCoeffs,
} from "./biquad";

const FS = 48000;

// --- test helpers -----------------------------------------------------------

// Run a sine of frequency `freq` through a filter and return the steady-state
// RMS of the output. We discard the first `warmup` samples so the transient IR
// has decayed and we measure the settled response only.
function steadyStateRms(
  coeffs: BiquadCoeffs,
  freq: number,
  { fs = FS, warmup = 4096, measure = 4096 } = {},
): number {
  const bq = new Biquad();
  bq.setCoeffs(coeffs);
  const w = (2 * Math.PI * freq) / fs;
  for (let n = 0; n < warmup; n++) bq.process(Math.sin(w * n));
  let sumSq = 0;
  for (let n = 0; n < measure; n++) {
    const y = bq.process(Math.sin(w * (warmup + n)));
    sumSq += y * y;
  }
  return Math.sqrt(sumSq / measure);
}

// RMS of the pure input sine — reference "unity" level (≈ 1/√2).
const INPUT_RMS = Math.SQRT1_2;

function allFinite(c: BiquadCoeffs): boolean {
  return (
    Number.isFinite(c.b0) &&
    Number.isFinite(c.b1) &&
    Number.isFinite(c.b2) &&
    Number.isFinite(c.a1) &&
    Number.isFinite(c.a2)
  );
}

// --- coefficient sanity ------------------------------------------------------

describe("coefficients", () => {
  it("are finite for normal and pathological inputs", () => {
    expect(allFinite(bandpassCoeffs(FS, 1000, 5))).toBe(true);
    expect(allFinite(lowpassCoeffs(FS, 1000, 0.707))).toBe(true);
    expect(allFinite(highpassCoeffs(FS, 1000, 0.707))).toBe(true);
    // Out-of-range / garbage inputs must still yield finite coeffs (clamped).
    expect(allFinite(bandpassCoeffs(FS, 0, 0))).toBe(true);
    expect(allFinite(bandpassCoeffs(FS, FS, -3))).toBe(true);
    expect(allFinite(bandpassCoeffs(FS, Number.NaN, Number.POSITIVE_INFINITY))).toBe(true);
    expect(allFinite(lowpassCoeffs(FS, 1e9, 1e9))).toBe(true);
  });
});

// --- bandpass ----------------------------------------------------------------

describe("bandpass (constant 0 dB peak gain)", () => {
  const center = 1000;
  const q = 4;
  const coeffs = bandpassCoeffs(FS, center, q);

  it("passes a sine at center frequency at ~unity", () => {
    const rms = steadyStateRms(coeffs, center);
    // Constant-peak BPF: gain at center is ~0 dB regardless of Q.
    expect(rms).toBeGreaterThan(0.9 * INPUT_RMS);
    expect(rms).toBeLessThan(1.1 * INPUT_RMS);
  });

  it("strongly attenuates a sine an octave+ away", () => {
    const centerRms = steadyStateRms(coeffs, center);
    const octaveUp = steadyStateRms(coeffs, center * 2);
    const octaveDown = steadyStateRms(coeffs, center / 2);
    expect(octaveUp / centerRms).toBeLessThan(0.5);
    expect(octaveDown / centerRms).toBeLessThan(0.5);
    // Two octaves away should be far down.
    const twoOctavesUp = steadyStateRms(coeffs, center * 4);
    expect(twoOctavesUp / centerRms).toBeLessThan(0.2);
  });
});

// --- lowpass / highpass ------------------------------------------------------

describe("lowpass", () => {
  const cutoff = 1000;
  const coeffs = lowpassCoeffs(FS, cutoff, Math.SQRT1_2);

  it("passes low frequencies and attenuates high ones", () => {
    const low = steadyStateRms(coeffs, cutoff / 8); // well in passband
    const high = steadyStateRms(coeffs, cutoff * 8); // well in stopband
    expect(low).toBeGreaterThan(0.9 * INPUT_RMS);
    expect(high / low).toBeLessThan(0.1);
  });
});

describe("highpass", () => {
  const cutoff = 1000;
  const coeffs = highpassCoeffs(FS, cutoff, Math.SQRT1_2);

  it("passes high frequencies and attenuates low ones", () => {
    const high = steadyStateRms(coeffs, cutoff * 8);
    const low = steadyStateRms(coeffs, cutoff / 8);
    expect(high).toBeGreaterThan(0.9 * INPUT_RMS);
    expect(low / high).toBeLessThan(0.1);
  });
});

// --- stability ---------------------------------------------------------------

describe("stability", () => {
  it("impulse response is bounded and decays toward zero", () => {
    const bq = new Biquad();
    bq.setCoeffs(bandpassCoeffs(FS, 1000, 8));
    const N = 8192;
    const ir: number[] = [];
    ir.push(bq.process(1)); // unit impulse
    for (let n = 1; n < N; n++) ir.push(bq.process(0));

    // All finite and bounded.
    for (const v of ir) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(10);
    }
    // Tail energy must be far below early energy → the filter decays.
    const early = ir.slice(0, 256).reduce((s, v) => s + v * v, 0);
    const tail = ir.slice(N - 256).reduce((s, v) => s + v * v, 0);
    expect(tail).toBeLessThan(early * 1e-3);
  });
});

// --- determinism / reset -----------------------------------------------------

describe("reset", () => {
  it("produces identical output on repeat after reset()", () => {
    const bq = new Biquad();
    bq.setCoeffs(bandpassCoeffs(FS, 1200, 3));
    const run = (): number[] => {
      const out: number[] = [];
      for (let n = 0; n < 512; n++) out.push(bq.process(Math.sin((2 * Math.PI * 300 * n) / FS)));
      return out;
    };
    const first = run();
    bq.reset();
    const second = run();
    expect(second).toEqual(first);
  });

  it("flushes decaying state to exactly zero after a long silence", () => {
    // Regression: DF2T state used to decay geometrically into the denormal range
    // and linger there forever. On x86 without FTZ that means every subsequent
    // silent sample runs 10-100× slower — a CPU spike after a tail. The flush
    // snaps sub-1e-15 state to 0, so output reaches EXACTLY zero. Without it, a
    // high-Q filter settles to a tiny nonzero denormal (~1e-57 here), never 0.
    const bq = new Biquad();
    bq.setCoeffs(bandpassCoeffs(FS, 200, 20)); // high Q → long ring-down
    bq.process(1); // impulse
    let y = 1;
    for (let i = 0; i < 200000; i++) y = bq.process(0);
    expect(y).toBe(0);
  });
});

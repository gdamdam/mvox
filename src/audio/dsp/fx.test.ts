import { describe, it, expect } from "vitest";
import { FxChain } from "./fx";
import type { FxParams } from "../contracts";

const FS = 48000;

// --- param builders ----------------------------------------------------------

// A fully-neutral FX config: every stage bypassed. limiterCeiling is required by
// the interface but ignored by FxChain (the limiter lives elsewhere in the graph).
function neutral(): FxParams {
  return {
    drive: 0,
    chorus: 0,
    delayTime: 0.3,
    delaySync: false,
    delayFeedback: 0,
    delayMix: 0,
    reverb: 0,
    limiterCeiling: -1,
  };
}

function withParams(overrides: Partial<FxParams>): FxParams {
  return { ...neutral(), ...overrides };
}

// --- signal helpers ----------------------------------------------------------

function rms(xs: number[]): number {
  let sumSq = 0;
  for (const x of xs) sumSq += x * x;
  return Math.sqrt(sumSq / xs.length);
}

function peak(xs: number[]): number {
  let p = 0;
  for (const x of xs) p = Math.max(p, Math.abs(x));
  return p;
}

function allFinite(xs: number[]): boolean {
  return xs.every((x) => Number.isFinite(x));
}

// Run mono `input` through both channels of a fresh chain, return left output.
function runL(fx: FxParams, bpm: number, input: number[]): number[] {
  const chain = new FxChain(FS);
  chain.setParams(fx, bpm);
  return input.map((x) => chain.process(x, x)[0]);
}

// A short deterministic pseudo-random sequence (no Math.random → reproducible).
function noise(n: number, seed = 12345): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out.push((s / 0xffffffff) * 2 - 1);
  }
  return out;
}

function sine(n: number, freq: number, amp = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(amp * Math.sin((2 * Math.PI * freq * i) / FS));
  return out;
}

function impulse(n: number): number[] {
  const out = new Array<number>(n).fill(0);
  out[0] = 1;
  return out;
}

// --- dry passthrough ---------------------------------------------------------

describe("neutral params", () => {
  it("passes the signal through unchanged", () => {
    const input = sine(2000, 440, 0.5);
    const out = runL(neutral(), 120, input);
    for (let i = 0; i < input.length; i++) {
      expect(out[i]).toBeCloseTo(input[i], 6);
    }
  });
});

// --- drive -------------------------------------------------------------------

describe("drive", () => {
  it("stays bounded and adds harmonic content on a loud sine", () => {
    const input = sine(4000, 220, 0.9);
    const out = runL(withParams({ drive: 1 }), 120, input);

    expect(allFinite(out)).toBe(true);
    // tanh soft-clip keeps peaks controlled — not a hard limiter, so allow ~1.x.
    expect(peak(out)).toBeLessThan(1.5);
    // Waveshaping must actually change the signal (harmonics), not pass it through.
    let identical = true;
    for (let i = 0; i < input.length; i++) {
      if (Math.abs(out[i] - input[i]) > 1e-4) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(false);
    expect(rms(out)).toBeGreaterThan(0);
  });
});

// --- delay -------------------------------------------------------------------

describe("delay", () => {
  it("reproduces an impulse ~delayTime later (unsynced)", () => {
    const delayTime = 0.1;
    const expected = Math.round(delayTime * FS);
    const out = runL(
      withParams({ delayTime, delaySync: false, delayMix: 1, delayFeedback: 0 }),
      120,
      impulse(expected + 500),
    );
    // Find where the echo lands.
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 1; i < out.length; i++) {
      if (Math.abs(out[i]) > peakVal) {
        peakVal = Math.abs(out[i]);
        peakIdx = i;
      }
    }
    expect(peakVal).toBeGreaterThan(0.5);
    // Read head sits `delaySamples` behind the write head, so the echo lands one
    // sample past the nominal offset — allow a small window.
    expect(Math.abs(peakIdx - expected)).toBeLessThanOrEqual(2);
  });

  it("places the echo at the quarter note when synced (bpm 120 -> 0.5 s)", () => {
    const expected = Math.round(0.5 * FS); // 60/120 = 0.5 s
    const out = runL(
      withParams({ delaySync: true, delayMix: 1, delayFeedback: 0 }),
      120,
      impulse(expected + 500),
    );
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 1; i < out.length; i++) {
      if (Math.abs(out[i]) > peakVal) {
        peakVal = Math.abs(out[i]);
        peakIdx = i;
      }
    }
    expect(peakVal).toBeGreaterThan(0.5);
    expect(Math.abs(peakIdx - expected)).toBeLessThanOrEqual(2);
  });
});

// --- reverb ------------------------------------------------------------------

describe("reverb", () => {
  it("produces a bounded, decaying tail from an impulse", () => {
    const N = FS; // 1 s
    const out = runL(withParams({ reverb: 0.6 }), 120, impulse(N));

    expect(allFinite(out)).toBe(true);
    expect(peak(out)).toBeLessThan(4);

    // Energy in an early tail window vs a late one — must decay, not grow.
    const early = out.slice(2000, 12000);
    const late = out.slice(N - 10000);
    const earlyE = rms(early);
    const lateE = rms(late);
    expect(earlyE).toBeGreaterThan(0); // there IS a tail
    expect(lateE).toBeLessThan(earlyE); // and it decays
  });
});

// --- stability & finiteness --------------------------------------------------

describe("stability", () => {
  it("stays finite and bounded on 1 s of white noise at full params", () => {
    const input = noise(FS);
    const chain = new FxChain(FS);
    chain.setParams(
      withParams({
        drive: 1,
        chorus: 1,
        delaySync: false,
        delayTime: 0.25,
        delayFeedback: 0.95,
        delayMix: 1,
        reverb: 1,
      }),
      120,
    );
    let maxAbs = 0;
    for (const x of input) {
      const [l, r] = chain.process(x, x);
      expect(Number.isFinite(l)).toBe(true);
      expect(Number.isFinite(r)).toBe(true);
      maxAbs = Math.max(maxAbs, Math.abs(l), Math.abs(r));
    }
    expect(maxAbs).toBeLessThan(8);
  });

  it("does not propagate NaN", () => {
    const chain = new FxChain(FS);
    chain.setParams(withParams({ drive: 1, chorus: 1, delayFeedback: 0.9, delayMix: 1, reverb: 1 }), 120);
    // Feed a NaN, then normal samples: output must stay finite throughout.
    const [nl, nr] = chain.process(Number.NaN, Number.NaN);
    expect(Number.isFinite(nl)).toBe(true);
    expect(Number.isFinite(nr)).toBe(true);
    for (let i = 0; i < 1000; i++) {
      const [l, r] = chain.process(0.3, 0.3);
      expect(Number.isFinite(l)).toBe(true);
      expect(Number.isFinite(r)).toBe(true);
    }
  });
});

// --- determinism / reset -----------------------------------------------------

describe("reset", () => {
  it("reproduces identical output after reset()", () => {
    const fx = withParams({ drive: 0.5, chorus: 0.6, delayFeedback: 0.5, delayMix: 0.5, reverb: 0.4 });
    const chain = new FxChain(FS);
    chain.setParams(fx, 120);
    const input = noise(2000);
    const run = (): number[] => input.map((x) => chain.process(x, x)[0]);

    const first = run();
    chain.reset();
    const second = run();
    expect(second).toEqual(first);
  });
});

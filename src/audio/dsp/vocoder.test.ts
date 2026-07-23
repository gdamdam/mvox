import { describe, it, expect } from "vitest";
import {
  vocoderBandFrequencies,
  vocoderBandQ,
  clampBandCount,
  EnvelopeFollower,
} from "./vocoder";

const FS = 48000;

describe("vocoderBandFrequencies", () => {
  it("returns N ascending, log-spaced freqs inside [low, high]", () => {
    const low = 120;
    const high = 8000;
    const freqs = vocoderBandFrequencies(16, low, high);

    expect(freqs).toHaveLength(16);
    for (const f of freqs) {
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThan(low);
      expect(f).toBeLessThan(high);
    }
    // Strictly ascending.
    for (let i = 1; i < freqs.length; i++) {
      expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
    }
    // Log-spaced → consecutive ratios are (nearly) constant.
    const ratios = freqs.slice(1).map((f, i) => f / freqs[i]);
    const first = ratios[0];
    for (const r of ratios) {
      expect(r).toBeCloseTo(first, 5);
    }
  });

  it("clamps band count when out of range", () => {
    expect(vocoderBandFrequencies(1)).toHaveLength(clampBandCount(1));
    expect(vocoderBandFrequencies(1).length).toBe(4); // MIN
    expect(vocoderBandFrequencies(1000).length).toBe(40); // MAX
    expect(clampBandCount(Number.NaN)).toBe(4);
  });

  it("falls back to defaults on invalid range", () => {
    const freqs = vocoderBandFrequencies(8, -5, -1);
    expect(freqs).toHaveLength(8);
    for (const f of freqs) expect(f).toBeGreaterThan(0);
  });
});

describe("vocoderBandQ", () => {
  it("is positive, finite, and increases with band count", () => {
    const qFew = vocoderBandQ(1000, 8);
    const qMany = vocoderBandQ(1000, 32);
    expect(qFew).toBeGreaterThan(0);
    expect(qMany).toBeGreaterThan(0);
    expect(Number.isFinite(qFew)).toBe(true);
    // More bands → narrower → higher Q.
    expect(qMany).toBeGreaterThan(qFew);
  });
});

// --- envelope follower -------------------------------------------------------

function sineBlock(env: EnvelopeFollower, amp: number, freq: number, samples: number): number {
  let last = 0;
  for (let n = 0; n < samples; n++) {
    last = env.process(amp * Math.sin((2 * Math.PI * freq * n) / FS));
  }
  return last;
}

describe("EnvelopeFollower", () => {
  it("rises toward the amplitude of a constant sine, then decays to ~0", () => {
    const env = new EnvelopeFollower(FS, 5, 50);
    const amp = 0.8;

    // Drive with a steady sine long enough to settle.
    const settled = sineBlock(env, amp, 440, FS); // 1 second
    // A rectified-sine envelope settles near the peak amplitude (fast attack,
    // longer release holds it up between zero-crossings).
    expect(settled).toBeGreaterThan(0.5 * amp);
    expect(settled).toBeLessThanOrEqual(amp + 1e-9);

    // Now feed silence: envelope must decay toward zero.
    let last = settled;
    for (let n = 0; n < FS; n++) last = env.process(0);
    expect(last).toBeLessThan(0.01 * amp);
    expect(last).toBeGreaterThanOrEqual(0);
  });

  it("output is always >= 0 and finite, even for pathological input", () => {
    const env = new EnvelopeFollower(FS, 1, 10);
    const inputs = [0, -1, 1, -1e6, 1e6, -0.0001];
    for (const x of inputs) {
      const y = env.process(x);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });

  it("tolerates invalid constructor / time values without NaN", () => {
    const env = new EnvelopeFollower(Number.NaN, Number.NaN, -5);
    const y = env.process(0.5);
    expect(Number.isFinite(y)).toBe(true);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it("value() returns the current envelope without advancing it", () => {
    const env = new EnvelopeFollower(FS, 5, 50);
    sineBlock(env, 0.8, 440, 5000); // settle to a non-zero level
    const before = env.value();
    // Reading the value repeatedly must not change it (no processing happens).
    expect(env.value()).toBe(before);
    expect(env.value()).toBe(before);
    expect(before).toBeGreaterThan(0);
    // It equals the last processed envelope value, not a fresh one.
    const advanced = env.process(0.8 * Math.sin((2 * Math.PI * 440 * 5000) / FS));
    expect(advanced).not.toBe(before); // process() DID advance
    expect(env.value()).toBe(advanced); // value() now mirrors the advanced state
  });

  it("reset() returns the follower to zero state", () => {
    const env = new EnvelopeFollower(FS, 5, 50);
    sineBlock(env, 1, 300, 2000);
    env.reset();
    expect(env.process(0)).toBe(0);
  });

  it("is deterministic across a reset", () => {
    const env = new EnvelopeFollower(FS, 5, 50);
    const run = (): number[] => {
      const out: number[] = [];
      for (let n = 0; n < 500; n++) out.push(env.process(Math.sin((2 * Math.PI * 220 * n) / FS)));
      return out;
    };
    const first = run();
    env.reset();
    const second = run();
    expect(second).toEqual(first);
  });
});

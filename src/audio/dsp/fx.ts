// The fixed FX tail that runs after every engine: drive -> chorus -> delay ->
// reverb. Pure and per-sample so it can run inside an AudioWorklet and be tested
// under Node with Vitest. No Web Audio nodes, no framework, no allocation on the
// hot path: every delay line is sized once in the constructor for a worst-case
// delay and thereafter indexed with wrapping read/write pointers.
//
// A brickwall limiter deliberately does NOT live here — it sits later in the
// Web Audio graph. This module only guards against runaway/NaN so it can never
// feed the limiter (or the DAC) a non-finite sample.

import type { FxParams } from '../contracts';

// --- small guarded helpers ---------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// Replace non-finite samples with 0. WHY: a single NaN in a feedback line poisons
// the whole buffer forever, so we scrub at every write into a recirculating path
// and at the final output.
function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

// Linear-interpolated read from a circular buffer, `delay` samples behind the
// write head. WHY linear (not just nearest): the chorus sweeps a *fractional*
// delay; snapping to integer samples would zipper the pitch and add aliasing.
function readFrac(buf: Float32Array, writeIdx: number, delay: number): number {
  const size = buf.length;
  // Position of the read head measured back from the last written sample.
  let read = writeIdx - 1 - delay;
  // Bring into [0, size) without a modulo of a possibly-negative float.
  read = read - Math.floor(read / size) * size;
  const i0 = Math.floor(read);
  const frac = read - i0;
  const i1 = i0 + 1 >= size ? 0 : i0 + 1;
  return buf[i0] * (1 - frac) + buf[i1] * frac;
}

// Flush subnormals to zero in recirculating state. On x86 without FTZ, feedback
// paths decaying into denormal floats cost 10-100× per operation — enough to
// starve the audio thread once input goes silent with reverb/delay running.
// 1e-15 is around -300 dBFS, far below anything audible.
function flushDenormal(x: number): number {
  return x > -1e-15 && x < 1e-15 ? 0 : x;
}

// --- reverb building blocks (Freeverb) ---------------------------------------

// Lowpass-damped comb filter. `filterStore` is the one-pole lowpass state that
// makes high frequencies decay faster than lows — the core of Freeverb's natural
// sound. feedback == room size; damp == HF absorption.
class Comb {
  private readonly buf: Float32Array;
  private idx = 0;
  private filterStore = 0;
  feedback = 0.7;
  damp = 0.2;

  constructor(size: number) {
    this.buf = new Float32Array(Math.max(1, size));
  }

  process(input: number): number {
    const out = this.buf[this.idx];
    // One-pole lowpass in the feedback path.
    this.filterStore = flushDenormal(out * (1 - this.damp) + this.filterStore * this.damp);
    // Scrub before it recirculates so a transient overflow can't persist.
    this.buf[this.idx] = flushDenormal(finite(input + this.filterStore * this.feedback));
    this.idx = this.idx + 1 >= this.buf.length ? 0 : this.idx + 1;
    return out;
  }

  reset(): void {
    this.buf.fill(0);
    this.idx = 0;
    this.filterStore = 0;
  }
}

// Schroeder allpass — diffuses the comb output so it reads as dense reverb rather
// than a set of discrete echoes. Fixed feedback of 0.5 is the classic value.
class Allpass {
  private readonly buf: Float32Array;
  private idx = 0;
  private static readonly FEEDBACK = 0.5;

  constructor(size: number) {
    this.buf = new Float32Array(Math.max(1, size));
  }

  process(input: number): number {
    const bufout = this.buf[this.idx];
    const out = -input + bufout;
    this.buf[this.idx] = flushDenormal(finite(input + bufout * Allpass.FEEDBACK));
    this.idx = this.idx + 1 >= this.buf.length ? 0 : this.idx + 1;
    return out;
  }

  reset(): void {
    this.buf.fill(0);
    this.idx = 0;
  }
}

// Classic Freeverb tunings are given in samples at 44.1 kHz. We scale them to the
// actual sample rate so the room "size" (modal density) is rate-independent. The
// right channel is offset by `STEREO_SPREAD` so the two channels decorrelate,
// which is what gives Freeverb its stereo image. We use 4 combs + 2 allpasses per
// channel (a lighter subset of Freeverb's 8+4) — enough for a dense, stable tail
// at a fraction of the cost per sample.
const COMB_TUNING = [1116, 1277, 1422, 1557];
const ALLPASS_TUNING = [556, 341];
const STEREO_SPREAD = 23;
const FREEVERB_REF_SR = 44100;
// Fixed input gain matching Freeverb; keeps the summed comb bank from clipping.
const REVERB_FIXED_GAIN = 0.015;

// --- FX chain ----------------------------------------------------------------

export class FxChain {
  private readonly sampleRate: number;

  // drive
  private drive = 0;

  // chorus: 3 modulated delay lines, per stereo channel.
  private readonly chorusBufL: Float32Array;
  private readonly chorusBufR: Float32Array;
  private chorusWrite = 0;
  private readonly chorusPhase = [0, 0, 0];
  // Slightly detuned LFO rates (Hz) so the three voices never phase-lock into a
  // single audible sweep.
  private static readonly CHORUS_RATE = [0.63, 0.47, 0.71];
  // Center delays (ms) spread across the 7–25 ms chorus range.
  private static readonly CHORUS_BASE_MS = [9, 15, 22];
  private chorus = 0;

  // delay: stereo ping-pong feedback line.
  private readonly delayBufL: Float32Array;
  private readonly delayBufR: Float32Array;
  private delayWrite = 0;
  private delaySamples = 1;
  private delayFeedback = 0;
  private delayMix = 0;
  private readonly maxDelaySamples: number;

  // reverb
  private readonly combsL: Comb[];
  private readonly combsR: Comb[];
  private readonly allpassL: Allpass[];
  private readonly allpassR: Allpass[];
  private reverbWet = 0;

  constructor(sampleRate: number) {
    // Guard the rate itself so every derived buffer size is sane.
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const sr = this.sampleRate;
    const scale = sr / FREEVERB_REF_SR;

    // Chorus needs room for base(25ms) + depth(~7ms) plus interpolation slack.
    const chorusSize = Math.ceil(0.05 * sr) + 4;
    this.chorusBufL = new Float32Array(chorusSize);
    this.chorusBufR = new Float32Array(chorusSize);

    // Max supported delay = 2 s (well above the 1.5 s param ceiling and the
    // slowest 40 bpm quarter note of 1.5 s). +2 for the read-behind guard.
    this.maxDelaySamples = Math.ceil(2 * sr);
    this.delayBufL = new Float32Array(this.maxDelaySamples + 2);
    this.delayBufR = new Float32Array(this.maxDelaySamples + 2);

    // Rate-scaled reverb tunings; right channel offset for stereo decorrelation.
    this.combsL = COMB_TUNING.map((t) => new Comb(Math.round(t * scale)));
    this.combsR = COMB_TUNING.map((t) => new Comb(Math.round((t + STEREO_SPREAD) * scale)));
    this.allpassL = ALLPASS_TUNING.map((t) => new Allpass(Math.round(t * scale)));
    this.allpassR = ALLPASS_TUNING.map((t) => new Allpass(Math.round((t + STEREO_SPREAD) * scale)));
  }

  setParams(fx: FxParams, bpm: number): void {
    this.drive = clamp(fx.drive, 0, 1);
    this.chorus = clamp(fx.chorus, 0, 1);

    // Delay time: when synced, one quarter note = 60/bpm seconds. bpm is clamped
    // to a musical 40..300 so a bogus tempo can't ask for a >2 s or ~0 s delay.
    let delaySec: number;
    if (fx.delaySync) {
      const safeBpm = clamp(bpm, 40, 300);
      delaySec = 60 / safeBpm;
    } else {
      delaySec = clamp(fx.delayTime, 0, 2);
    }
    // At least 1 sample so a "0 s" delay can't read the sample being written.
    this.delaySamples = clamp(Math.round(delaySec * this.sampleRate), 1, this.maxDelaySamples);
    // Params already arrive sanitized (feedback <= 0.95) but re-clamp defensively:
    // feedback strictly < 1 keeps the recirculating loop bounded.
    this.delayFeedback = clamp(fx.delayFeedback, 0, 0.95);
    this.delayMix = clamp(fx.delayMix, 0, 1);

    // Reverb: one control drives both wet mix and room size. Room size maps to
    // comb feedback in [0.70, 0.98] — kept strictly < 1 so the impulse response
    // is bounded and always decays. Damping eases up a touch as size grows so
    // large rooms keep some air.
    const rv = clamp(fx.reverb, 0, 1);
    this.reverbWet = rv;
    const feedback = 0.7 + rv * 0.28;
    const damp = 0.25 - rv * 0.1;
    for (const c of this.combsL) {
      c.feedback = feedback;
      c.damp = damp;
    }
    for (const c of this.combsR) {
      c.feedback = feedback;
      c.damp = damp;
    }
  }

  process(inL: number, inR: number): [number, number] {
    // Scrub inputs up front: a NaN from an upstream engine must not propagate.
    let l = finite(inL);
    let r = finite(inR);

    // --- 1. drive ------------------------------------------------------------
    // tanh soft clip. Pre-gain rises with the control so more drive = more
    // saturation; tanh caps the peak so makeup can be a fixed gentle lift. At
    // drive == 0 the shaped branch is fully cross-faded out, giving bit-exact
    // dry passthrough (pre-gain 1, weight 0).
    if (this.drive > 0) {
      const preGain = 1 + this.drive * 6;
      const makeup = 1 + this.drive * 0.4;
      l = l * (1 - this.drive) + Math.tanh(l * preGain) * this.drive * makeup;
      r = r * (1 - this.drive) + Math.tanh(r * preGain) * this.drive * makeup;
    }

    // --- 2. chorus -----------------------------------------------------------
    // Three fractional delay taps modulated by detuned LFOs. The right channel
    // reads each tap a quarter LFO-cycle out of phase from the left, which widens
    // the image. `chorus` sets both modulation depth and wet mix, so at 0 the wet
    // branch is cross-faded out entirely (exact dry passthrough).
    this.chorusBufL[this.chorusWrite] = l;
    this.chorusBufR[this.chorusWrite] = r;
    if (this.chorus > 0) {
      const depthSamp = this.chorus * 0.007 * this.sampleRate; // up to ~7 ms sweep
      let wetL = 0;
      let wetR = 0;
      for (let i = 0; i < 3; i++) {
        const baseSamp = (FxChain.CHORUS_BASE_MS[i] / 1000) * this.sampleRate;
        const phase = this.chorusPhase[i];
        const modL = baseSamp + depthSamp * Math.sin(2 * Math.PI * phase);
        const modR = baseSamp + depthSamp * Math.sin(2 * Math.PI * (phase + 0.25));
        wetL += readFrac(this.chorusBufL, this.chorusWrite, modL);
        wetR += readFrac(this.chorusBufR, this.chorusWrite, modR);
        // Advance and wrap the LFO phase for next sample.
        let next = phase + FxChain.CHORUS_RATE[i] / this.sampleRate;
        if (next >= 1) next -= 1;
        this.chorusPhase[i] = next;
      }
      // Average the 3 voices so mix doesn't triple the level, then cross-fade.
      wetL /= 3;
      wetR /= 3;
      l = l * (1 - this.chorus) + wetL * this.chorus;
      r = r * (1 - this.chorus) + wetR * this.chorus;
    }
    this.chorusWrite = this.chorusWrite + 1 >= this.chorusBufL.length ? 0 : this.chorusWrite + 1;

    // --- 3. delay (ping-pong) ------------------------------------------------
    // Read the delayed taps, then write input + *cross-channel* feedback so echoes
    // bounce L<->R. delayMix == 0 gives exact dry passthrough. Feedback < 1 and a
    // ±4 write clamp keep the loop from running away even under pathological input.
    const dl = readFrac(this.delayBufL, this.delayWrite, this.delaySamples);
    const dr = readFrac(this.delayBufR, this.delayWrite, this.delaySamples);
    this.delayBufL[this.delayWrite] = flushDenormal(clamp(l + dr * this.delayFeedback, -4, 4));
    this.delayBufR[this.delayWrite] = flushDenormal(clamp(r + dl * this.delayFeedback, -4, 4));
    this.delayWrite = this.delayWrite + 1 >= this.delayBufL.length ? 0 : this.delayWrite + 1;
    l = l * (1 - this.delayMix) + dl * this.delayMix;
    r = r * (1 - this.delayMix) + dr * this.delayMix;

    // --- 4. reverb (Freeverb) ------------------------------------------------
    // reverbWet == 0 gives exact dry passthrough. The comb bank sums in parallel;
    // the allpasses are chained in series to diffuse it.
    if (this.reverbWet > 0) {
      const inMono = (l + r) * REVERB_FIXED_GAIN;
      let revL = 0;
      let revR = 0;
      for (let i = 0; i < this.combsL.length; i++) {
        revL += this.combsL[i].process(inMono);
        revR += this.combsR[i].process(inMono);
      }
      for (let i = 0; i < this.allpassL.length; i++) {
        revL = this.allpassL[i].process(revL);
        revR = this.allpassR[i].process(revR);
      }
      l = l * (1 - this.reverbWet) + revL * this.reverbWet;
      r = r * (1 - this.reverbWet) + revR * this.reverbWet;
    }

    return [finite(l), finite(r)];
  }

  reset(): void {
    this.chorusBufL.fill(0);
    this.chorusBufR.fill(0);
    this.chorusWrite = 0;
    this.chorusPhase[0] = 0;
    this.chorusPhase[1] = 0;
    this.chorusPhase[2] = 0;

    this.delayBufL.fill(0);
    this.delayBufR.fill(0);
    this.delayWrite = 0;

    for (const c of this.combsL) c.reset();
    for (const c of this.combsR) c.reset();
    for (const a of this.allpassL) a.reset();
    for (const a of this.allpassR) a.reset();
  }
}

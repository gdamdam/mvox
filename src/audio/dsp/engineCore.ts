// The heart of mvox: a pure, Node-testable DSP orchestrator that turns a voice
// input block into the chosen engine's output. Owns the pitch tracker, carrier
// synth, vocoder filter banks, pitch shifters, formant resonators and the FX
// tail. The worklet is a thin shell around this; the UI never sees it.
//
// process() is called once per render quantum with a mono voice block and writes
// a stereo output block, returning telemetry (levels, detected pitch, voices).

import {
  DEFAULT_PATCH,
  type EngineMode,
  type MvoxPatch,
} from '../contracts'
import { Biquad, bandpassCoeffs, highShelfCoeffs, highpassCoeffs, lowpassCoeffs } from './biquad'
import { CarrierSynth } from './carrier'
import { EnvelopeFollower, vocoderBandFrequencies, vocoderBandQ } from './vocoder'
import { FxChain } from './fx'
import { PitchShifter } from './pitchShifter'
import { PitchTracker } from './pitch'
import { diatonicHarmony, hzToMidi, midiToHz, snapMidiToScale } from './scale'
import {
  degreeOffsetHz,
  resolveTuning,
  snapHzToTuning,
  TUNING_MAX_DEGREES,
  type SnapResult,
} from './microtuning'

export interface EngineTelemetry {
  inputLevel: number
  outputPeak: number
  f0: number
  confidence: number
  activeVoices: number
  inputClip: boolean
  targetHz: number
}

const MAX_BANDS = 32
const HARMONY_VOICES = 4

// FORMANT resonator center frequencies (Hz), scaled at runtime by shift+size.
// Module-level so processFormant allocates nothing on the render hot path.
const FORMANT_BASES = [650, 1080, 2650]

// HARMONY formant preservation. A pitch shifter drags formants along with the
// pitch, so an up-shifted voice sounds "chipmunky" (bright) and a down-shifted
// one "muddy". We approximate keeping formants in place with a high-shelf tilt on
// each shifted voice: darken up-shifts, brighten down-shifts, proportional to the
// shift (in octaves) times the formantPreserve knob. This is an honest v1 — a
// broad spectral tilt, not spectrally-exact formant transfer — matching the
// granular shifter's own "good v1" character.
const HARMONY_FORMANT_SHELF_HZ = 1500
const HARMONY_FORMANT_TILT_DB = 9 // shelf dB per octave of shift at preserve = 1

// FOLLOW degree-retarget hysteresis (cents), for the custom-tuning path. A sung
// pitch hovering on the midpoint between two tuning degrees would otherwise flip
// the glide target back and forth every sample; only re-snap when the new degree
// is decisively closer (beats the current target by this margin). Width scales
// with tracking.hysteresis: base + hysteresis * extra. The base keeps a little
// damping even at hysteresis 0; the range stays far below the finest musical step
// (a 24-EDO quarter-tone is 50 cents) so degrees remain reachable.
const FOLLOW_RETARGET_HYST_BASE_CENTS = 4
const FOLLOW_RETARGET_HYST_EXTRA_CENTS = 8

// Rounded-note (12-TET) re-snap dead-band, in semitones, for the legacy FOLLOW
// path and HARMONY. A sung pitch sitting on a note boundary rounds first one way
// then the other, chattering the snapped target between neighbours. We only
// re-commit once the pitch has moved past the boundary (0.5 semitone) by an extra
// margin that grows with tracking.hysteresis. Neutral at the boundary itself, so
// steady held notes are unaffected.
const NOTE_HYST_BASE_SEMITONES = 0.5
const NOTE_HYST_EXTRA_SEMITONES = 0.35

// PolyBLEP residual correction around discontinuities (t in [0,1), dt = phase
// inc). Mirrors CarrierSynth's anti-aliasing so FOLLOW's saw/pulse don't alias.
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

interface Band {
  analysis: Biquad
  synth: Biquad
  follower: EnvelopeFollower
}

export class MvoxEngineCore {
  private patch: MvoxPatch = DEFAULT_PATCH
  private live = false
  private demo: Float32Array = new Float32Array(1)
  private demoPos = 0
  private bpm = 120

  // Mode-switch crossfade: keep rendering the OLD mode while fading its output to
  // silence, swap the DSP state at the zero point, then fade the NEW mode back
  // in — so changing engines is a smooth transition, not an instant click.
  private renderMode: EngineMode = DEFAULT_PATCH.mode
  private fadeGain = 1
  private fadeDir = 0 // -1 = fading out to the swap, +1 = fading in, 0 = steady
  private readonly fadeStep: number

  private readonly carrier: CarrierSynth
  // Not readonly: setPatch reconstructs the tracker when the min/max Hz search
  // bounds change (a user gesture, so the allocation is off the render path).
  private pitch: PitchTracker
  private readonly fx: FxChain

  // Input conditioning. gateFollower tracks the (post-gain) voice envelope so the
  // noise gate can decide open/closed; gateGain is the smoothed gate scalar the
  // block is multiplied by. Constructed once (allocation-free render path).
  private readonly gateFollower: EnvelopeFollower
  private gateGain = 1

  // One-pole smoother state for the detected f0 (tracking.smoothing). Reset to 0
  // on unvoiced frames so a held note is never dragged by a stale value.
  private smoothedF0 = 0

  // Pitch-tracker search bounds last applied; used to guard the reconstruct.
  private trackMinHz = 70
  private trackMaxHz = 1000

  // The note the active engine is snapping/gliding to, Hz (0 = none). Reported in
  // telemetry as targetHz; set during per-mode processing.
  private engineTargetHz = 0

  // VOCODER: MAX_BANDS bandpass pairs (analysis on voice, synth on carrier).
  private readonly bands: Band[] = []
  private activeBands = 0
  private readonly sibilanceHp: Biquad
  private readonly bassLp: Biquad
  // Carrier tone low-pass (patch.vocoder.tone). Bypassed entirely at tone >= 1
  // (the default) so the vocoder output is bit-identical to before; coeffs are
  // recomputed only when tone changes (cached below), never per sample.
  private readonly carrierToneLp: Biquad
  private toneLast = Number.NaN
  // Bass boost is gated by the VOICE (modulator) low band, not the carrier alone:
  // the carrier runs continuously from held notes, so an un-gated bass term
  // droned during silence. bassVoiceLp isolates the voice's low band and
  // bassVoiceFollower tracks its envelope; the boost is scaled by that envelope
  // so silent input -> no bass. Constructed once (allocation-free render path).
  private readonly bassVoiceLp: Biquad
  private readonly bassVoiceFollower: EnvelopeFollower

  // HARMONY: one pitch shifter per possible voice, plus a per-voice high-shelf for
  // formant-preserve tilt. harmonyShelfDb caches each shelf's last applied tilt
  // (quantized) so we redesign coeffs only when the shift or the knob moves, not
  // per sample. harmonyL/R carry the stereo-spread output of processHarmony back
  // to process() without allocating on the render hot path.
  private readonly harmonyShifters: PitchShifter[] = []
  private readonly harmonyShelves: Biquad[] = []
  private readonly harmonyShelfDb: number[] = []
  private harmonyL = 0
  private harmonyR = 0
  // Per-voice CURRENT pitch-shift (semitones), glided toward the target when
  // harmony.response < 1. NaN = "seed to the next target instantly" (first block
  // after a voice activates or after a reset). At response >= 1 it always tracks
  // the target exactly, so the shift — and GOLDEN_HARMONY — is unchanged.
  private readonly harmonyShiftCurrent: number[] = []
  private harmonyResponseInstant = true
  private harmonyResponseCoeff = 1
  // Committed rounded input MIDI for the legacy 12-TET HARMONY re-snap dead-band
  // (see NOTE_HYST_*). NaN = ungated/uninitialised (commit the first snap).
  private harmonyLastRawMidi = Number.NaN

  // FORMANT: three resonators + a robot/formant shifter + ring-mod phase.
  private readonly formantRes: Biquad[] = []
  private readonly robotShifter: PitchShifter
  private ringPhase = 0
  private noiseState = 22222
  // Last-seen formant controls; the resonator biquads hold their coeffs, so we
  // recompute (and allocate) only when shift/size actually move, not per sample.
  private formantLastShift = Number.NaN
  private formantLastSize = Number.NaN

  // FOLLOW: single glided oscillator frequency + its own carrier for the synth.
  private followHz = 0
  private followTargetHz = 0
  private followGate = false
  // Last rounded input MIDI while gated (LEGACY 12-TET path only); re-snapping
  // only when this changes keeps scale.ts's array-allocating snap off the
  // per-sample path yet tracks the melody.
  private followLastRawMidi = Number.NaN
  // Last committed tuning degree/octave while gated (CUSTOM-TUNING path). Rounded
  // MIDI cannot gate custom tunings: a fine tuning (e.g. 24-EDO) crosses a degree
  // WITHOUT changing rounded 12-TET MIDI, so those degrees would be unreachable.
  // We cache the RESOLVED degree/octave instead and re-target when it changes.
  // -1 = ungated / uninitialised (commit the first snap immediately).
  private followLastDegree = -1
  private followLastOctave = 0
  private readonly followSynth: CarrierSynth

  // MICROTUNING: the active tuning resolved from patch.shared.tuning + keyRoot.
  // tuningCustom === false means "12-TET, snapped by scaleMode" — the legacy
  // path in processHarmony/processFollow, kept byte-identical. Resolved once per
  // change in setPatch (never per block); the cents live in a preallocated buffer
  // and snaps write into snapScratch so the render loop allocates nothing.
  private tuningCustom = false
  private tuningTonicHz = 0
  private tuningPeriodCents = 1200
  private tuningCount = 0
  private readonly tuningCents = new Float32Array(TUNING_MAX_DEGREES)
  private tuningSig = ''
  private readonly snapScratch: SnapResult = { degree: 0, octave: 0, hz: 0 }

  // Notes currently held from keyboard/MIDI (carrier pitch source).
  private heldNotes: number[] = []
  // Sorted (lowest-first) snapshot of heldNotes, rebuilt only on note on/off/panic
  // (user gestures — allocation OK there), never per render sample. Used as the
  // harmony voice targets when harmony.keyboardHarmony is on.
  private heldSorted: number[] = []

  // Reusable voice-block scratch: process() runs on the audio thread, where a
  // per-quantum allocation means GC churn and eventual dropouts. Re-allocated
  // only if the quantum size changes (it doesn't in practice).
  private voiceScratch = new Float32Array(0)

  constructor(private readonly sampleRate: number) {
    // ~8 ms per fade leg: fast enough to feel instant, slow enough to de-click.
    this.fadeStep = 1 / Math.max(1, Math.round(0.008 * sampleRate))
    this.renderMode = this.patch.mode
    this.carrier = new CarrierSynth(sampleRate)
    this.followSynth = new CarrierSynth(sampleRate)
    // frameSize 2048 is required to reach minHz=70: the YIN window is half the
    // frame, so a 1024 frame floors detection at ~94 Hz (48k) and never tracks
    // low male fundamentals (E2/F2). hopSize stays at 512 so a longer analysis
    // window does not slow the estimate cadence (~11 ms) that FOLLOW/HARMONY need.
    this.pitch = new PitchTracker(sampleRate, {
      minHz: this.trackMinHz,
      maxHz: this.trackMaxHz,
      frameSize: 2048,
      hopSize: 512,
    })
    this.fx = new FxChain(sampleRate)
    // Fast attack / moderate release so the gate opens promptly on voiced onsets
    // and its detector doesn't chatter on the decay; the gate's own release time
    // (how slowly the gain closes) is driven separately by gateRelease.
    this.gateFollower = new EnvelopeFollower(sampleRate, 5, 50)

    for (let i = 0; i < MAX_BANDS; i += 1) {
      this.bands.push({
        analysis: new Biquad(),
        synth: new Biquad(),
        follower: new EnvelopeFollower(sampleRate, 3, 40),
      })
    }
    this.sibilanceHp = new Biquad()
    this.sibilanceHp.setCoeffs(highpassCoeffs(sampleRate, 5000, 0.7))
    this.bassLp = new Biquad()
    this.bassLp.setCoeffs(lowpassCoeffs(sampleRate, 200, 0.7))
    this.carrierToneLp = new Biquad()
    this.bassVoiceLp = new Biquad()
    this.bassVoiceLp.setCoeffs(lowpassCoeffs(sampleRate, 200, 0.7))
    // Fast attack / moderate release like the per-band followers, so the bass
    // reinforcement snaps in on voiced onsets and doesn't zipper on decay.
    this.bassVoiceFollower = new EnvelopeFollower(sampleRate, 3, 60)

    for (let i = 0; i < HARMONY_VOICES; i += 1) {
      this.harmonyShifters.push(new PitchShifter(sampleRate))
      this.harmonyShelves.push(new Biquad())
      this.harmonyShelfDb.push(Number.NaN)
      this.harmonyShiftCurrent.push(Number.NaN)
    }
    for (let i = 0; i < 3; i += 1) this.formantRes.push(new Biquad())
    this.robotShifter = new PitchShifter(sampleRate)

    this.configureBands(this.patch.vocoder.bands, this.patch.vocoder.release, this.patch.vocoder.attack)
  }

  setPatch(patch: MvoxPatch): void {
    const bandsChanged =
      patch.vocoder.bands !== this.patch.vocoder.bands ||
      patch.vocoder.release !== this.patch.vocoder.release ||
      patch.vocoder.attack !== this.patch.vocoder.attack
    const modeChanged = patch.mode !== this.patch.mode
    this.patch = patch
    this.resolveTuningState(patch)
    // Reconstruct the pitch tracker only when the search bounds actually move
    // (never per block). new PitchTracker allocates its scratch buffers, which is
    // fine here — setPatch is a user gesture, off the render hot path. frameSize
    // stays 2048/hopSize 512; the tracker's constructor grows the frame further
    // if a low minHz needs it (so low fundamentals stay reachable).
    if (patch.tracking.minHz !== this.trackMinHz || patch.tracking.maxHz !== this.trackMaxHz) {
      this.trackMinHz = patch.tracking.minHz
      this.trackMaxHz = patch.tracking.maxHz
      this.pitch = new PitchTracker(this.sampleRate, {
        minHz: this.trackMinHz,
        maxHz: this.trackMaxHz,
        frameSize: 2048,
        hopSize: 512,
      })
    }
    this.carrier.setWave(patch.vocoder.carrierWave)
    // Carrier-only shaping (the VOCODER carrier; FOLLOW renders via followOsc, not
    // this synth). Defaults (octave 0, unison 1, detune 0, pw 0.5) leave the
    // carrier render bit-identical, so GOLDEN_VOCODER is unchanged.
    this.carrier.setTranspose(patch.vocoder.carrierOctave * 12)
    this.carrier.setUnison(patch.vocoder.unison, patch.vocoder.unisonDetune)
    this.carrier.setPulseWidth(patch.vocoder.pulseWidth)
    // Harmony pitch-shift glide response. response >= 1 (default) snaps the shift
    // instantly (GOLDEN_HARMONY unchanged); lower values glide via a one-pole
    // whose coefficient is computed here (a user gesture), never per sample.
    if (patch.harmony.response >= 1) {
      this.harmonyResponseInstant = true
    } else {
      this.harmonyResponseInstant = false
      // response 0 → ~200 ms time constant; approaching 1 → near-instant.
      const tau = (1 - patch.harmony.response) * 0.2
      this.harmonyResponseCoeff = 1 - Math.exp(-1 / (Math.max(0.0001, tau) * this.sampleRate))
    }
    this.followSynth.setWave(patch.follow.wave)
    this.fx.setParams(patch.fx, this.bpm)
    if (bandsChanged) this.configureBands(patch.vocoder.bands, patch.vocoder.release, patch.vocoder.attack)
    // Carrier tone low-pass: recompute coeffs only when the knob moves, and only
    // while it is engaged (tone < 1). At tone >= 1 the filter is bypassed in
    // processVocoder, so we leave its coeffs alone (no work, output unchanged).
    if (patch.vocoder.tone !== this.toneLast) {
      this.toneLast = patch.vocoder.tone
      if (patch.vocoder.tone < 1) {
        // Map tone 0..1 exponentially to ~200 Hz (dark) .. ~18 kHz (open).
        const cutoff = 200 * Math.pow(18000 / 200, patch.vocoder.tone)
        this.carrierToneLp.setCoeffs(lowpassCoeffs(this.sampleRate, cutoff, 0.7))
      }
    }
    // Entering a mode must not resume from another visit's stale ring buffers /
    // envelopes — that reads as a click or brief warble on the first block. Rather
    // than reset instantly (an audible jump), start a fade-out; process() swaps the
    // DSP state at silence and fades the new mode in. renderMode keeps rendering the
    // outgoing engine until the swap, and picks up this.patch.mode when it lands, so
    // rapid switching always settles on the latest selection.
    if (modeChanged && patch.mode !== this.renderMode) this.fadeDir = -1
  }

  // Resolve patch.shared.tuning + keyRoot into engine-ready form. Cheap change
  // signature so we re-validate/copy only when the scale, period, or root moves —
  // this runs on setPatch (a user gesture), never on the render hot path.
  private resolveTuningState(patch: MvoxPatch): void {
    const t = patch.shared.tuning
    // Defense in depth at the worklet boundary: a missing/garbage tuning object
    // falls back to the legacy 12-TET path rather than throwing on the setter.
    if (!t || !Array.isArray(t.scaleCents)) {
      this.tuningSig = 'legacy'
      this.tuningCustom = false
      return
    }
    const sig = `${patch.shared.keyRoot}|${t.period}|${t.scaleCents.join(',')}`
    if (sig === this.tuningSig) return
    this.tuningSig = sig
    const resolved = resolveTuning(t.scaleCents, t.period, patch.shared.keyRoot)
    this.tuningCustom = resolved.custom
    if (resolved.custom) {
      this.tuningTonicHz = resolved.tonicHz
      this.tuningPeriodCents = resolved.periodCents
      this.tuningCount = Math.min(resolved.count, TUNING_MAX_DEGREES)
      for (let i = 0; i < this.tuningCount; i += 1) this.tuningCents[i] = resolved.cents[i]
    }
  }

  setTempo(bpm: number): void {
    this.bpm = Number.isFinite(bpm) ? Math.max(40, Math.min(300, bpm)) : 120
    this.fx.setParams(this.patch.fx, this.bpm)
  }

  setLiveInput(live: boolean): void {
    this.live = live
  }

  setVoiceSample(channel: Float32Array): void {
    this.demo = channel.length > 0 ? channel : new Float32Array(1)
    this.demoPos = 0
  }

  noteOn(midi: number, velocity: number): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)))
    this.carrier.noteOn(m, velocity)
    if (!this.heldNotes.includes(m)) this.heldNotes.push(m)
    this.rebuildHeldSorted()
  }

  noteOff(midi: number): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)))
    this.carrier.noteOff(m)
    this.heldNotes = this.heldNotes.filter((n) => n !== m)
    this.rebuildHeldSorted()
  }

  panic(): void {
    this.carrier.panic()
    this.followSynth.panic()
    this.heldNotes = []
    this.heldSorted = []
  }

  // Rebuild the lowest-first held-note snapshot for keyboard-harmony targeting.
  // Runs only on note on/off (user gestures), so the allocation is off the render
  // hot path; the per-sample loop just indexes the finished array.
  private rebuildHeldSorted(): void {
    this.heldSorted = this.heldNotes.slice().sort((a, b) => a - b)
  }

  reset(): void {
    this.panic()
    this.pitch.reset()
    this.fx.reset()
    this.gateFollower.reset()
    this.gateGain = 1
    this.smoothedF0 = 0
    this.engineTargetHz = 0
    this.resetModeState()
    this.demoPos = 0
  }

  /** Clear all per-mode DSP state (filters, shifter ring buffers, follow glide). */
  private resetModeState(): void {
    for (const b of this.bands) {
      b.analysis.reset()
      b.synth.reset()
      b.follower.reset()
    }
    this.bassVoiceLp.reset()
    this.bassVoiceFollower.reset()
    for (const s of this.harmonyShifters) s.reset()
    for (const s of this.harmonyShelves) s.reset()
    // NaN forces each harmony formant shelf to recompute on the next block.
    for (let i = 0; i < this.harmonyShelfDb.length; i += 1) this.harmonyShelfDb[i] = Number.NaN
    this.robotShifter.reset()
    for (const r of this.formantRes) r.reset()
    this.harmonyLastRawMidi = Number.NaN
    // NaN seeds each harmony shift to its target instantly on the next block, so
    // re-entering HARMONY doesn't glide from a stale pre-reset shift.
    for (let i = 0; i < this.harmonyShiftCurrent.length; i += 1) this.harmonyShiftCurrent[i] = Number.NaN
    this.ringPhase = 0
    // NaN forces the formant resonator coeffs to recompute on the next block.
    this.formantLastShift = Number.NaN
    this.formantLastSize = Number.NaN
    // Clear FOLLOW glide/gate state so switching modes doesn't leave the voice
    // count stuck +1 or glide the next note from a stale pre-reset pitch.
    this.followHz = 0
    this.followTargetHz = 0
    this.followGate = false
    this.followLastRawMidi = Number.NaN
    this.followLastDegree = -1
    this.followLastOctave = 0
    this.followOscPhase = 0
  }

  private configureBands(count: number, release: number, attackMs: number): void {
    const n = Math.max(8, Math.min(MAX_BANDS, Math.round(count)))
    this.activeBands = n
    const freqs = vocoderBandFrequencies(n)
    const q = vocoderBandQ(freqs[Math.floor(n / 2)] ?? 1000, n)
    const releaseMs = 15 + release * 220 // knob 0..1 → 15..235 ms
    for (let i = 0; i < n; i += 1) {
      const coeffs = bandpassCoeffs(this.sampleRate, freqs[i], q)
      this.bands[i].analysis.setCoeffs(coeffs)
      this.bands[i].synth.setCoeffs(coeffs)
      // Attack default is 3 ms → identical coeffs to the previous fixed literal.
      this.bands[i].follower.setTimes(attackMs, releaseMs)
    }
  }

  private nextVoiceSample(): number {
    if (this.live) return 0 // filled from input block in process()
    const s = this.demo[this.demoPos] ?? 0
    this.demoPos += 1
    if (this.demoPos >= this.demo.length) this.demoPos = 0
    return s
  }

  private noise(): number {
    let x = this.noiseState | 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.noiseState = x
    return x / 0x7fffffff
  }

  /**
   * Render one block. `input` is the live mono voice (used when live=true);
   * otherwise the demo loop is the voice. Writes stereo out, returns telemetry.
   */
  process(input: Float32Array, outL: Float32Array, outR: Float32Array): EngineTelemetry {
    const n = outL.length

    // Assemble the voice block (live input or demo loop), then condition it:
    // apply input gain, measure level/clip on the post-gain signal, and run the
    // noise gate. The conditioned voice is what BOTH pitch analysis and the
    // engines (and the dry monitor mix) see, so they all agree on one signal.
    if (this.voiceScratch.length !== n) this.voiceScratch = new Float32Array(n)
    const voice = this.voiceScratch
    const inputGain = this.patch.shared.inputGain
    const gateThreshold = this.patch.shared.gateThreshold
    const gateOn = gateThreshold > 0
    // Gate-close (release) time from the knob, mapped to ~20..800 ms; gate-open
    // (attack) is fixed-fast so onsets aren't clipped. One-pole coeffs recomputed
    // once per block (a couple of Math.exp — cheap, off the per-sample path).
    const releaseMs = 20 + this.patch.shared.gateRelease * 780
    const gateReleaseCoeff = Math.exp(-1 / ((releaseMs / 1000) * this.sampleRate))
    const gateAttackCoeff = Math.exp(-1 / ((0.005 * this.sampleRate)))
    let sumSq = 0
    let clip = false
    for (let i = 0; i < n; i += 1) {
      const raw = this.live ? input[i] ?? 0 : this.nextVoiceSample()
      let v = Number.isFinite(raw) ? raw * inputGain : 0
      sumSq += v * v
      if (Math.abs(v) >= 1) clip = true
      if (gateOn) {
        const env = this.gateFollower.process(v)
        const target = env >= gateThreshold ? 1 : 0
        const coeff = target > this.gateGain ? gateAttackCoeff : gateReleaseCoeff
        this.gateGain = target + coeff * (this.gateGain - target)
        v *= this.gateGain
      } else {
        // Gate off: fully open, and keep the gain reset so re-enabling starts open
        // (no zipper from a stale closed value). Path is bit-identical bar the gain.
        this.gateGain = 1
      }
      voice[i] = v
    }
    const inputLevel = Math.min(1, Math.sqrt(sumSq / n) * 4)
    const inputClip = clip
    const pitchResult = this.pitch.process(voice)

    // One-pole smooth the detected f0 (tracking.smoothing). smoothing 0 -> alpha 1
    // -> passthrough (current behavior); higher smoothing -> more lag. Smoothing
    // runs only while voiced and resets when unvoiced, so a held note is never
    // dragged by a stale value across a voiced/unvoiced transition. Confidence is
    // passed through untouched.
    let f0 = pitchResult.f0
    if (f0 > 0) {
      const alpha = 1 - 0.98 * this.patch.tracking.smoothing
      if (this.smoothedF0 <= 0) this.smoothedF0 = f0
      this.smoothedF0 += alpha * (f0 - this.smoothedF0)
      f0 = this.smoothedF0
    } else {
      this.smoothedF0 = 0
    }
    const confidence = pitchResult.confidence

    let peak = 0
    for (let i = 0; i < n; i += 1) {
      // Engines are mono except HARMONY, which pans its voices into a stereo pair.
      let monoL = 0
      let monoR = 0
      switch (this.renderMode) {
        case 'vocoder':
          monoL = monoR = this.processVocoder(voice[i])
          this.engineTargetHz = 0
          break
        case 'harmony':
          this.processHarmony(voice[i], f0, confidence)
          monoL = this.harmonyL
          monoR = this.harmonyR
          break
        case 'formant':
          monoL = monoR = this.processFormant(voice[i], f0, confidence)
          this.engineTargetHz = 0
          break
        case 'follow':
          monoL = monoR = this.processFollow(voice[i], f0, confidence)
          break
      }
      // Mode-switch crossfade envelope, applied to the engine voice (not the FX
      // tail, which is left to ring across the swap for a smoother transition).
      monoL *= this.fadeGain
      monoR *= this.fadeGain
      if (this.fadeDir < 0) {
        this.fadeGain -= this.fadeStep
        if (this.fadeGain <= 0) {
          this.fadeGain = 0
          this.resetModeState()
          this.renderMode = this.patch.mode
          this.fadeDir = 1
        }
      } else if (this.fadeDir > 0) {
        this.fadeGain += this.fadeStep
        if (this.fadeGain >= 1) {
          this.fadeGain = 1
          this.fadeDir = 0
        }
      }
      // Optional dry-voice monitor mix (off by default).
      const monitor = voice[i] * this.patch.shared.monitorMix
      monoL += monitor
      monoR += monitor

      this.fx.process(monoL, monoR)
      const gain = this.patch.shared.masterGain
      const outLv = Number.isFinite(this.fx.outL) ? this.fx.outL * gain : 0
      const outRv = Number.isFinite(this.fx.outR) ? this.fx.outR * gain : 0
      outL[i] = outLv
      outR[i] = outRv
      const a = Math.max(Math.abs(outLv), Math.abs(outRv))
      if (a > peak) peak = a
    }

    return {
      inputLevel,
      outputPeak: Math.min(1, peak),
      f0,
      confidence,
      activeVoices: this.carrier.activeCount() + (this.followGate ? 1 : 0),
      inputClip,
      targetHz: this.engineTargetHz,
    }
  }

  // --- VOCODER --------------------------------------------------------------
  private processVocoder(voiceSample: number): number {
    let carrier = this.carrier.process()
    // Carrier tone: darken the carrier before the bands. Bypassed at tone >= 1
    // (default) so the signal path — and output — is bit-identical to before.
    if (this.patch.vocoder.tone < 1) {
      carrier = this.carrierToneLp.process(carrier)
    }
    // Freeze: hold each band's last envelope instead of following the modulator,
    // so the pad sustains as the voice changes/goes silent. Default false → the
    // per-sample follow below is unchanged.
    const freeze = this.patch.vocoder.freeze
    let out = 0
    for (let i = 0; i < this.activeBands; i += 1) {
      const b = this.bands[i]
      const bandIn = b.analysis.process(voiceSample)
      const env = freeze ? b.follower.value() : b.follower.process(bandIn)
      out += b.synth.process(carrier) * env
    }
    out *= 1.6 // makeup for per-band envelope attenuation
    // Bass boost: reinforce low carrier energy so vocoded output isn't thin — but
    // gate it by the voice's low-band envelope so a held note doesn't drone
    // through silence. Envelope tracked every sample (constructed once, no alloc)
    // so it stays warm; the 4x makeup keeps useful low-frequency weight since the
    // voice-band envelope is small relative to the raw carrier level.
    const bassVoiceEnv = this.bassVoiceFollower.process(this.bassVoiceLp.process(voiceSample))
    if (this.patch.vocoder.bassBoost > 0) {
      out += this.bassLp.process(carrier) * this.patch.vocoder.bassBoost * 0.6 * bassVoiceEnv * 4
    }
    // Sibilance/unvoiced passthrough: high-frequency voice noise added directly
    // so consonants ("s", "t") survive — the classic vocoder intelligibility fix.
    if (this.patch.vocoder.sibilance > 0) {
      out += this.sibilanceHp.process(voiceSample) * this.patch.vocoder.sibilance
    }
    out *= this.patch.vocoder.carrierMix
    return out
  }

  // --- HARMONY --------------------------------------------------------------
  // Writes a stereo pair into harmonyL/harmonyR. The dry voice stays centered;
  // each harmony voice is pitch-shifted, formant-tilted (formantPreserve), then
  // panned across the field by `spread`.
  private processHarmony(voiceSample: number, f0: number, confidence: number): void {
    const {
      voiceCount,
      intervals,
      level,
      dryLevel,
      spread,
      detune,
      formantPreserve,
      voiceEnabled,
      voiceLevel,
      voicePan,
      voiceDetune,
    } = this.patch.harmony
    // Dry lead scaled by dryLevel (default 1 → unchanged); harmony voices layered
    // on top when pitch is sure.
    let outL = voiceSample * dryLevel
    let outR = voiceSample * dryLevel
    const voiced = confidence > 0.4 && f0 > 0
    const root = this.patch.shared.keyRoot
    const mode = this.patch.shared.scaleMode
    const baseMidi = voiced ? hzToMidi(f0) : 0
    // Note-boundary dead-band for the legacy 12-TET path: hold the committed
    // rounded MIDI and only re-commit once the pitch moves past the boundary by
    // the hysteresis margin, so a pitch hovering on a boundary doesn't chatter the
    // harmony between two notes. At steady state the committed value equals
    // Math.round(baseMidi), so the shift — and the output — is unchanged.
    let snapBaseMidi = baseMidi
    if (voiced && !this.tuningCustom) {
      const rawMidi = Math.round(baseMidi)
      if (Number.isNaN(this.harmonyLastRawMidi)) {
        this.harmonyLastRawMidi = rawMidi
      } else if (rawMidi !== this.harmonyLastRawMidi) {
        const deadband =
          NOTE_HYST_BASE_SEMITONES + this.patch.tracking.hysteresis * NOTE_HYST_EXTRA_SEMITONES
        if (Math.abs(baseMidi - this.harmonyLastRawMidi) > deadband) this.harmonyLastRawMidi = rawMidi
      }
      snapBaseMidi = this.harmonyLastRawMidi
    } else if (!voiced) {
      this.harmonyLastRawMidi = Number.NaN
    }
    // Custom tuning: snap the detected pitch to a scale degree once; each harmony
    // voice is a degree offset from it. The legacy 12-TET path stays in the MIDI
    // domain (diatonicHarmony) so its shift — and thus its output — is unchanged.
    if (voiced && this.tuningCustom) {
      snapHzToTuning(f0, this.tuningTonicHz, this.tuningCents, this.tuningCount, this.tuningPeriodCents, this.snapScratch)
    }
    // Report the base note HARMONY is harmonizing from (0 when unvoiced).
    this.engineTargetHz = !voiced
      ? 0
      : this.tuningCustom
        ? this.snapScratch.hz
        : midiToHz(snapMidiToScale(snapBaseMidi, root, mode))
    // Held-keyboard harmony: when on, each active voice targets a held keyboard
    // note (lowest-first) instead of an interval/degree offset. Active voice count
    // is additionally capped by how many notes are held. Off (default) → the
    // interval/degree path below runs unchanged (GOLDEN_HARMONY preserved).
    const keyboardHarmony = this.patch.harmony.keyboardHarmony
    const heldSorted = this.heldSorted
    const heldCount = heldSorted.length
    for (let v = 0; v < HARMONY_VOICES; v += 1) {
      const shifter = this.harmonyShifters[v]
      const active =
        v < voiceCount && voiced && voiceEnabled[v] && (!keyboardHarmony || v < heldCount)
      if (active) {
        // Per-voice detune OFFSET (default 0 → the global-only value, unchanged).
        const detuneSemis = (detune / 100) * (v % 2 === 0 ? 1 : -1) + voiceDetune[v] / 100
        let shiftSemis: number
        if (keyboardHarmony) {
          // Chromatic shift onto the held note — correct for any tuning, since the
          // sung pitch and the target are both real MIDI pitches.
          shiftSemis = heldSorted[v] - baseMidi + detuneSemis
        } else if (this.tuningCustom) {
          const targetHz = degreeOffsetHz(
            this.snapScratch.degree,
            this.snapScratch.octave,
            intervals[v],
            this.tuningTonicHz,
            this.tuningCents,
            this.tuningCount,
            this.tuningPeriodCents,
          )
          shiftSemis = 12 * Math.log2(targetHz / f0) + detuneSemis
        } else {
          const targetMidi = diatonicHarmony(snapBaseMidi, root, mode, intervals[v])
          shiftSemis = targetMidi - baseMidi + detuneSemis
        }
        // Response glide toward the target shift. At response >= 1 (default) or when
        // seeding (NaN) the current snaps to the target instantly, so the shift —
        // and GOLDEN_HARMONY — is unchanged; otherwise one-pole toward it.
        let cur = this.harmonyShiftCurrent[v]
        if (this.harmonyResponseInstant || Number.isNaN(cur)) {
          cur = shiftSemis
        } else {
          cur += (shiftSemis - cur) * this.harmonyResponseCoeff
        }
        this.harmonyShiftCurrent[v] = cur
        shifter.setSemitones(cur)
        let s = shifter.process(voiceSample)

        // Formant preserve: high-shelf tilt opposing the shift. Recompute the
        // shelf only when the (quantized) tilt actually moves so cos/sin/sqrt stay
        // off the per-sample path. At preserve == 0 the shelf is bypassed, so the
        // output is bit-identical to the plain granular shifter (old behavior).
        if (formantPreserve > 0) {
          const oct = Math.max(-2, Math.min(2, cur / 12))
          const tiltDb = Math.round(-oct * formantPreserve * HARMONY_FORMANT_TILT_DB * 2) / 2
          if (tiltDb !== this.harmonyShelfDb[v]) {
            this.harmonyShelves[v].setCoeffs(
              highShelfCoeffs(this.sampleRate, HARMONY_FORMANT_SHELF_HZ, tiltDb),
            )
            this.harmonyShelfDb[v] = tiltDb
          }
          s = this.harmonyShelves[v].process(s)
        }

        // Per-voice level multiplier (default 1 → unchanged).
        s *= level * voiceLevel[v]
        // Equal-spacing pan across [-spread, +spread]; single voice sits center.
        // Unity-center linear balance: pan == 0 leaves L == R (so spread == 0 is
        // exactly the old mono behavior) and no gain ever exceeds 1 (no clipping).
        // voicePan is an OFFSET (default 0 → unchanged); the clamp only bites when
        // the offset pushes the result out of [-1, 1], leaving in-range values as-is.
        const panPos = voiceCount > 1 ? (v / (voiceCount - 1)) * 2 - 1 : 0
        const pan = Math.max(-1, Math.min(1, spread * panPos + voicePan[v]))
        outL += s * (1 - Math.max(0, pan))
        outR += s * (1 - Math.max(0, -pan))
      } else {
        // Keep the buffer moving so re-enabling doesn't glitch, but output silence.
        shifter.process(voiceSample)
        // Sync the inactive voice's current to "reseed" so re-enabling snaps to the
        // fresh target instead of gliding up from a stale shift.
        this.harmonyShiftCurrent[v] = Number.NaN
      }
    }
    this.harmonyL = outL
    this.harmonyR = outR
  }

  // --- FORMANT --------------------------------------------------------------
  private processFormant(voiceSample: number, f0: number, confidence: number): number {
    const p = this.patch.formant
    let sample = voiceSample

    // Robot: flatten pitch to the last held note (or a fixed A2) using the shifter.
    if (p.robot > 0) {
      const targetMidi = this.heldNotes.length > 0 ? this.heldNotes[this.heldNotes.length - 1] : 45
      const targetHz = midiToHz(targetMidi)
      if (confidence > 0.4 && f0 > 0) {
        this.robotShifter.setRatio(targetHz / f0)
      }
      const flat = this.robotShifter.process(voiceSample)
      sample = sample * (1 - p.robot) + flat * p.robot
    } else {
      this.robotShifter.process(voiceSample) // keep buffer coherent
    }

    // Whisper: replace voiced excitation with noise shaped by the voice envelope.
    if (p.whisper > 0) {
      const env = Math.abs(sample)
      const whispered = this.noise() * env * 2
      sample = sample * (1 - p.whisper) + whispered * p.whisper
    }

    // Formant/size: three peaking resonators whose centers move with shift+size,
    // imposing a movable vowel colour (an honest v1 formant shaping — see README).
    // Redesign the resonators only when the vowel controls move — cos/sin and the
    // coeff allocation would otherwise run 3x per sample on the render hot path.
    if (p.shift !== this.formantLastShift || p.size !== this.formantLastSize) {
      const shiftRatio = Math.pow(2, p.shift / 12) * p.size
      for (let i = 0; i < 3; i += 1) {
        const fc = Math.max(80, Math.min(this.sampleRate * 0.45, FORMANT_BASES[i] * shiftRatio))
        this.formantRes[i].setCoeffs(bandpassCoeffs(this.sampleRate, fc, 4))
      }
      this.formantLastShift = p.shift
      this.formantLastSize = p.size
    }
    let res = 0
    for (let i = 0; i < 3; i += 1) {
      res += this.formantRes[i].process(sample)
    }
    const formantAmt = Math.min(1, Math.abs(p.shift) / 12 + Math.abs(p.size - 1))
    sample = sample * (1 - formantAmt) + res * 0.8 * formantAmt

    // Ring mod.
    if (p.ringAmount > 0 && p.ringHz > 0) {
      this.ringPhase += p.ringHz / this.sampleRate
      if (this.ringPhase >= 1) this.ringPhase -= 1
      const ring = sample * Math.sin(2 * Math.PI * this.ringPhase)
      sample = sample * (1 - p.ringAmount) + ring * p.ringAmount
    }
    return sample
  }

  /** Current FOLLOW glide target in Hz (0 when ungated). Exposed read-only so
   *  regression tests can verify tuning-degree retargeting without having to
   *  recover the target by measuring the synth's output pitch. */
  get followTargetHzForTest(): number {
    return this.followTargetHz
  }

  /** Per-voice current harmony pitch-shift in semitones. Exposed read-only so the
   *  response-glide and keyboard-harmony tests can assert the shift targets
   *  without recovering them from the shifted audio. */
  get harmonyShiftForTest(): readonly number[] {
    return this.harmonyShiftCurrent
  }

  // --- FOLLOW ---------------------------------------------------------------
  private processFollow(voiceSample: number, f0: number, confidence: number): number {
    const p = this.patch.follow
    const gateOpen = confidence >= p.confidenceGate && f0 > 0
    if (gateOpen) {
      // Track the sung pitch continuously so a legato line follows the melody
      // instead of sticking on its first note. Snap the target to the nearest
      // scale tone (shared key/scale) for musical output; the glide smooths the
      // step. Re-snap only when the rounded input pitch changes so scale.ts's
      // array-allocating helpers stay off the per-sample render hot path.
      const midi = hzToMidi(f0)
      if (this.tuningCustom) {
        // Degree-indexed snap to the active tuning. snapHzToTuning writes the
        // caller-owned scratch and allocates nothing, so running it per gated
        // sample keeps the render path allocation-free. Re-target only when the
        // RESOLVED degree/octave changes (not the rounded MIDI, which is blind to
        // sub-semitone degrees), with cents-domain hysteresis so a pitch sitting
        // on a degree boundary doesn't chatter between neighbours.
        const snap = snapHzToTuning(
          f0,
          this.tuningTonicHz,
          this.tuningCents,
          this.tuningCount,
          this.tuningPeriodCents,
          this.snapScratch,
        )
        if (this.followLastDegree < 0) {
          // Gate just opened: commit the first snap immediately.
          this.followTargetHz = snap.hz
          this.followLastDegree = snap.degree
          this.followLastOctave = snap.octave
        } else if (snap.degree !== this.followLastDegree || snap.octave !== this.followLastOctave) {
          const centsFromTonic = 1200 * Math.log2(f0 / this.tuningTonicHz)
          const newCents = this.tuningCents[snap.degree] + this.tuningPeriodCents * snap.octave
          const curCents =
            this.tuningCents[this.followLastDegree] + this.tuningPeriodCents * this.followLastOctave
          // snapHzToTuning already returns the nearest degree, so only switch when
          // the new degree beats the current one by more than the hysteresis margin
          // (width scaled by tracking.hysteresis).
          const hystCents =
            FOLLOW_RETARGET_HYST_BASE_CENTS +
            this.patch.tracking.hysteresis * FOLLOW_RETARGET_HYST_EXTRA_CENTS
          if (
            Math.abs(centsFromTonic - newCents) <
            Math.abs(centsFromTonic - curCents) - hystCents
          ) {
            this.followTargetHz = snap.hz
            this.followLastDegree = snap.degree
            this.followLastOctave = snap.octave
          }
        }
      } else {
        // Legacy 12-TET path: rounded MIDI IS the resolution, so gate on it and
        // keep scale.ts's array-allocating snap off the per-sample render path.
        // A note-boundary dead-band (scaled by tracking.hysteresis) resists
        // re-snapping until the pitch moves decisively past the boundary, so a
        // pitch hovering there doesn't chatter the glide target. The first snap
        // after the gate opens (followLastRawMidi === NaN) commits immediately.
        const rawMidi = Math.round(midi)
        let commit = Number.isNaN(this.followLastRawMidi)
        if (!commit && rawMidi !== this.followLastRawMidi) {
          const deadband =
            NOTE_HYST_BASE_SEMITONES + this.patch.tracking.hysteresis * NOTE_HYST_EXTRA_SEMITONES
          commit = Math.abs(midi - this.followLastRawMidi) > deadband
        }
        if (commit) {
          const snapped = snapMidiToScale(
            midi,
            this.patch.shared.keyRoot,
            this.patch.shared.scaleMode,
          )
          this.followTargetHz = midiToHz(snapped)
          this.followLastRawMidi = rawMidi
        }
      }
      this.followGate = true
    } else if (this.followGate) {
      this.followGate = false
      this.followLastRawMidi = Number.NaN
      this.followLastDegree = -1
      this.followLastOctave = 0
    }

    // Portamento glide toward the target pitch (time constant from glide knob).
    const glideCoeff = 1 - Math.exp(-1 / (Math.max(0.001, p.glide * 0.15) * this.sampleRate))
    if (this.followTargetHz > 0) {
      if (this.followHz <= 0) this.followHz = this.followTargetHz
      this.followHz += (this.followTargetHz - this.followHz) * glideCoeff
    }

    // Report the note the glide is heading toward (current follow target).
    this.engineTargetHz = this.followTargetHz

    // Drive the follow synth via a single sustained voice at the glided pitch.
    // We synthesise directly here (a simple saw) for tight pitch control.
    const synth = this.followGate ? this.followOsc(this.followHz) : 0
    return synth * p.blend + voiceSample * (1 - p.blend)
  }

  private followOscPhase = 0
  private followOsc(hz: number): number {
    if (hz <= 0) return 0
    const dt = hz / this.sampleRate
    this.followOscPhase += dt
    if (this.followOscPhase >= 1) this.followOscPhase -= 1
    const t = this.followOscPhase
    // Honor the selected follow waveform (patch.follow.wave), polyBLEP-corrected
    // so high notes don't alias — same scheme as CarrierSynth's oscillators.
    switch (this.patch.follow.wave) {
      case 'pulse': {
        let s = t < 0.5 ? 1 : -1
        s += polyBlep(t, dt)
        s -= polyBlep((t + 0.5) % 1, dt)
        return s * 0.5
      }
      case 'noise':
        return this.noise() * 0.5
      case 'saw':
      default: {
        let s = 2 * t - 1
        s -= polyBlep(t, dt)
        return s * 0.5
      }
    }
  }
}

export function isEngineMode(v: unknown): v is EngineMode {
  return v === 'vocoder' || v === 'harmony' || v === 'formant' || v === 'follow'
}

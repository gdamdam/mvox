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
  private readonly pitch: PitchTracker
  private readonly fx: FxChain

  // VOCODER: MAX_BANDS bandpass pairs (analysis on voice, synth on carrier).
  private readonly bands: Band[] = []
  private activeBands = 0
  private readonly sibilanceHp: Biquad
  private readonly bassLp: Biquad

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
  // Last rounded input MIDI while gated; re-snapping only when this changes keeps
  // scale.ts's array-allocating snap off the per-sample path yet tracks the melody.
  private followLastRawMidi = Number.NaN
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
    this.pitch = new PitchTracker(sampleRate, { minHz: 70, maxHz: 1000, frameSize: 2048, hopSize: 512 })
    this.fx = new FxChain(sampleRate)

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

    for (let i = 0; i < HARMONY_VOICES; i += 1) {
      this.harmonyShifters.push(new PitchShifter(sampleRate))
      this.harmonyShelves.push(new Biquad())
      this.harmonyShelfDb.push(Number.NaN)
    }
    for (let i = 0; i < 3; i += 1) this.formantRes.push(new Biquad())
    this.robotShifter = new PitchShifter(sampleRate)

    this.configureBands(this.patch.vocoder.bands, this.patch.vocoder.release)
  }

  setPatch(patch: MvoxPatch): void {
    const bandsChanged =
      patch.vocoder.bands !== this.patch.vocoder.bands ||
      patch.vocoder.release !== this.patch.vocoder.release
    const modeChanged = patch.mode !== this.patch.mode
    this.patch = patch
    this.resolveTuningState(patch)
    this.carrier.setWave(patch.vocoder.carrierWave)
    this.followSynth.setWave(patch.follow.wave)
    this.fx.setParams(patch.fx, this.bpm)
    if (bandsChanged) this.configureBands(patch.vocoder.bands, patch.vocoder.release)
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
  }

  noteOff(midi: number): void {
    const m = Math.max(0, Math.min(127, Math.round(midi)))
    this.carrier.noteOff(m)
    this.heldNotes = this.heldNotes.filter((n) => n !== m)
  }

  panic(): void {
    this.carrier.panic()
    this.followSynth.panic()
    this.heldNotes = []
  }

  reset(): void {
    this.panic()
    this.pitch.reset()
    this.fx.reset()
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
    for (const s of this.harmonyShifters) s.reset()
    for (const s of this.harmonyShelves) s.reset()
    // NaN forces each harmony formant shelf to recompute on the next block.
    for (let i = 0; i < this.harmonyShelfDb.length; i += 1) this.harmonyShelfDb[i] = Number.NaN
    this.robotShifter.reset()
    for (const r of this.formantRes) r.reset()
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
    this.followOscPhase = 0
  }

  private configureBands(count: number, release: number): void {
    const n = Math.max(8, Math.min(MAX_BANDS, Math.round(count)))
    this.activeBands = n
    const freqs = vocoderBandFrequencies(n)
    const q = vocoderBandQ(freqs[Math.floor(n / 2)] ?? 1000, n)
    const releaseMs = 15 + release * 220 // knob 0..1 → 15..235 ms
    for (let i = 0; i < n; i += 1) {
      const coeffs = bandpassCoeffs(this.sampleRate, freqs[i], q)
      this.bands[i].analysis.setCoeffs(coeffs)
      this.bands[i].synth.setCoeffs(coeffs)
      this.bands[i].follower.setTimes(3, releaseMs)
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

    // Assemble the voice block (live input or demo loop) + track pitch + level.
    if (this.voiceScratch.length !== n) this.voiceScratch = new Float32Array(n)
    const voice = this.voiceScratch
    let sumSq = 0
    for (let i = 0; i < n; i += 1) {
      const v = this.live ? input[i] ?? 0 : this.nextVoiceSample()
      voice[i] = Number.isFinite(v) ? v : 0
      sumSq += voice[i] * voice[i]
    }
    const inputLevel = Math.min(1, Math.sqrt(sumSq / n) * 4)
    const pitchResult = this.pitch.process(voice)

    let peak = 0
    for (let i = 0; i < n; i += 1) {
      // Engines are mono except HARMONY, which pans its voices into a stereo pair.
      let monoL = 0
      let monoR = 0
      switch (this.renderMode) {
        case 'vocoder':
          monoL = monoR = this.processVocoder(voice[i])
          break
        case 'harmony':
          this.processHarmony(voice[i], pitchResult.f0, pitchResult.confidence)
          monoL = this.harmonyL
          monoR = this.harmonyR
          break
        case 'formant':
          monoL = monoR = this.processFormant(voice[i], pitchResult.f0, pitchResult.confidence)
          break
        case 'follow':
          monoL = monoR = this.processFollow(voice[i], pitchResult.f0, pitchResult.confidence)
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
      f0: pitchResult.f0,
      confidence: pitchResult.confidence,
      activeVoices: this.carrier.activeCount() + (this.followGate ? 1 : 0),
    }
  }

  // --- VOCODER --------------------------------------------------------------
  private processVocoder(voiceSample: number): number {
    const carrier = this.carrier.process()
    let out = 0
    for (let i = 0; i < this.activeBands; i += 1) {
      const b = this.bands[i]
      const env = b.follower.process(b.analysis.process(voiceSample))
      out += b.synth.process(carrier) * env
    }
    out *= 1.6 // makeup for per-band envelope attenuation
    // Bass boost: reinforce low carrier energy so vocoded output isn't thin.
    if (this.patch.vocoder.bassBoost > 0) {
      out += this.bassLp.process(carrier) * this.patch.vocoder.bassBoost * 0.6
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
    const { voiceCount, intervals, level, spread, detune, formantPreserve } = this.patch.harmony
    // Dry voice always present; harmony voices layered on top when pitch is sure.
    let outL = voiceSample
    let outR = voiceSample
    const voiced = confidence > 0.4 && f0 > 0
    const root = this.patch.shared.keyRoot
    const mode = this.patch.shared.scaleMode
    const baseMidi = voiced ? hzToMidi(f0) : 0
    // Custom tuning: snap the detected pitch to a scale degree once; each harmony
    // voice is a degree offset from it. The legacy 12-TET path stays in the MIDI
    // domain (diatonicHarmony) so its shift — and thus its output — is unchanged.
    if (voiced && this.tuningCustom) {
      snapHzToTuning(f0, this.tuningTonicHz, this.tuningCents, this.tuningCount, this.tuningPeriodCents, this.snapScratch)
    }
    for (let v = 0; v < HARMONY_VOICES; v += 1) {
      const shifter = this.harmonyShifters[v]
      if (v < voiceCount && voiced) {
        const detuneSemis = (detune / 100) * (v % 2 === 0 ? 1 : -1)
        let shiftSemis: number
        if (this.tuningCustom) {
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
          const targetMidi = diatonicHarmony(baseMidi, root, mode, intervals[v])
          shiftSemis = targetMidi - baseMidi + detuneSemis
        }
        shifter.setSemitones(shiftSemis)
        let s = shifter.process(voiceSample)

        // Formant preserve: high-shelf tilt opposing the shift. Recompute the
        // shelf only when the (quantized) tilt actually moves so cos/sin/sqrt stay
        // off the per-sample path. At preserve == 0 the shelf is bypassed, so the
        // output is bit-identical to the plain granular shifter (old behavior).
        if (formantPreserve > 0) {
          const oct = Math.max(-2, Math.min(2, shiftSemis / 12))
          const tiltDb = Math.round(-oct * formantPreserve * HARMONY_FORMANT_TILT_DB * 2) / 2
          if (tiltDb !== this.harmonyShelfDb[v]) {
            this.harmonyShelves[v].setCoeffs(
              highShelfCoeffs(this.sampleRate, HARMONY_FORMANT_SHELF_HZ, tiltDb),
            )
            this.harmonyShelfDb[v] = tiltDb
          }
          s = this.harmonyShelves[v].process(s)
        }

        s *= level
        // Equal-spacing pan across [-spread, +spread]; single voice sits center.
        // Unity-center linear balance: pan == 0 leaves L == R (so spread == 0 is
        // exactly the old mono behavior) and no gain ever exceeds 1 (no clipping).
        const panPos = voiceCount > 1 ? (v / (voiceCount - 1)) * 2 - 1 : 0
        const pan = spread * panPos
        outL += s * (1 - Math.max(0, pan))
        outR += s * (1 - Math.max(0, -pan))
      } else {
        // Keep the buffer moving so re-enabling doesn't glitch, but output silence.
        shifter.process(voiceSample)
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
      const rawMidi = Math.round(midi)
      if (rawMidi !== this.followLastRawMidi) {
        if (this.tuningCustom) {
          // Degree-indexed snap to the active tuning (allocation-free scratch).
          this.followTargetHz = snapHzToTuning(
            f0,
            this.tuningTonicHz,
            this.tuningCents,
            this.tuningCount,
            this.tuningPeriodCents,
            this.snapScratch,
          ).hz
        } else {
          const snapped = snapMidiToScale(
            midi,
            this.patch.shared.keyRoot,
            this.patch.shared.scaleMode,
          )
          this.followTargetHz = midiToHz(snapped)
        }
        this.followLastRawMidi = rawMidi
      }
      this.followGate = true
    } else if (this.followGate) {
      this.followGate = false
      this.followLastRawMidi = Number.NaN
    }

    // Portamento glide toward the target pitch (time constant from glide knob).
    const glideCoeff = 1 - Math.exp(-1 / (Math.max(0.001, p.glide * 0.15) * this.sampleRate))
    if (this.followTargetHz > 0) {
      if (this.followHz <= 0) this.followHz = this.followTargetHz
      this.followHz += (this.followTargetHz - this.followHz) * glideCoeff
    }

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

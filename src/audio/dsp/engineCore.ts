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
import { Biquad, bandpassCoeffs, highpassCoeffs, lowpassCoeffs } from './biquad'
import { CarrierSynth } from './carrier'
import { EnvelopeFollower, vocoderBandFrequencies, vocoderBandQ } from './vocoder'
import { FxChain } from './fx'
import { PitchShifter } from './pitchShifter'
import { PitchTracker } from './pitch'
import { diatonicHarmony, hzToMidi, midiToHz, snapMidiToScale } from './scale'

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

  private readonly carrier: CarrierSynth
  private readonly pitch: PitchTracker
  private readonly fx: FxChain

  // VOCODER: MAX_BANDS bandpass pairs (analysis on voice, synth on carrier).
  private readonly bands: Band[] = []
  private activeBands = 0
  private readonly sibilanceHp: Biquad
  private readonly bassLp: Biquad

  // HARMONY: one pitch shifter per possible voice.
  private readonly harmonyShifters: PitchShifter[] = []

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

  // Notes currently held from keyboard/MIDI (carrier pitch source).
  private heldNotes: number[] = []

  // Reusable voice-block scratch: process() runs on the audio thread, where a
  // per-quantum allocation means GC churn and eventual dropouts. Re-allocated
  // only if the quantum size changes (it doesn't in practice).
  private voiceScratch = new Float32Array(0)

  constructor(private readonly sampleRate: number) {
    this.carrier = new CarrierSynth(sampleRate)
    this.followSynth = new CarrierSynth(sampleRate)
    this.pitch = new PitchTracker(sampleRate, { minHz: 70, maxHz: 1000, frameSize: 1024 })
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
    this.carrier.setWave(patch.vocoder.carrierWave)
    this.followSynth.setWave(patch.follow.wave)
    this.fx.setParams(patch.fx, this.bpm)
    if (bandsChanged) this.configureBands(patch.vocoder.bands, patch.vocoder.release)
    // Entering a mode must not resume from another visit's stale ring buffers /
    // envelopes — that reads as a click or brief warble on the first block.
    if (modeChanged) this.resetModeState()
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
    const mode = this.patch.mode

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
      let mono = 0
      switch (mode) {
        case 'vocoder':
          mono = this.processVocoder(voice[i])
          break
        case 'harmony':
          mono = this.processHarmony(voice[i], pitchResult.f0, pitchResult.confidence)
          break
        case 'formant':
          mono = this.processFormant(voice[i], pitchResult.f0, pitchResult.confidence)
          break
        case 'follow':
          mono = this.processFollow(voice[i], pitchResult.f0, pitchResult.confidence)
          break
      }
      // Optional dry-voice monitor mix (off by default).
      mono += voice[i] * this.patch.shared.monitorMix

      this.fx.process(mono, mono)
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
  private processHarmony(voiceSample: number, f0: number, confidence: number): number {
    const { voiceCount, intervals, level, spread, detune } = this.patch.harmony
    // Dry voice always present; harmony voices layered on top when pitch is sure.
    let out = voiceSample
    const voiced = confidence > 0.4 && f0 > 0
    const root = this.patch.shared.keyRoot
    const mode = this.patch.shared.scaleMode
    const baseMidi = voiced ? hzToMidi(f0) : 0
    for (let v = 0; v < HARMONY_VOICES; v += 1) {
      const shifter = this.harmonyShifters[v]
      if (v < voiceCount && voiced) {
        const targetMidi = diatonicHarmony(baseMidi, root, mode, intervals[v])
        const detuneSemis = (detune / 100) * (v % 2 === 0 ? 1 : -1)
        shifter.setSemitones(targetMidi - baseMidi + detuneSemis)
        out += shifter.process(voiceSample) * level
      } else {
        // Keep the buffer moving so re-enabling doesn't glitch, but output silence.
        shifter.process(voiceSample)
      }
    }
    void spread // pan handled at block level would need stereo taps; mono-summed for v1
    return out
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
        const snapped = snapMidiToScale(
          midi,
          this.patch.shared.keyRoot,
          this.patch.shared.scaleMode,
        )
        this.followTargetHz = midiToHz(snapped)
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

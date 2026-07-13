// The single source of truth for mvox's patch schema, parameter ranges, factory
// defaults, and the typed message protocol shared by the UI thread and the audio
// worklet. Every untrusted boundary (IndexedDB, URL fragment, worklet messages)
// funnels through sanitizePatch() so no unvalidated data reaches the DSP core.

import type { Mode } from './dsp/scale'
import { TUNING_MAX_DEGREES, TUNING_MAX_PERIOD } from './dsp/microtuning'

export const ENGINE_MODES = ['vocoder', 'harmony', 'formant', 'follow'] as const
export type EngineMode = (typeof ENGINE_MODES)[number]

export const CARRIER_WAVES = ['saw', 'pulse', 'noise'] as const
export type CarrierWave = (typeof CARRIER_WAVES)[number]

// ---------------------------------------------------------------------------
// Parameter ranges — one entry per numeric parameter. Used both for clamping in
// sanitizePatch() and (later) for UI control bounds, so the two can never drift.
// ---------------------------------------------------------------------------

export interface Range {
  min: number
  max: number
  default: number
}

const R = (min: number, max: number, def: number): Range => ({ min, max, default: def })

export const RANGES = {
  // shared
  keyRoot: R(0, 11, 0),
  masterGain: R(0, 1.5, 0.9),
  monitorMix: R(0, 1, 0), // dry voice into output; 0 by default for feedback + privacy
  // vocoder
  vocoderBands: R(8, 32, 20),
  vocoderBassBoost: R(0, 1, 0.35),
  vocoderSibilance: R(0, 1, 0.4), // unvoiced/HF noise passthrough
  vocoderRelease: R(0, 1, 0.3),
  vocoderCarrierMix: R(0, 1, 1),
  // harmony
  harmonyVoiceCount: R(0, 4, 2),
  harmonyLevel: R(0, 1, 0.7),
  harmonySpread: R(0, 1, 0.5), // pan spread across voices
  harmonyDetune: R(0, 50, 8), // cents
  harmonyFormantPreserve: R(0, 1, 0.8),
  // formant
  formantShift: R(-12, 12, 0), // semitones of spectral-envelope shift
  formantSize: R(0.5, 2, 1), // gender/size
  formantRobot: R(0, 1, 0), // pitch flatten amount
  formantWhisper: R(0, 1, 0), // noise excitation
  formantRingHz: R(0, 800, 0),
  formantRingAmount: R(0, 1, 0),
  // follow
  followGlide: R(0, 1, 0.25),
  followBlend: R(0, 1, 1), // synth vs voice
  followConfidenceGate: R(0, 1, 0.5),
  // fx
  fxDrive: R(0, 1, 0),
  fxChorus: R(0, 1, 0.2),
  fxDelayTime: R(0, 1.5, 0.3), // seconds (when not synced)
  fxDelayFeedback: R(0, 0.95, 0.3),
  fxDelayMix: R(0, 1, 0.2),
  fxReverb: R(0, 1, 0.25),
  fxLimiterCeiling: R(-24, 0, -1), // dBFS
  // performance
  macro: R(0, 1, 0),
  xy: R(0, 1, 0.5),
} as const

export type ParamKey = keyof typeof RANGES

export function clamp(value: unknown, range: Range): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.default
  return value < range.min ? range.min : value > range.max ? range.max : value
}

function clampInt(value: unknown, range: Range): number {
  return Math.round(clamp(value, range))
}

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

// ---------------------------------------------------------------------------
// Patch shape
// ---------------------------------------------------------------------------

/**
 * A microtuning scale (vendored tuning-core shape). An EMPTY `scaleCents` is the
 * default and means "12-TET, snapped by the existing scaleMode" — the byte-
 * identical legacy path. A non-empty scale is degree-indexed: `scaleCents[0]` is
 * 0, entries ascend within one `period` (cents), and the tonic is derived from
 * `keyRoot` so switching the key transposes the tuning. Persisted in the patch,
 * so it crosses the same trust boundaries as every other field.
 */
export interface TuningSpec {
  name: string
  scaleCents: number[]
  period: number
}

export interface SharedParams {
  keyRoot: number
  scaleMode: Mode
  tuning: TuningSpec
  masterGain: number
  monitorMix: number
}

export interface VocoderParams {
  bands: number
  bassBoost: number
  sibilance: number
  release: number
  carrierWave: CarrierWave
  carrierMix: number
}

export interface HarmonyParams {
  voiceCount: number
  // degree offsets of the four possible harmony voices, in scale degrees
  intervals: [number, number, number, number]
  level: number
  spread: number
  detune: number
  formantPreserve: number
}

export interface FormantParams {
  shift: number
  size: number
  robot: number
  whisper: number
  ringHz: number
  ringAmount: number
}

export interface FollowParams {
  glide: number
  blend: number
  confidenceGate: number
  wave: CarrierWave
}

export interface FxParams {
  drive: number
  chorus: number
  delayTime: number
  delaySync: boolean
  delayFeedback: number
  delayMix: number
  reverb: number
  limiterCeiling: number
}

export interface PerfParams {
  macros: [number, number, number, number]
  xyX: number
  xyY: number
}

export interface MvoxPatch {
  version: number
  name: string
  mode: EngineMode
  shared: SharedParams
  vocoder: VocoderParams
  harmony: HarmonyParams
  formant: FormantParams
  follow: FollowParams
  fx: FxParams
  perf: Record<EngineMode, PerfParams>
}

export const PATCH_VERSION = 1

const defaultPerf = (): PerfParams => ({
  macros: [RANGES.macro.default, RANGES.macro.default, RANGES.macro.default, RANGES.macro.default],
  xyX: RANGES.xy.default,
  xyY: RANGES.xy.default,
})

export const DEFAULT_PATCH: MvoxPatch = Object.freeze({
  version: PATCH_VERSION,
  name: 'Init',
  mode: 'vocoder' as EngineMode,
  shared: {
    keyRoot: RANGES.keyRoot.default,
    scaleMode: 'major' as Mode,
    tuning: { name: 'Default', scaleCents: [] as number[], period: 1200 },
    masterGain: RANGES.masterGain.default,
    monitorMix: RANGES.monitorMix.default,
  },
  vocoder: {
    bands: RANGES.vocoderBands.default,
    bassBoost: RANGES.vocoderBassBoost.default,
    sibilance: RANGES.vocoderSibilance.default,
    release: RANGES.vocoderRelease.default,
    carrierWave: 'saw' as CarrierWave,
    carrierMix: RANGES.vocoderCarrierMix.default,
  },
  harmony: {
    voiceCount: RANGES.harmonyVoiceCount.default,
    intervals: [2, 4, -3, 7] as [number, number, number, number],
    level: RANGES.harmonyLevel.default,
    spread: RANGES.harmonySpread.default,
    detune: RANGES.harmonyDetune.default,
    formantPreserve: RANGES.harmonyFormantPreserve.default,
  },
  formant: {
    shift: RANGES.formantShift.default,
    size: RANGES.formantSize.default,
    robot: RANGES.formantRobot.default,
    whisper: RANGES.formantWhisper.default,
    ringHz: RANGES.formantRingHz.default,
    ringAmount: RANGES.formantRingAmount.default,
  },
  follow: {
    glide: RANGES.followGlide.default,
    blend: RANGES.followBlend.default,
    confidenceGate: RANGES.followConfidenceGate.default,
    wave: 'saw' as CarrierWave,
  },
  fx: {
    drive: RANGES.fxDrive.default,
    chorus: RANGES.fxChorus.default,
    delayTime: RANGES.fxDelayTime.default,
    delaySync: false,
    delayFeedback: RANGES.fxDelayFeedback.default,
    delayMix: RANGES.fxDelayMix.default,
    reverb: RANGES.fxReverb.default,
    limiterCeiling: RANGES.fxLimiterCeiling.default,
  },
  perf: {
    vocoder: defaultPerf(),
    harmony: defaultPerf(),
    formant: defaultPerf(),
    follow: defaultPerf(),
  },
})

// The scale modes accepted here mirror scale.ts MODES; kept as a literal list so
// sanitize doesn't need a runtime import of the (pure) scale module's array.
const SCALE_MODES: readonly Mode[] = [
  'major',
  'natural-minor',
  'dorian',
  'mixolydian',
  'phrygian',
  'lydian',
  'harmonic-minor',
  'chromatic',
]

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function sanitizePerf(raw: unknown): PerfParams {
  const r = isRecord(raw) ? raw : {}
  const macros = Array.isArray(r.macros) ? r.macros : []
  return {
    macros: [
      clamp(macros[0], RANGES.macro),
      clamp(macros[1], RANGES.macro),
      clamp(macros[2], RANGES.macro),
      clamp(macros[3], RANGES.macro),
    ],
    xyX: clamp(r.xyX, RANGES.xy),
    xyY: clamp(r.xyY, RANGES.xy),
  }
}

const DEFAULT_TUNING: TuningSpec = { name: 'Default', scaleCents: [], period: 1200 }

/**
 * Validate a stored/decoded/posted tuning. Never throws; any malformed table
 * (non-array, non-finite, not rooted at 0, non-ascending, over the length cap,
 * non-positive/too-large period, or a period not clearing the top degree) falls
 * back to the empty 12-TET default — so a corrupt link or session can never push
 * a bad scale into the worklet snap loop. Mirrors resolveTuning's guards; this is
 * the persistence-boundary half, resolveTuning the audio-boundary half.
 */
function sanitizeTuning(raw: unknown): TuningSpec {
  if (!isRecord(raw)) return { ...DEFAULT_TUNING }
  const cents = Array.isArray(raw.scaleCents) ? raw.scaleCents : []
  if (cents.length === 0) return { ...DEFAULT_TUNING }
  if (cents.length > TUNING_MAX_DEGREES) return { ...DEFAULT_TUNING }
  if (cents[0] !== 0) return { ...DEFAULT_TUNING }
  for (let i = 0; i < cents.length; i++) {
    const c = cents[i]
    if (typeof c !== 'number' || !Number.isFinite(c)) return { ...DEFAULT_TUNING }
    if (i > 0 && c <= cents[i - 1]) return { ...DEFAULT_TUNING }
  }
  const period = raw.period
  if (typeof period !== 'number' || !Number.isFinite(period) || period <= 0 || period > TUNING_MAX_PERIOD) {
    return { ...DEFAULT_TUNING }
  }
  if (cents[cents.length - 1] >= period) return { ...DEFAULT_TUNING }
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name.slice(0, 48) : 'Custom'
  return { name, scaleCents: cents.slice(), period }
}

function clampInterval(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  // Harmony intervals are scale degrees; keep within ±2 octaves of diatonic reach.
  return Math.max(-14, Math.min(14, Math.round(v)))
}

/**
 * Never throws. Accepts anything (parsed JSON from IndexedDB, a decoded share
 * link, a worklet message) and returns a fully-populated, in-range MvoxPatch,
 * falling back to DEFAULT_PATCH values field by field.
 */
export function sanitizePatch(raw: unknown): MvoxPatch {
  const r = isRecord(raw) ? raw : {}
  const d = DEFAULT_PATCH
  const shared = isRecord(r.shared) ? r.shared : {}
  const voc = isRecord(r.vocoder) ? r.vocoder : {}
  const har = isRecord(r.harmony) ? r.harmony : {}
  const fmt = isRecord(r.formant) ? r.formant : {}
  const fol = isRecord(r.follow) ? r.follow : {}
  const fx = isRecord(r.fx) ? r.fx : {}
  const perf = isRecord(r.perf) ? r.perf : {}
  const har2 = Array.isArray(har.intervals) ? har.intervals : []

  return {
    version: PATCH_VERSION,
    name: typeof r.name === 'string' ? r.name.slice(0, 48) : d.name,
    mode: coerceEnum(r.mode, ENGINE_MODES, d.mode),
    shared: {
      keyRoot: clampInt(shared.keyRoot, RANGES.keyRoot),
      scaleMode: coerceEnum(shared.scaleMode, SCALE_MODES, d.shared.scaleMode),
      tuning: sanitizeTuning(shared.tuning),
      masterGain: clamp(shared.masterGain, RANGES.masterGain),
      monitorMix: clamp(shared.monitorMix, RANGES.monitorMix),
    },
    vocoder: {
      bands: clampInt(voc.bands, RANGES.vocoderBands),
      bassBoost: clamp(voc.bassBoost, RANGES.vocoderBassBoost),
      sibilance: clamp(voc.sibilance, RANGES.vocoderSibilance),
      release: clamp(voc.release, RANGES.vocoderRelease),
      carrierWave: coerceEnum(voc.carrierWave, CARRIER_WAVES, d.vocoder.carrierWave),
      carrierMix: clamp(voc.carrierMix, RANGES.vocoderCarrierMix),
    },
    harmony: {
      voiceCount: clampInt(har.voiceCount, RANGES.harmonyVoiceCount),
      intervals: [
        clampInterval(har2[0], d.harmony.intervals[0]),
        clampInterval(har2[1], d.harmony.intervals[1]),
        clampInterval(har2[2], d.harmony.intervals[2]),
        clampInterval(har2[3], d.harmony.intervals[3]),
      ],
      level: clamp(har.level, RANGES.harmonyLevel),
      spread: clamp(har.spread, RANGES.harmonySpread),
      detune: clamp(har.detune, RANGES.harmonyDetune),
      formantPreserve: clamp(har.formantPreserve, RANGES.harmonyFormantPreserve),
    },
    formant: {
      shift: clamp(fmt.shift, RANGES.formantShift),
      size: clamp(fmt.size, RANGES.formantSize),
      robot: clamp(fmt.robot, RANGES.formantRobot),
      whisper: clamp(fmt.whisper, RANGES.formantWhisper),
      ringHz: clamp(fmt.ringHz, RANGES.formantRingHz),
      ringAmount: clamp(fmt.ringAmount, RANGES.formantRingAmount),
    },
    follow: {
      glide: clamp(fol.glide, RANGES.followGlide),
      blend: clamp(fol.blend, RANGES.followBlend),
      confidenceGate: clamp(fol.confidenceGate, RANGES.followConfidenceGate),
      wave: coerceEnum(fol.wave, CARRIER_WAVES, d.follow.wave),
    },
    fx: {
      drive: clamp(fx.drive, RANGES.fxDrive),
      chorus: clamp(fx.chorus, RANGES.fxChorus),
      delayTime: clamp(fx.delayTime, RANGES.fxDelayTime),
      delaySync: typeof fx.delaySync === 'boolean' ? fx.delaySync : d.fx.delaySync,
      delayFeedback: clamp(fx.delayFeedback, RANGES.fxDelayFeedback),
      delayMix: clamp(fx.delayMix, RANGES.fxDelayMix),
      reverb: clamp(fx.reverb, RANGES.fxReverb),
      limiterCeiling: clamp(fx.limiterCeiling, RANGES.fxLimiterCeiling),
    },
    perf: {
      vocoder: sanitizePerf(perf.vocoder),
      harmony: sanitizePerf(perf.harmony),
      formant: sanitizePerf(perf.formant),
      follow: sanitizePerf(perf.follow),
    },
  }
}

// ---------------------------------------------------------------------------
// Worklet message protocol — discriminated unions, imported by both sides.
// ---------------------------------------------------------------------------

export interface NoteMsg {
  midi: number
  velocity: number // 0..1
}

export type MainToWorkletMessage =
  | { type: 'set-patch'; patch: MvoxPatch }
  | { type: 'note-on'; note: NoteMsg }
  | { type: 'note-off'; midi: number }
  | { type: 'panic' }
  | { type: 'set-voice-sample'; channel: Float32Array } // demo voice fallback
  | { type: 'use-live-input'; live: boolean }
  | { type: 'set-tempo'; bpm: number }
  | { type: 'reset' }

export interface Telemetry {
  type: 'telemetry'
  inputLevel: number // 0..1 RMS of voice input
  outputPeak: number // 0..1
  f0: number // detected voice pitch, Hz (0 = unvoiced)
  confidence: number // 0..1
  activeVoices: number
}

export type WorkletToMainMessage = Telemetry

export const WORKLET_PROCESSOR_NAME = 'mvox-engine'

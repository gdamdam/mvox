import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, RANGES, sanitizePatch } from './contracts'

// These lock the backward-compatibility contract: a patch saved before Waves 2/5
// (no input/tracking/per-voice fields) must sanitize to BEHAVIOUR-PRESERVING
// defaults, so old presets and share links keep sounding the same.

describe('sanitizePatch — new-field defaults are behaviour-preserving', () => {
  const legacy = sanitizePatch({ mode: 'vocoder', vocoder: { bands: 20 }, harmony: { voiceCount: 2 } })

  it('input conditioning defaults are transparent', () => {
    expect(legacy.shared.inputGain).toBe(1) // unity
    expect(legacy.shared.gateThreshold).toBe(0) // gate off
  })

  it('tracking defaults match the wide range', () => {
    expect(legacy.tracking.rangePreset).toBe('all')
    expect(legacy.tracking.minHz).toBe(RANGES.trackMinHz.default)
    expect(legacy.tracking.maxHz).toBe(RANGES.trackMaxHz.default)
  })

  it('vocoder additions default to unchanged behaviour', () => {
    expect(legacy.vocoder.attack).toBe(3) // the previous fixed analysis attack
    expect(legacy.vocoder.tone).toBe(1) // filter open (bypassed)
    expect(legacy.vocoder.freeze).toBe(false)
    // Deep-DSP defaults are all no-ops on the carrier.
    expect(legacy.vocoder.carrierOctave).toBe(0)
    expect(legacy.vocoder.unison).toBe(1)
    expect(legacy.vocoder.unisonDetune).toBe(0)
    expect(legacy.vocoder.pulseWidth).toBe(0.5) // square
  })

  it('harmony additions default to unchanged behaviour', () => {
    expect(legacy.harmony.dryLevel).toBe(1)
    expect(legacy.harmony.response).toBe(1) // instant snap
    expect(legacy.harmony.keyboardHarmony).toBe(false)
    expect(legacy.harmony.voiceEnabled).toEqual([true, true, true, true])
    expect(legacy.harmony.voiceLevel).toEqual([1, 1, 1, 1])
    expect(legacy.harmony.voicePan).toEqual([0, 0, 0, 0])
    expect(legacy.harmony.voiceDetune).toEqual([0, 0, 0, 0])
  })
})

describe('sanitizePatch — new fields clamp + coerce', () => {
  it('clamps per-voice arrays and coerces enable flags', () => {
    const p = sanitizePatch({
      harmony: {
        voiceLevel: [5, -1, 0.5, 'x'],
        voicePan: [9, -9, 0, 0.3],
        voiceDetune: [999, -999, 10, 0],
        voiceEnabled: [false, 'yes', 0, true],
      },
    })
    expect(p.harmony.voiceLevel).toEqual([1, 0, 0.5, RANGES.harmonyVoiceLevel.default])
    expect(p.harmony.voicePan).toEqual([1, -1, 0, 0.3])
    expect(p.harmony.voiceDetune).toEqual([50, -50, 10, 0])
    // Non-boolean entries fall back to the default (true).
    expect(p.harmony.voiceEnabled).toEqual([false, true, true, true])
  })

  it('clamps vocoder attack/tone into range', () => {
    const p = sanitizePatch({ vocoder: { attack: 999, tone: 5 } })
    expect(p.vocoder.attack).toBe(RANGES.vocoderAttack.max)
    expect(p.vocoder.tone).toBe(1)
  })

  it('DEFAULT_PATCH is a fixed point of sanitize', () => {
    expect(sanitizePatch(DEFAULT_PATCH)).toEqual(DEFAULT_PATCH)
  })
})

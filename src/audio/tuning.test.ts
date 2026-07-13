import { describe, expect, it } from 'vitest'
import { importSclText, TUNING_PRESETS } from './tuning'
import { sanitizePatch, DEFAULT_PATCH } from './contracts'

describe('TUNING_PRESETS', () => {
  it('leads with the empty Default (12-TET legacy) preset', () => {
    expect(TUNING_PRESETS[0].scaleCents).toEqual([])
    expect(TUNING_PRESETS[0].name).toBe('Default')
  })

  it('exposes vendored builtins that all survive the sanitizer unchanged', () => {
    const custom = TUNING_PRESETS.filter((p) => p.scaleCents.length > 0)
    expect(custom.length).toBeGreaterThanOrEqual(5)
    for (const preset of custom) {
      const p = structuredClone(DEFAULT_PATCH)
      p.shared.tuning = structuredClone(preset)
      // A preset must round-trip through the boundary validator untouched.
      expect(sanitizePatch(p).shared.tuning).toEqual(preset)
    }
  })
})

describe('importSclText', () => {
  it('parses a valid .scl into a period-aware TuningSpec', () => {
    const scl = ['! test.scl', '!', 'Test 5-tone', ' 5', ' 240.0', ' 480.0', ' 720.0', ' 960.0', ' 1200.0'].join('\n')
    const spec = importSclText(scl)
    expect(spec.name).toBe('Test 5-tone')
    expect(spec.scaleCents).toEqual([0, 240, 480, 720, 960])
    expect(spec.period).toBe(1200)
  })

  it('supports ratio pitch lines and non-octave periods', () => {
    // Three equal steps of a 3/1 tritave (non-octave).
    const scl = ['! bp.scl', 'tiny tritave', ' 3', ' 3/2', ' 5/2', ' 3/1'].join('\n')
    const spec = importSclText(scl)
    expect(spec.scaleCents[0]).toBe(0)
    expect(spec.period).toBeCloseTo(1200 * Math.log2(3), 6)
  })

  it('throws on a malformed .scl (surfaced as an error, never silent)', () => {
    expect(() => importSclText('garbage')).toThrow()
    expect(() => importSclText('')).toThrow()
  })
})

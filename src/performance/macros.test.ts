import { describe, it, expect } from 'vitest'
import { MACROS, XY, applyPerformance } from './macros'
import {
  DEFAULT_PATCH,
  ENGINE_MODES,
  sanitizePatch,
  type EngineMode,
  type MvoxPatch,
} from '../audio/contracts'

// A mutable, already-sanitized base (DEFAULT_PATCH is frozen). Its perf state is
// all-zero macros + XY at neutral, i.e. the identity configuration.
const freshBase = (mode: EngineMode = 'vocoder'): MvoxPatch => {
  const p = sanitizePatch(DEFAULT_PATCH)
  p.mode = mode
  return p
}

// Reads the PRIMARY target param of macro `i` for a given mode, so tests can
// assert that pushing a macro to 1 actually moves the field it advertises.
const PRIMARY: Record<EngineMode, [(p: MvoxPatch) => number, (p: MvoxPatch) => number, (p: MvoxPatch) => number, (p: MvoxPatch) => number]> = {
  vocoder: [(p) => p.vocoder.bands, (p) => p.vocoder.sibilance, (p) => p.vocoder.bassBoost, (p) => p.fx.reverb],
  harmony: [(p) => p.harmony.voiceCount, (p) => p.harmony.spread, (p) => p.harmony.level, (p) => p.fx.reverb],
  formant: [(p) => p.formant.shift, (p) => p.formant.size, (p) => p.formant.robot, (p) => p.formant.ringAmount],
  follow: [(p) => p.follow.glide, (p) => p.follow.blend, (p) => p.fx.drive, (p) => p.fx.reverb],
}

describe('applyPerformance', () => {
  it('does not mutate the base patch', () => {
    const base = freshBase('formant')
    base.perf.formant.macros = [1, 0.5, 0.3, 0.8]
    base.perf.formant.xyX = 0.9
    base.perf.formant.xyY = 0.1
    const snapshot = structuredClone(base)
    applyPerformance(base)
    expect(base).toEqual(snapshot)
  })

  it('all-zero macros + neutral XY is the identity transform for every mode', () => {
    for (const mode of ENGINE_MODES) {
      const base = freshBase(mode)
      // freshBase already has macros=[0,0,0,0] and xy=(0.5,0.5).
      expect(applyPerformance(base)).toEqual(sanitizePatch(base))
    }
  })

  it('always returns an in-range (sanitize-idempotent) patch', () => {
    for (const mode of ENGINE_MODES) {
      const base = freshBase(mode)
      // Extreme, mixed drive: all macros hot, XY pushed to a corner.
      base.perf[mode].macros = [1, 1, 1, 1]
      base.perf[mode].xyX = 1
      base.perf[mode].xyY = 0
      const result = applyPerformance(base)
      // If every field is in range, sanitize is a no-op → deep-equal.
      expect(sanitizePatch(result)).toEqual(result)
    }
  })

  it('each macro at 1 moves its primary target and stays in range', () => {
    for (const mode of ENGINE_MODES) {
      for (let i = 0; i < 4; i++) {
        const base = freshBase(mode)
        const before = PRIMARY[mode][i](sanitizePatch(base))
        base.perf[mode].macros = [0, 0, 0, 0]
        base.perf[mode].macros[i] = 1
        const result = applyPerformance(base)
        const after = PRIMARY[mode][i](result)
        expect(after).not.toBe(before)
        // Result as a whole must remain valid.
        expect(sanitizePatch(result)).toEqual(result)
      }
    }
  })
})

describe('MACROS / XY tables', () => {
  it('define exactly 4 named macros per mode', () => {
    for (const mode of ENGINE_MODES) {
      expect(MACROS[mode]).toHaveLength(4)
      for (const m of MACROS[mode]) {
        expect(m.name.length).toBeGreaterThan(0)
        expect(typeof m.apply).toBe('function')
      }
    }
  })

  it('define an XY pad with named axes for every mode', () => {
    for (const mode of ENGINE_MODES) {
      expect(XY[mode].xName.length).toBeGreaterThan(0)
      expect(XY[mode].yName.length).toBeGreaterThan(0)
      expect(typeof XY[mode].apply).toBe('function')
    }
  })
})

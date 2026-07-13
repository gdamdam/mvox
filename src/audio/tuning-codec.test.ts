import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, sanitizePatch, type MvoxPatch } from './contracts'
import { decodePatch, encodePatch } from '../sharing/codec'
import { importPatchJSON, migratePatch } from '../persistence/schema'

const JI5 = [0, 111.73, 203.91, 315.64, 386.31, 498.04, 582.51, 701.96, 813.69, 884.36, 996.09, 1088.27]

function withTuning(scaleCents: number[], period = 1200, name = 'Custom'): unknown {
  const p = structuredClone(DEFAULT_PATCH) as MvoxPatch
  p.shared.tuning = { name, scaleCents, period }
  return p
}

describe('sanitizePatch — tuning field', () => {
  it('defaults a patch with no tuning field to the empty (12-TET legacy) tuning', () => {
    const raw = structuredClone(DEFAULT_PATCH) as unknown as Record<string, unknown>
    delete (raw.shared as Record<string, unknown>).tuning
    const clean = sanitizePatch(raw)
    expect(clean.shared.tuning).toEqual({ name: 'Default', scaleCents: [], period: 1200 })
  })

  it('preserves a valid custom tuning', () => {
    const clean = sanitizePatch(withTuning(JI5, 1200, 'Just 5-limit'))
    expect(clean.shared.tuning.scaleCents).toEqual(JI5)
    expect(clean.shared.tuning.period).toBe(1200)
    expect(clean.shared.tuning.name).toBe('Just 5-limit')
  })

  it('rejects malformed tuning tables to the empty default (never throws)', () => {
    const empty = { name: 'Default', scaleCents: [], period: 1200 }
    expect(sanitizePatch(withTuning([0, NaN, 400])).shared.tuning).toEqual(empty)
    expect(sanitizePatch(withTuning([0, 100, 90])).shared.tuning).toEqual(empty) // non-ascending
    expect(sanitizePatch(withTuning([100, 200])).shared.tuning).toEqual(empty) // not rooted at 0
    expect(sanitizePatch(withTuning(JI5, -1200)).shared.tuning).toEqual(empty) // negative period
    expect(sanitizePatch(withTuning(JI5, 0)).shared.tuning).toEqual(empty) // zero period
    const huge = Array.from({ length: 200 }, (_, i) => i)
    expect(sanitizePatch(withTuning(huge, 500)).shared.tuning).toEqual(empty) // oversized
    // scaleCents present but not an array
    const bad = structuredClone(DEFAULT_PATCH) as unknown as Record<string, unknown>
    ;(bad.shared as Record<string, unknown>).tuning = { name: 'x', scaleCents: 'nope', period: 1200 }
    expect(sanitizePatch(bad).shared.tuning).toEqual(empty)
  })
})

describe('codec / session round-trips with tuning', () => {
  it('round-trips a custom tuning through the share codec byte-for-byte', () => {
    const src = sanitizePatch(withTuning(JI5, 1200, 'Just 5-limit'))
    const back = decodePatch(encodePatch(src))
    expect(back).toEqual(src)
  })

  it('round-trips a custom tuning through the session (migrate) path', () => {
    const src = sanitizePatch(withTuning(JI5, 1200, 'Just 5-limit'))
    const back = importPatchJSON(JSON.stringify(src))
    expect(back).toEqual(src)
  })

  it('decodes a legacy link with no tuning field to the empty 12-TET tuning', () => {
    const legacy = structuredClone(DEFAULT_PATCH) as unknown as Record<string, unknown>
    delete (legacy.shared as Record<string, unknown>).tuning
    const back = decodePatch(encodePatch(legacy as unknown as MvoxPatch))
    expect(back?.shared.tuning).toEqual({ name: 'Default', scaleCents: [], period: 1200 })
  })

  it('keeps codec and session sanitizers in parity (same raw → identical patch)', () => {
    // Any raw object must sanitize identically whether it arrives via a share
    // link (decodePatch → migratePatch) or a stored session (migratePatch).
    const raws: unknown[] = [
      withTuning(JI5, 1200, 'Just 5-limit'),
      withTuning([0, NaN], 1200), // malformed
      (() => {
        const r = structuredClone(DEFAULT_PATCH) as unknown as Record<string, unknown>
        delete (r.shared as Record<string, unknown>).tuning
        return r
      })(),
    ]
    for (const raw of raws) {
      const viaCodec = decodePatch(encodePatch(raw as MvoxPatch))
      const viaSession = migratePatch(raw)
      expect(viaCodec).toEqual(viaSession)
    }
  })
})

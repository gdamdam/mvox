import { describe, expect, it } from 'vitest'
import { boundsForRange, RANGE_BOUNDS, rangeForBounds } from './vocalRange'
import { RANGES, VOCAL_RANGES } from './contracts'

describe('vocalRange', () => {
  it('has bounds for every non-custom preset', () => {
    for (const r of VOCAL_RANGES) {
      if (r === 'custom') {
        expect(boundsForRange(r)).toBeNull()
      } else {
        const b = boundsForRange(r)
        expect(b).not.toBeNull()
        expect(b!.minHz).toBeLessThan(b!.maxHz)
      }
    }
  })

  it('keeps every preset within the tracker parameter ranges', () => {
    for (const key of Object.keys(RANGE_BOUNDS) as (keyof typeof RANGE_BOUNDS)[]) {
      const { minHz, maxHz } = RANGE_BOUNDS[key]
      expect(minHz).toBeGreaterThanOrEqual(RANGES.trackMinHz.min)
      expect(minHz).toBeLessThanOrEqual(RANGES.trackMinHz.max)
      expect(maxHz).toBeGreaterThanOrEqual(RANGES.trackMaxHz.min)
      expect(maxHz).toBeLessThanOrEqual(RANGES.trackMaxHz.max)
    }
  })

  it('round-trips bounds → preset', () => {
    expect(rangeForBounds(80, 350)).toBe('bass')
    expect(rangeForBounds(250, 1050)).toBe('soprano')
    expect(rangeForBounds(70, 1000)).toBe('all')
    expect(rangeForBounds(123, 456)).toBe('custom')
  })
})

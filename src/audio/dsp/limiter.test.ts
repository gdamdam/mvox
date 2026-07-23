import { describe, expect, it } from 'vitest'
import { buildLimiterCurve, ceilingToLinear, limiterShape } from './limiter'

describe('ceilingToLinear', () => {
  it('maps 0 dBFS to unity', () => {
    expect(ceilingToLinear(0)).toBeCloseTo(1, 6)
  })
  it('maps -6 dBFS to ~0.501', () => {
    expect(ceilingToLinear(-6)).toBeCloseTo(0.501, 3)
  })
  it('clamps non-finite to unity and never exceeds 1', () => {
    expect(ceilingToLinear(Number.NaN)).toBe(1)
    expect(ceilingToLinear(12)).toBeLessThanOrEqual(1) // a positive ceiling can't push above full scale
  })
})

describe('limiterShape', () => {
  const c = ceilingToLinear(-1) // ~0.891

  it('is transparent below the knee', () => {
    // Well under the knee, output === input exactly.
    expect(limiterShape(0.5, c)).toBeCloseTo(0.5, 6)
    expect(limiterShape(-0.3, c)).toBeCloseTo(-0.3, 6)
  })

  it('never exceeds the ceiling for any input', () => {
    for (let x = -4; x <= 4; x += 0.001) {
      expect(Math.abs(limiterShape(x, c))).toBeLessThanOrEqual(c + 1e-9)
    }
  })

  it('reaches exactly the ceiling at |x| >= c', () => {
    expect(limiterShape(c, c)).toBeCloseTo(c, 6)
    expect(limiterShape(2, c)).toBeCloseTo(c, 6)
    expect(limiterShape(-2, c)).toBeCloseTo(-c, 6)
  })

  it('is monotonic and odd-symmetric', () => {
    let prev = limiterShape(-2, c)
    for (let x = -2; x <= 2; x += 0.01) {
      const y = limiterShape(x, c)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
      expect(limiterShape(-x, c)).toBeCloseTo(-y, 6)
    }
  })

  it('scrubs non-finite input to 0', () => {
    expect(limiterShape(Number.NaN, c)).toBe(0)
  })
})

describe('buildLimiterCurve', () => {
  it('produces an odd-length table bounded by the ceiling', () => {
    const curve = buildLimiterCurve(-1)
    expect(curve.length % 2).toBe(1) // odd → a sample lands exactly on 0
    const c = ceilingToLinear(-1)
    for (const v of curve) expect(Math.abs(v)).toBeLessThanOrEqual(c + 1e-9)
  })

  it('has a zero-crossing at the center (DC-clean)', () => {
    const curve = buildLimiterCurve(-3)
    expect(curve[(curve.length - 1) / 2]).toBeCloseTo(0, 6)
  })

  it('endpoints saturate to the ceiling', () => {
    const curve = buildLimiterCurve(-2)
    const c = ceilingToLinear(-2)
    expect(curve[0]).toBeCloseTo(-c, 5)
    expect(curve[curve.length - 1]).toBeCloseTo(c, 5)
  })
})

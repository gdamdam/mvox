import { describe, expect, it } from 'vitest'
import {
  parseSclGuarded,
  MAX_SCL_TEXT_CHARS,
  MAX_SCL_NOTE_COUNT,
} from './scalaImport'

// A minimal, well-formed 12-TET .scl file (description, count, 12 pitch lines).
function tet12(): string {
  const steps = Array.from({ length: 12 }, (_, i) => ((i + 1) * 100).toFixed(6))
  return ['! test.scl', '12-TET', ' 12', ...steps.map((s) => ` ${s}`)].join('\n') + '\n'
}

describe('parseSclGuarded (DEFECT #11 size limits)', () => {
  it('parses a normal .scl file identically to the vendored parser', () => {
    const scl = parseSclGuarded(tet12())
    expect(scl.name).toBe('12-TET')
    expect(scl.cents[0]).toBe(0)
    expect(scl.cents).toHaveLength(12)
    expect(scl.period).toBeCloseTo(1200, 6)
  })

  it('rejects text over the character cap with a friendly, actionable error', () => {
    const huge = '! x\n'.repeat(MAX_SCL_TEXT_CHARS) // well past the cap
    expect(huge.length).toBeGreaterThan(MAX_SCL_TEXT_CHARS)
    expect(() => parseSclGuarded(huge)).toThrow(/too large/i)
  })

  it('rejects an absurd declared note count before any per-note work', () => {
    const bomb = ['bomb', ` ${MAX_SCL_NOTE_COUNT + 1}`, ' 100.0'].join('\n') + '\n'
    expect(() => parseSclGuarded(bomb)).toThrow(
      new RegExp(`declares ${MAX_SCL_NOTE_COUNT + 1} notes`),
    )
  })

  it('rejects non-string input', () => {
    // @ts-expect-error exercising the runtime guard against non-text input
    expect(() => parseSclGuarded(12345)).toThrow(/not text/i)
  })

  it('still surfaces the vendored parser errors for malformed (but small) files', () => {
    // Under the caps, so this reaches parseScl and fails there as before.
    expect(() => parseSclGuarded('only-one-line')).toThrow(/parseScl/)
  })
})

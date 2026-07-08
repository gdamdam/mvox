import { describe, expect, it } from 'vitest'
import { parseMidi } from './parse'

describe('parseMidi', () => {
  it('decodes a Note On to noteon with normalized velocity', () => {
    const e = parseMidi([0x90, 60, 100])
    expect(e.type).toBe('noteon')
    // narrow the union so note/velocity are accessible
    if (e.type !== 'noteon') throw new Error('expected noteon')
    expect(e.note).toBe(60)
    expect(e.velocity).toBeCloseTo(100 / 127, 5) // ≈ 0.787
  })

  it('treats a Note On with velocity 0 as a noteoff', () => {
    const e = parseMidi([0x90, 60, 0])
    expect(e.type).toBe('noteoff')
    if (e.type !== 'noteoff') throw new Error('expected noteoff')
    expect(e.note).toBe(60)
  })

  it('decodes a Note Off to noteoff', () => {
    const e = parseMidi([0x80, 60, 64])
    expect(e.type).toBe('noteoff')
    if (e.type !== 'noteoff') throw new Error('expected noteoff')
    expect(e.note).toBe(60)
  })

  it('maps non-sustain Control Change (and other non-note messages) to other', () => {
    expect(parseMidi([0xb0, 7, 100]).type).toBe('other')
  })

  it('decodes the sustain pedal (CC 64) with the >= 64 on-threshold', () => {
    const down = parseMidi([0xb0, 64, 127])
    expect(down.type).toBe('sustain')
    if (down.type !== 'sustain') throw new Error('expected sustain')
    expect(down.on).toBe(true)
    // Exactly 64 is "on" per MIDI convention; 63 and 0 are "off".
    expect(parseMidi([0xb0, 64, 64])).toEqual({ type: 'sustain', on: true })
    expect(parseMidi([0xb0, 64, 63])).toEqual({ type: 'sustain', on: false })
    expect(parseMidi([0xb0, 64, 0])).toEqual({ type: 'sustain', on: false })
  })

  it('decodes sustain regardless of channel and treats a truncated CC as other', () => {
    expect(parseMidi([0xb5, 64, 127])).toEqual({ type: 'sustain', on: true })
    expect(parseMidi([0xb0, 64]).type).toBe('other')
  })

  it('maps empty and too-short buffers to other', () => {
    expect(parseMidi([]).type).toBe('other')
    expect(parseMidi(new Uint8Array()).type).toBe('other')
    // Buffer starting with a data byte (no status high bit) is undecodable.
    expect(parseMidi([60, 100]).type).toBe('other')
  })

  it('maps a truncated Note On to other (no fabricated note-off)', () => {
    // Missing velocity byte must not decode to noteoff via a ?? 0 default,
    // which would kill a legitimately held note.
    expect(parseMidi([0x90, 60]).type).toBe('other')
    expect(parseMidi([0x90]).type).toBe('other')
    // A complete Note On still parses.
    expect(parseMidi([0x90, 60, 100]).type).toBe('noteon')
  })

  it('ignores channel bits (0x95 is still a Note On on channel 5)', () => {
    const e = parseMidi([0x95, 64, 80])
    expect(e.type).toBe('noteon')
    if (e.type !== 'noteon') throw new Error('expected noteon')
    expect(e.note).toBe(64)
  })

  it('clamps note number to 0..127 on junk data bytes', () => {
    const e = parseMidi([0x90, 200, 100]) // 200 & 0x7f = 72
    expect(e.type).toBe('noteon')
    if (e.type !== 'noteon') throw new Error('expected noteon')
    expect(e.note).toBe(72)
    expect(e.note).toBeLessThanOrEqual(127)
  })
})

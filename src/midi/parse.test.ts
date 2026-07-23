import { describe, expect, it } from 'vitest'
import { parseMidi } from './parse'

describe('parseMidi', () => {
  it('decodes a Note On to noteon with normalized velocity and channel', () => {
    const e = parseMidi([0x90, 60, 100])
    expect(e.type).toBe('noteon')
    // narrow the union so note/velocity are accessible
    if (e.type !== 'noteon') throw new Error('expected noteon')
    expect(e.note).toBe(60)
    expect(e.velocity).toBeCloseTo(100 / 127, 5) // ≈ 0.787
    expect(e.channel).toBe(0)
  })

  it('extracts the channel from the status low nibble', () => {
    // 0x9a = Note On on channel 10; 0x83 = Note Off on channel 3.
    const on = parseMidi([0x9a, 60, 100])
    if (on.type !== 'noteon') throw new Error('expected noteon')
    expect(on.channel).toBe(10)
    const off = parseMidi([0x83, 60, 0])
    if (off.type !== 'noteoff') throw new Error('expected noteoff')
    expect(off.channel).toBe(3)
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

  it('decodes a non-sustain Control Change to cc with normalized value + channel', () => {
    // CC 7 (channel volume) on channel 0 → cc, value normalized 0..1.
    const e = parseMidi([0xb0, 7, 100])
    expect(e.type).toBe('cc')
    if (e.type !== 'cc') throw new Error('expected cc')
    expect(e.controller).toBe(7)
    expect(e.value).toBeCloseTo(100 / 127, 5)
    expect(e.channel).toBe(0)
  })

  it('decodes the mod wheel (CC 1) to cc rather than other', () => {
    const e = parseMidi([0xb2, 1, 127])
    expect(e.type).toBe('cc')
    if (e.type !== 'cc') throw new Error('expected cc')
    expect(e.controller).toBe(1)
    expect(e.value).toBeCloseTo(1, 5)
    expect(e.channel).toBe(2)
  })

  it('decodes the sustain pedal (CC 64) with the >= 64 on-threshold', () => {
    const down = parseMidi([0xb0, 64, 127])
    expect(down.type).toBe('sustain')
    if (down.type !== 'sustain') throw new Error('expected sustain')
    expect(down.on).toBe(true)
    // Exactly 64 is "on" per MIDI convention; 63 and 0 are "off".
    expect(parseMidi([0xb0, 64, 64])).toEqual({ type: 'sustain', on: true, channel: 0 })
    expect(parseMidi([0xb0, 64, 63])).toEqual({ type: 'sustain', on: false, channel: 0 })
    expect(parseMidi([0xb0, 64, 0])).toEqual({ type: 'sustain', on: false, channel: 0 })
  })

  it('decodes sustain regardless of channel and treats a truncated CC as other', () => {
    expect(parseMidi([0xb5, 64, 127])).toEqual({ type: 'sustain', on: true, channel: 5 })
    expect(parseMidi([0xb0, 64]).type).toBe('other')
  })

  it('decodes pitch bend to -1..1 with 0 at center', () => {
    // LSB | (MSB << 7): center 8192 = [0x00, 0x40], min 0, max 16383.
    const center = parseMidi([0xe0, 0x00, 0x40])
    if (center.type !== 'pitchbend') throw new Error('expected pitchbend')
    expect(center.value).toBeCloseTo(0, 5)
    expect(center.channel).toBe(0)

    const min = parseMidi([0xe1, 0x00, 0x00])
    if (min.type !== 'pitchbend') throw new Error('expected pitchbend')
    expect(min.value).toBeCloseTo(-1, 5)
    expect(min.channel).toBe(1)

    const max = parseMidi([0xe0, 0x7f, 0x7f]) // raw 16383
    if (max.type !== 'pitchbend') throw new Error('expected pitchbend')
    expect(max.value).toBeCloseTo(1, 3) // ≈ +1 (16383 → ~1.0001)
  })

  it('maps a truncated pitch bend to other', () => {
    expect(parseMidi([0xe0, 0x00]).type).toBe('other')
    expect(parseMidi([0xe0]).type).toBe('other')
  })

  it('decodes channel pressure to a normalized value + channel', () => {
    const e = parseMidi([0xd4, 100])
    expect(e.type).toBe('pressure')
    if (e.type !== 'pressure') throw new Error('expected pressure')
    expect(e.value).toBeCloseTo(100 / 127, 5)
    expect(e.channel).toBe(4)
  })

  it('maps a truncated channel pressure to other', () => {
    expect(parseMidi([0xd0]).type).toBe('other')
  })

  it('decodes a Program Change to program with program number + channel', () => {
    const e = parseMidi([0xc0, 42])
    expect(e.type).toBe('program')
    if (e.type !== 'program') throw new Error('expected program')
    expect(e.program).toBe(42)
    expect(e.channel).toBe(0)
  })

  it('extracts the channel from a Program Change status low nibble (0xc5 → channel 5)', () => {
    const e = parseMidi([0xc5, 7])
    expect(e.type).toBe('program')
    if (e.type !== 'program') throw new Error('expected program')
    expect(e.program).toBe(7)
    expect(e.channel).toBe(5)
  })

  it('clamps a Program Change program byte to 0..127', () => {
    const e = parseMidi([0xc0, 200]) // 200 & 0x7f = 72
    if (e.type !== 'program') throw new Error('expected program')
    expect(e.program).toBe(72)
  })

  it('maps a truncated Program Change (status only) to other', () => {
    expect(parseMidi([0xc0]).type).toBe('other')
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

  it('decodes channel bits (0x95 is a Note On on channel 5)', () => {
    const e = parseMidi([0x95, 64, 80])
    expect(e.type).toBe('noteon')
    if (e.type !== 'noteon') throw new Error('expected noteon')
    expect(e.note).toBe(64)
    expect(e.channel).toBe(5)
  })

  it('clamps note number to 0..127 on junk data bytes', () => {
    const e = parseMidi([0x90, 200, 100]) // 200 & 0x7f = 72
    expect(e.type).toBe('noteon')
    if (e.type !== 'noteon') throw new Error('expected noteon')
    expect(e.note).toBe(72)
    expect(e.note).toBeLessThanOrEqual(127)
  })
})

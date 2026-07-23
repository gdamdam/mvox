import { describe, expect, it } from 'vitest'
import {
  addMapping,
  findBySource,
  isContinuousTarget,
  removeMappingForTarget,
  sanitizeMappings,
  sourceFromEvent,
  sourceKey,
  sourceMatches,
  targetKey,
  type MidiMapping,
} from './mapping'

describe('mapping identity + matching', () => {
  it('keys sources and targets stably', () => {
    expect(sourceKey({ kind: 'cc', controller: 7 })).toBe('cc:7')
    expect(sourceKey({ kind: 'pitchbend' })).toBe('pitchbend')
    expect(targetKey({ kind: 'macro', index: 2 })).toBe('macro:2')
    expect(targetKey({ kind: 'mode', mode: 'harmony' })).toBe('mode:harmony')
    expect(targetKey({ kind: 'panic' })).toBe('panic')
  })

  it('matches events to sources', () => {
    expect(sourceMatches({ kind: 'cc', controller: 7 }, { type: 'cc', controller: 7 })).toBe(true)
    expect(sourceMatches({ kind: 'cc', controller: 7 }, { type: 'cc', controller: 8 })).toBe(false)
    expect(sourceMatches({ kind: 'pitchbend' }, { type: 'pitchbend' })).toBe(true)
    expect(sourceMatches({ kind: 'pressure' }, { type: 'cc', controller: 1 })).toBe(false)
  })

  it('captures a learnable source from an event', () => {
    expect(sourceFromEvent({ type: 'cc', controller: 74 })).toEqual({ kind: 'cc', controller: 74 })
    expect(sourceFromEvent({ type: 'pitchbend' })).toEqual({ kind: 'pitchbend' })
    expect(sourceFromEvent({ type: 'noteon' })).toBeNull()
  })

  it('classifies continuous vs trigger targets', () => {
    expect(isContinuousTarget({ kind: 'macro', index: 0 })).toBe(true)
    expect(isContinuousTarget({ kind: 'master' })).toBe(true)
    expect(isContinuousTarget({ kind: 'panic' })).toBe(false)
    expect(isContinuousTarget({ kind: 'mode', mode: 'vocoder' })).toBe(false)
  })
})

describe('addMapping dedup invariants', () => {
  it('replaces an existing binding for the same target', () => {
    let m: MidiMapping[] = []
    m = addMapping(m, { kind: 'cc', controller: 1 }, { kind: 'macro', index: 0 })
    m = addMapping(m, { kind: 'cc', controller: 2 }, { kind: 'macro', index: 0 })
    expect(m).toHaveLength(1)
    expect(m[0].source).toEqual({ kind: 'cc', controller: 2 })
  })

  it('replaces an existing binding from the same source', () => {
    let m: MidiMapping[] = []
    m = addMapping(m, { kind: 'cc', controller: 1 }, { kind: 'macro', index: 0 })
    m = addMapping(m, { kind: 'cc', controller: 1 }, { kind: 'xy', axis: 'x' })
    expect(m).toHaveLength(1)
    expect(m[0].target).toEqual({ kind: 'xy', axis: 'x' })
  })

  it('removes by target and finds by source', () => {
    let m: MidiMapping[] = []
    m = addMapping(m, { kind: 'cc', controller: 20 }, { kind: 'panic' })
    expect(findBySource(m, { type: 'cc', controller: 20 })?.target.kind).toBe('panic')
    m = removeMappingForTarget(m, { kind: 'panic' })
    expect(m).toHaveLength(0)
  })
})

describe('sanitizeMappings', () => {
  it('drops malformed entries and enforces the one-to-one invariant', () => {
    const raw = [
      { source: { kind: 'cc', controller: 1 }, target: { kind: 'macro', index: 0 } },
      { source: { kind: 'cc', controller: 1 }, target: { kind: 'master' } }, // dup source → dropped
      { source: { kind: 'cc', controller: 999 }, target: { kind: 'panic' } }, // bad controller → dropped
      { source: { kind: 'bogus' }, target: { kind: 'panic' } }, // bad source → dropped
      { source: { kind: 'pitchbend' }, target: { kind: 'xy', axis: 'z' } }, // bad axis → dropped
      { source: { kind: 'pressure' }, target: { kind: 'record' } }, // valid
    ]
    const m = sanitizeMappings(raw)
    expect(m).toHaveLength(2)
    expect(m.map((x) => x.target.kind).sort()).toEqual(['macro', 'record'])
  })

  it('returns [] for non-arrays', () => {
    expect(sanitizeMappings(null)).toEqual([])
    expect(sanitizeMappings({})).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { loadSlots, saveSlots, SLOT_COUNT, SLOTS_KEY } from './slots'
import { sanitizeSnapshot, type SessionStore } from './session'
import { DEFAULT_PATCH } from '../audio/contracts'

function fakeStore(seed: Record<string, string> = {}): SessionStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('quick-recall slots', () => {
  it('starts all-empty with a fixed length', () => {
    const bank = loadSlots(fakeStore())
    expect(bank).toHaveLength(SLOT_COUNT)
    expect(bank.every((s) => s === null)).toBe(true)
  })

  it('round-trips a snapshot in a slot', () => {
    const store = fakeStore()
    const bank = loadSlots(store)
    bank[2] = sanitizeSnapshot({ patch: DEFAULT_PATCH, perf: { bpm: 96, latch: true, midiMappings: [], midiChannel: 2 } })
    expect(saveSlots(bank, store)).toBe(true)
    const back = loadSlots(store)
    expect(back[2]?.perf.bpm).toBe(96)
    expect(back[2]?.perf.midiChannel).toBe(2)
    expect(back[0]).toBeNull()
  })

  it('sanitizes stored snapshots and tolerates corruption', () => {
    expect(loadSlots(fakeStore({ [SLOTS_KEY]: '{bad json' })).every((s) => s === null)).toBe(true)
    // A bad patch inside a slot degrades to defaults rather than corrupting the app.
    const store = fakeStore({ [SLOTS_KEY]: JSON.stringify([{ patch: { mode: 'nope' }, perf: {} }]) })
    const bank = loadSlots(store)
    expect(bank[0]?.patch.mode).toBe(DEFAULT_PATCH.mode)
  })

  it('degrades to empty / false when storage is unavailable', () => {
    expect(loadSlots(null).every((s) => s === null)).toBe(true)
    expect(saveSlots(emptyLike(), null)).toBe(false)
  })
})

function emptyLike() {
  return new Array(SLOT_COUNT).fill(null)
}

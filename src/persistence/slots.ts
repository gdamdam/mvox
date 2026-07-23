// Numbered quick-recall slots: a small fixed bank of portable session snapshots
// (patch + performance) persisted locally, recallable by click or MIDI program
// change. Kept separate from user presets (IndexedDB, named, unbounded) because
// slots are a fixed, instantly-recallable performance bank — a different shape and
// a different storage tier (synchronous localStorage, no async flash on load).
//
// Pure but for the injectable storage handle, so it is Node-testable.

import { sanitizeSnapshot, type SessionSnapshot } from './session'
import type { SessionStore } from './session'

/** Eight slots — enough for a set, addressable by MIDI program change 0..7. */
export const SLOT_COUNT = 8
export const SLOTS_KEY = 'mvox.slots'

export type SlotBank = (SessionSnapshot | null)[]

function emptyBank(): SlotBank {
  return new Array<SessionSnapshot | null>(SLOT_COUNT).fill(null)
}

function defaultStore(): SessionStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/**
 * Load the slot bank. Never throws; a missing/corrupt store yields all-empty
 * slots. Each stored snapshot is re-sanitized (the trust boundary) so a tampered
 * or stale blob can't inject a bad patch. A slot that isn't an object stays null.
 */
export function loadSlots(store: SessionStore | null = defaultStore()): SlotBank {
  if (!store) return emptyBank()
  let text: string | null
  try {
    text = store.getItem(SLOTS_KEY)
  } catch {
    return emptyBank()
  }
  if (!text) return emptyBank()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyBank()
  }
  const bank = emptyBank()
  if (Array.isArray(parsed)) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const entry = parsed[i]
      // null / missing = empty slot; anything object-shaped is sanitized.
      bank[i] = entry && typeof entry === 'object' ? sanitizeSnapshot(entry) : null
    }
  }
  return bank
}

/** Persist the slot bank. Best-effort: returns false (never throws) on failure. */
export function saveSlots(bank: SlotBank, store: SessionStore | null = defaultStore()): boolean {
  if (!store) return false
  try {
    // Normalize length so the stored array is always SLOT_COUNT long.
    const out = emptyBank().map((_, i) => bank[i] ?? null)
    store.setItem(SLOTS_KEY, JSON.stringify(out))
    return true
  } catch {
    return false
  }
}

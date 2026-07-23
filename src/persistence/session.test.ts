import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION,
  loadSession,
  migrateSession,
  sanitizeSession,
  saveSession,
  SESSION_BACKUP_KEY,
  SESSION_KEY,
  SESSION_VERSION,
  type SessionStore,
} from './session'
import { DEFAULT_PATCH } from '../audio/contracts'

/** In-memory Storage-like for deterministic Node tests. */
function fakeStore(seed: Record<string, string> = {}): SessionStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('sanitizeSession', () => {
  it('fills defaults for empty input', () => {
    const s = sanitizeSession(undefined)
    expect(s.version).toBe(SESSION_VERSION)
    expect(s.performance.bpm).toBe(120)
    expect(s.performance.latch).toBe(false)
  })

  it('clamps bpm and coerces latch', () => {
    expect(sanitizeSession({ performance: { bpm: 5000, latch: 'yes' } }).performance).toMatchObject({
      bpm: 300,
      latch: false,
    })
    expect(sanitizeSession({ performance: { bpm: 1, latch: true } }).performance).toMatchObject({
      bpm: 40,
      latch: true,
    })
  })

  it('defaults MIDI fields and sanitizes mappings', () => {
    const s = sanitizeSession(undefined)
    expect(s.performance.midiMappings).toEqual([])
    expect(s.performance.midiInputId).toBeNull()
    expect(s.performance.midiChannel).toBeNull()
    // Device/quality prefs default safely too.
    expect(s.performance.quality).toBe('normal')
    expect(s.performance.audioInputId).toBeNull()
    expect(s.performance.audioOutputId).toBeNull()
    expect(sanitizeSession({ performance: { quality: 'bogus' } }).performance.quality).toBe('normal')
    expect(sanitizeSession({ performance: { quality: 'safe' } }).performance.quality).toBe('safe')
    const withMap = sanitizeSession({
      performance: {
        midiChannel: 3,
        midiInputId: 'dev-1',
        midiMappings: [{ source: { kind: 'cc', controller: 7 }, target: { kind: 'master' } }],
      },
    })
    expect(withMap.performance.midiChannel).toBe(3)
    expect(withMap.performance.midiInputId).toBe('dev-1')
    expect(withMap.performance.midiMappings).toHaveLength(1)
  })

  it('routes the patch through sanitizePatch (bad patch → defaults)', () => {
    const s = sanitizeSession({ patch: { mode: 'not-a-mode', vocoder: { bands: 9999 } } })
    expect(s.patch.mode).toBe(DEFAULT_PATCH.mode)
    expect(s.patch.vocoder.bands).toBeLessThanOrEqual(32)
  })
})

describe('migrateSession', () => {
  it('reports empty for null/undefined', () => {
    expect(migrateSession(null).status).toBe('empty')
    expect(migrateSession(undefined).status).toBe('empty')
  })

  it('reports corrupt for non-object input', () => {
    expect(migrateSession(42).status).toBe('reset-corrupt')
    expect(migrateSession([1, 2]).status).toBe('reset-corrupt')
  })

  it('refuses a future version without downgrading it', () => {
    const { session, status } = migrateSession({ version: SESSION_VERSION + 1, patch: {} })
    expect(status).toBe('reset-future')
    expect(session).toBe(DEFAULT_SESSION)
  })

  it('accepts a current-version session', () => {
    const { status, session } = migrateSession({ version: SESSION_VERSION, performance: { bpm: 90, latch: true } })
    expect(status).toBe('ok')
    expect(session.performance).toMatchObject({ bpm: 90, latch: true })
  })
})

describe('loadSession / saveSession round-trip', () => {
  it('round-trips a saved session', () => {
    const store = fakeStore()
    const session = sanitizeSession({ performance: { bpm: 128, latch: true } })
    expect(saveSession(session, store)).toBe(true)
    const { session: back, status } = loadSession(store)
    expect(status).toBe('ok')
    expect(back.performance).toMatchObject({ bpm: 128, latch: true })
  })

  it('returns empty when nothing is stored', () => {
    expect(loadSession(fakeStore()).status).toBe('empty')
  })

  it('recovers from corrupt JSON', () => {
    const store = fakeStore({ [SESSION_KEY]: '{not json' })
    expect(loadSession(store).status).toBe('reset-corrupt')
  })

  it('backs up a future-version blob instead of destroying it', () => {
    const raw = JSON.stringify({ version: SESSION_VERSION + 5, secret: 'from the future' })
    const store = fakeStore({ [SESSION_KEY]: raw })
    const { status } = loadSession(store)
    expect(status).toBe('reset-future')
    // The original bytes are preserved in the sidecar backup key.
    expect(store.map.get(SESSION_BACKUP_KEY)).toBe(raw)
    // The main key is untouched (not yet overwritten with defaults).
    expect(store.map.get(SESSION_KEY)).toBe(raw)
  })

  it('degrades to false/empty when storage is unavailable', () => {
    expect(saveSession(DEFAULT_SESSION, null)).toBe(false)
    expect(loadSession(null).status).toBe('empty')
  })
})

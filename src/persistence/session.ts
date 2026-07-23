// Versioned SESSION state — the wider "where I left off" record, distinct from a
// sound PATCH. A patch is the shareable/exportable sound (see contracts.ts); a
// session additionally carries transient performance state that is meaningful
// only on THIS device and must never travel in a share link (BPM, latch, and — as
// later waves land — MIDI mappings, input calibration, pitch-tracking prefs,
// device preferences). Kept pure and I/O-free so it is Node-testable; the storage
// side effects go through an injectable Storage-like handle.
//
// Recovery discipline mirrors schema.migratePatch: we refuse to silently destroy
// data from a FUTURE version. A newer client's session is backed up to a sidecar
// key and the app falls back to defaults, so downgrading then re-running a newer
// build still finds its data.

import { sanitizePatch, type MvoxPatch, DEFAULT_PATCH } from '../audio/contracts'
import { sanitizeMappings, type MidiMapping } from '../midi/mapping'

// v2 added MIDI-learn mappings + input/channel preferences. Bumping the version is
// backward-compatible: a v1 blob simply lacks these fields and sanitize fills the
// defaults (empty mappings, all inputs, all channels) — no data loss, no explicit
// migration step needed.
export const SESSION_VERSION = 2

/** Performance state that lives only on this device (never in a share link). */
export interface PerformanceState {
  bpm: number
  latch: boolean
  midiMappings: MidiMapping[]
  // Stable device id (NOT the MIDIInput object) + channel filter (null = all).
  midiInputId: string | null
  midiChannel: number | null
  // Audio device + quality preferences. Stable ids only (never device objects).
  quality: 'normal' | 'safe'
  audioInputId: string | null
  audioOutputId: string | null
}

export interface SessionState {
  version: number
  patch: MvoxPatch
  performance: PerformanceState
}

/**
 * A PORTABLE performance snapshot: the patch plus the performance state that
 * makes sense to carry between devices (BPM, latch, MIDI mappings, channel). It
 * deliberately EXCLUDES `midiInputId` — a device id is meaningful only on the
 * machine it was captured on, so a saved preset / recalled slot must not pin the
 * MIDI input. Used by complete performance presets, A/B slots, and quick-recall.
 */
export interface PerfSnapshot {
  bpm: number
  latch: boolean
  midiMappings: MidiMapping[]
  midiChannel: number | null
}

export interface SessionSnapshot {
  patch: MvoxPatch
  perf: PerfSnapshot
}

export function sanitizePerfSnapshot(raw: unknown): PerfSnapshot {
  const r = isRecord(raw) ? raw : {}
  return {
    bpm: clampBpm(r.bpm),
    latch: typeof r.latch === 'boolean' ? r.latch : false,
    midiMappings: sanitizeMappings(r.midiMappings),
    midiChannel:
      typeof r.midiChannel === 'number' && r.midiChannel >= 0 && r.midiChannel <= 15
        ? Math.round(r.midiChannel)
        : null,
  }
}

/** Validate a stored/decoded full snapshot (patch + portable perf). Never throws. */
export function sanitizeSnapshot(raw: unknown): SessionSnapshot {
  const r = isRecord(raw) ? raw : {}
  return { patch: sanitizePatch(r.patch), perf: sanitizePerfSnapshot(r.perf) }
}

const BPM_MIN = 40
const BPM_MAX = 300
const DEFAULT_BPM = 120

export const DEFAULT_SESSION: SessionState = {
  version: SESSION_VERSION,
  patch: DEFAULT_PATCH,
  performance: {
    bpm: DEFAULT_BPM,
    latch: false,
    midiMappings: [],
    midiInputId: null,
    midiChannel: null,
    quality: 'normal',
    audioInputId: null,
    audioOutputId: null,
  },
}

/** Outcome of a load: 'ok' restored cleanly; 'empty' had nothing stored;
 *  'reset-corrupt'/'reset-future' fell back to defaults (future data was backed
 *  up, not destroyed). The UI surfaces the reset cases so a wiped session isn't
 *  a silent surprise. */
export type SessionStatus = 'ok' | 'empty' | 'reset-corrupt' | 'reset-future'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clampBpm(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_BPM
  return Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, v)))
}

/**
 * Coerce anything into a valid current-version SessionState. Never throws. The
 * patch funnels through sanitizePatch (the DSP trust boundary); performance
 * fields are clamped field-by-field to defaults.
 */
export function sanitizeSession(raw: unknown): SessionState {
  const r = isRecord(raw) ? raw : {}
  const perf = isRecord(r.performance) ? r.performance : {}
  return {
    version: SESSION_VERSION,
    patch: sanitizePatch(r.patch),
    performance: {
      bpm: clampBpm(perf.bpm),
      latch: typeof perf.latch === 'boolean' ? perf.latch : false,
      midiMappings: sanitizeMappings(perf.midiMappings),
      midiInputId: typeof perf.midiInputId === 'string' ? perf.midiInputId : null,
      midiChannel:
        typeof perf.midiChannel === 'number' && perf.midiChannel >= 0 && perf.midiChannel <= 15
          ? Math.round(perf.midiChannel)
          : null,
      quality: perf.quality === 'safe' ? 'safe' : 'normal',
      audioInputId: typeof perf.audioInputId === 'string' ? perf.audioInputId : null,
      audioOutputId: typeof perf.audioOutputId === 'string' ? perf.audioOutputId : null,
    },
  }
}

/**
 * Migrate a raw stored value to the current session shape. Returns the session
 * plus a status. A future-version session is NOT sanitized down (that would strip
 * unknown fields and restamp the version, destroying it on the next save); the
 * caller is told 'reset-future' so it can back the raw blob up first.
 */
export function migrateSession(raw: unknown): { session: SessionState; status: SessionStatus } {
  if (raw === undefined || raw === null) {
    return { session: DEFAULT_SESSION, status: 'empty' }
  }
  if (!isRecord(raw)) {
    return { session: DEFAULT_SESSION, status: 'reset-corrupt' }
  }
  const version = typeof raw.version === 'number' ? raw.version : 0
  if (version > SESSION_VERSION) {
    return { session: DEFAULT_SESSION, status: 'reset-future' }
  }
  // Migration ladder: add `if (version < N) raw = stepToN(raw)` here as the schema
  // grows. v1 is current, so we go straight to sanitize.
  return { session: sanitizeSession(raw), status: 'ok' }
}

// --- storage side (injectable so tests need no jsdom) -----------------------

/** The tiny subset of the Storage API we use. */
export interface SessionStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const SESSION_KEY = 'mvox.session'
export const SESSION_BACKUP_KEY = 'mvox.session.backup'

function defaultStore(): SessionStore | null {
  try {
    // localStorage access throws in some privacy modes; treat as unavailable.
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/**
 * Load + migrate the last session. Never throws. On a future-version blob the raw
 * text is copied to a sidecar backup key before we fall back to defaults, so the
 * newer client's data survives a downgrade round-trip.
 */
export function loadSession(store: SessionStore | null = defaultStore()): {
  session: SessionState
  status: SessionStatus
} {
  if (!store) return { session: DEFAULT_SESSION, status: 'empty' }
  let text: string | null
  try {
    text = store.getItem(SESSION_KEY)
  } catch {
    return { session: DEFAULT_SESSION, status: 'reset-corrupt' }
  }
  if (text === null) return { session: DEFAULT_SESSION, status: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { session: DEFAULT_SESSION, status: 'reset-corrupt' }
  }
  const { session, status } = migrateSession(parsed)
  if (status === 'reset-future') {
    try {
      store.setItem(SESSION_BACKUP_KEY, text)
    } catch {
      // Backup is best-effort; if it fails we still don't overwrite the main key
      // (the caller won't save over it until the user changes something).
    }
  }
  return { session, status }
}

/** Persist a session. Best-effort: returns false (never throws) if storage is
 *  unavailable or the write fails (quota, private mode). */
export function saveSession(session: SessionState, store: SessionStore | null = defaultStore()): boolean {
  if (!store) return false
  try {
    store.setItem(SESSION_KEY, JSON.stringify({ ...session, version: SESSION_VERSION }))
    return true
  } catch {
    return false
  }
}

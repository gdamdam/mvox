// MIDI-learn mapping model. Pure + Node-testable: types, matching, dedup, and
// (de)serialization only — the actual patch mutation / action dispatch lives in
// App (it owns update() and the engine actions). A mapping binds a MIDI SOURCE
// (a specific CC, pitch bend, or channel pressure) to a TARGET (a continuous
// parameter or a trigger action). Persisted in versioned session state.

import { ENGINE_MODES, type EngineMode } from '../audio/contracts'

// What produces the control value.
export type MidiSource =
  | { kind: 'cc'; controller: number } // a specific continuous controller (incl. mod wheel = CC1)
  | { kind: 'pitchbend' }
  | { kind: 'pressure' } // channel pressure / aftertouch

// Where the value goes. Continuous targets take the 0..1 (or -1..1) source value;
// trigger targets fire on a rising edge (value crossing up through 0.5).
export type MappingTarget =
  | { kind: 'macro'; index: number } // current mode's macro 0..3
  | { kind: 'xy'; axis: 'x' | 'y' } // current mode's XY pad axis
  | { kind: 'master' }
  | { kind: 'monitor' }
  | { kind: 'panic' }
  | { kind: 'record' }
  | { kind: 'latch' }
  | { kind: 'mode'; mode: EngineMode }

export interface MidiMapping {
  source: MidiSource
  target: MappingTarget
}

/** Continuous targets are driven by the raw source value; triggers fire on an
 *  edge. The UI and the apply logic both need to know which is which. */
export function isContinuousTarget(t: MappingTarget): boolean {
  return t.kind === 'macro' || t.kind === 'xy' || t.kind === 'master' || t.kind === 'monitor'
}

/** Stable string identity for a source (dedup + comparison). */
export function sourceKey(s: MidiSource): string {
  return s.kind === 'cc' ? `cc:${s.controller}` : s.kind
}

/** Stable string identity for a target (one binding per target). */
export function targetKey(t: MappingTarget): string {
  switch (t.kind) {
    case 'macro':
      return `macro:${t.index}`
    case 'xy':
      return `xy:${t.axis}`
    case 'mode':
      return `mode:${t.mode}`
    default:
      return t.kind
  }
}

/** Does an inbound MIDI event drive this source? (event shape mirrors parse.ts) */
export function sourceMatches(s: MidiSource, ev: { type: string; controller?: number }): boolean {
  if (s.kind === 'cc') return ev.type === 'cc' && ev.controller === s.controller
  return ev.type === s.kind
}

/** Capture a learnable source from an inbound event, or null if not learnable. */
export function sourceFromEvent(ev: { type: string; controller?: number }): MidiSource | null {
  if (ev.type === 'cc' && typeof ev.controller === 'number') return { kind: 'cc', controller: ev.controller }
  if (ev.type === 'pitchbend') return { kind: 'pitchbend' }
  if (ev.type === 'pressure') return { kind: 'pressure' }
  return null
}

/**
 * Bind `source` → `target`, returning a NEW array. Removes any existing binding
 * with the same target (one control per destination) AND any binding from the
 * same source (a physical control drives one thing) — so learning can never
 * create duplicate/ambiguous routes.
 */
export function addMapping(mappings: MidiMapping[], source: MidiSource, target: MappingTarget): MidiMapping[] {
  const sk = sourceKey(source)
  const tk = targetKey(target)
  return [...mappings.filter((m) => sourceKey(m.source) !== sk && targetKey(m.target) !== tk), { source, target }]
}

/** Remove the binding for a target (used by the UI's clear button). */
export function removeMappingForTarget(mappings: MidiMapping[], target: MappingTarget): MidiMapping[] {
  const tk = targetKey(target)
  return mappings.filter((m) => targetKey(m.target) !== tk)
}

/** Find the mapping bound to a source (or undefined). */
export function findBySource(mappings: MidiMapping[], ev: { type: string; controller?: number }): MidiMapping | undefined {
  return mappings.find((m) => sourceMatches(m.source, ev))
}

// --- (de)serialization ------------------------------------------------------

function sanitizeSource(raw: unknown): MidiSource | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'cc' && typeof r.controller === 'number' && r.controller >= 0 && r.controller <= 127) {
    return { kind: 'cc', controller: Math.round(r.controller) }
  }
  if (r.kind === 'pitchbend') return { kind: 'pitchbend' }
  if (r.kind === 'pressure') return { kind: 'pressure' }
  return null
}

function sanitizeTarget(raw: unknown): MappingTarget | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  switch (r.kind) {
    case 'macro':
      return typeof r.index === 'number' && r.index >= 0 && r.index <= 3 ? { kind: 'macro', index: Math.round(r.index) } : null
    case 'xy':
      return r.axis === 'x' || r.axis === 'y' ? { kind: 'xy', axis: r.axis } : null
    case 'mode':
      return typeof r.mode === 'string' && (ENGINE_MODES as readonly string[]).includes(r.mode)
        ? { kind: 'mode', mode: r.mode as EngineMode }
        : null
    case 'master':
    case 'monitor':
    case 'panic':
    case 'record':
    case 'latch':
      return { kind: r.kind }
    default:
      return null
  }
}

/** Validate a stored/decoded mappings array; drops any malformed entry. Never
 *  throws — a corrupt session can't inject a bad mapping into the app. */
export function sanitizeMappings(raw: unknown): MidiMapping[] {
  if (!Array.isArray(raw)) return []
  const out: MidiMapping[] = []
  const seenSrc = new Set<string>()
  const seenTgt = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const source = sanitizeSource((entry as Record<string, unknown>).source)
    const target = sanitizeTarget((entry as Record<string, unknown>).target)
    if (!source || !target) continue
    const sk = sourceKey(source)
    const tk = targetKey(target)
    if (seenSrc.has(sk) || seenTgt.has(tk)) continue // enforce the one-to-one invariant on load
    seenSrc.add(sk)
    seenTgt.add(tk)
    out.push({ source, target })
  }
  return out
}

// --- human-readable labels (UI) ---------------------------------------------

export function describeSource(s: MidiSource): string {
  if (s.kind === 'cc') return s.controller === 1 ? 'Mod wheel' : `CC ${s.controller}`
  return s.kind === 'pitchbend' ? 'Pitch bend' : 'Pressure'
}

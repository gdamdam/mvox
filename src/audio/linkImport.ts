/**
 * Import a tuning from a pasted mdrone share link — the flagship suite
 * integration: sing harmonised in the exact scale you built in mdrone. Ported
 * from ../mraga/src/linkImport.ts, adapted to mvox's model:
 *   - mvox is period-AWARE, so the legacy `[scaleCents…, period]` degrees array
 *     is split — the trailing entry becomes `period`, the rest `scaleCents` —
 *     instead of mraga's octave-lattice workaround.
 *   - tonicHz is derived from the key root (see microtuning), so we return the
 *     link's root as a PITCH CLASS for the caller to set as the key; the link's
 *     octave is irrelevant to octave-agnostic snapping.
 *   - a malformed link returns null (caller shows an error) rather than silently
 *     falling back to a different tuning.
 */

import { decodePayload, extractPayloadFromUrl } from './shareCodec'
import type { TuningSpec } from './contracts'
import { resolveTuning } from './dsp/microtuning'
import { BUILTIN_PORTABLE_TUNINGS } from '../vendor/tuning-core/builtins'
import { periodCents } from '../vendor/tuning-core/model'

export interface ImportedTuning {
  /** Pitch class 0–11 to set as the key root (tonic derives from it). */
  root: number
  tuning: TuningSpec
}

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// mdrone's short tuning ids ↔ the vendored library's canonical names (mirrors
// mraga's builtinTunings.ts). A link that names a builtin carries no inline
// cents, so we resolve its legacy `[scaleCents…, period]` degrees from here.
const ID_BY_NAME: Record<string, string> = {
  'Equal (12-TET)': 'equal',
  'Just 5-limit': 'just5',
  '¼-comma Meantone': 'meantone',
  'Harmonic Series': 'harmonics',
  'Maqam Rast': 'maqam-rast',
  Slendro: 'slendro',
}
const BUILTIN_BY_ID = new Map<string, { label: string; degrees: number[] }>()
for (const t of BUILTIN_PORTABLE_TUNINGS) {
  const id = ID_BY_NAME[t.name]
  if (id) BUILTIN_BY_ID.set(id, { label: t.name, degrees: [...t.scaleCents, periodCents(t)] })
}
function getBuiltin(id: string | null | undefined): { label: string; degrees: number[] } {
  const b = id ? BUILTIN_BY_ID.get(id) : undefined
  return b ?? BUILTIN_BY_ID.get('equal')!
}

// A legacy `[scaleCents…, period]` array: ≥ 2 finite entries rooted at 0.
function isValidDegrees(d: unknown): d is number[] {
  return (
    Array.isArray(d) &&
    d.length >= 2 &&
    d.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    d[0] === 0
  )
}

/** Map a decoded mdrone scene to an mvox tuning + root, or null if it carries no
 *  usable tuning (unknown root, or an explicit-but-malformed custom scale). */
export function sceneToImportedTuning(scene: unknown): ImportedTuning | null {
  try {
    // Untrusted decoded payload — every field is validated before use.
    const s = scene as {
      drone?: { root?: unknown; tuningId?: unknown }
      customTuning?: { id?: unknown; label?: unknown; degrees?: unknown }
    }
    const root = s?.drone?.root
    if (typeof root !== 'string') return null
    const rootIdx = PITCH_CLASSES.indexOf(root)
    if (rootIdx < 0) return null

    let degrees: number[]
    let name: string
    const custom = s?.customTuning
    if (custom && typeof custom.id === 'string' && custom.id.startsWith('custom:')) {
      // An explicit custom tuning that's malformed is an error, not a silent
      // fallback — the user meant a specific scale.
      if (!isValidDegrees(custom.degrees)) return null
      degrees = custom.degrees
      name = typeof custom.label === 'string' && custom.label ? custom.label : 'Custom'
    } else {
      const b = getBuiltin(typeof s?.drone?.tuningId === 'string' ? s.drone.tuningId : null)
      degrees = b.degrees
      name = b.label
    }

    // Period-aware split: the trailing entry is the repeat period, the rest are
    // the sounding degrees within one period.
    const period = degrees[degrees.length - 1]
    const scaleCents = degrees.slice(0, degrees.length - 1)
    // Reuse the audio-boundary validator so an import can never yield a scale the
    // engine would reject anyway.
    if (!resolveTuning(scaleCents, period, 0).custom) return null

    return { root: rootIdx, tuning: { name, scaleCents, period } }
  } catch {
    return null
  }
}

/** Fetch + decode an mdrone share link into a tuning, or null on any failure. */
export async function importTuningFromUrl(url: string): Promise<ImportedTuning | null> {
  try {
    const extracted = extractPayloadFromUrl(url)
    if (!extracted) return null
    const scene = await decodePayload(extracted.payload, extracted.compressed)
    return sceneToImportedTuning(scene)
  } catch {
    return null
  }
}

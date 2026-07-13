/**
 * mvox tuning glue — the curated preset list and `.scl` importer that feed the
 * HARMONY/FOLLOW tuning selector. Both derive from the vendored tuning-core so
 * they can never drift from mdrone. The `mdrone share-link` importer lives in
 * ./linkImport; the degree math in ./dsp/microtuning.
 */

import type { TuningSpec } from './contracts'
import { resolveTuning } from './dsp/microtuning'
import { BUILTIN_PORTABLE_TUNINGS } from '../vendor/tuning-core/builtins'
import { parseScl } from '../vendor/tuning-core/scala'

/** The empty scale = "12-TET, snapped by the current Scale mode" (legacy path). */
export const DEFAULT_TUNING_PRESET: TuningSpec = { name: 'Default', scaleCents: [], period: 1200 }

/**
 * Tuning options shown in the selector: the Default first, then the vendored
 * builtin scales as period-aware specs (tonicHz is dropped — it derives from the
 * key root at play time).
 */
export const TUNING_PRESETS: readonly TuningSpec[] = [
  DEFAULT_TUNING_PRESET,
  ...BUILTIN_PORTABLE_TUNINGS.map((t) => ({
    name: t.name,
    scaleCents: [...t.scaleCents],
    period: t.period ?? 1200,
  })),
]

/**
 * Parse a Scala `.scl` file into a TuningSpec. Throws on a malformed file
 * (`parseScl` rejects) or a scale the engine would refuse — the caller surfaces
 * the error rather than silently importing nothing.
 */
export function importSclText(text: string): TuningSpec {
  const scl = parseScl(text)
  const spec: TuningSpec = {
    name: scl.name || 'Imported',
    scaleCents: [...scl.cents],
    period: scl.period,
  }
  if (!resolveTuning(spec.scaleCents, spec.period, 0).custom) {
    throw new Error('mvox: .scl scale is not a valid ascending tuning')
  }
  return spec
}

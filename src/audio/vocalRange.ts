// Vocal-range presets → pitch-tracker Hz bounds. Pure + Node-testable. Used by the
// UI: picking a range sets tracking.minHz/maxHz; the engine only ever reads those
// Hz bounds, so the presets are a convenience layer, tuning-agnostic (they bound
// the YIN search in Hz and say nothing about scale/microtuning).
//
// Bounds are rough singer tessituras padded a little for comfort. 'all' is the
// wide default; 'custom' has no fixed bounds (the user drives min/max directly).

import type { VocalRange } from './contracts'

export interface HzRange {
  minHz: number
  maxHz: number
}

// E2..F4 (bass) up through C4..C6 (soprano); 'all' spans the useful vocal band.
export const RANGE_BOUNDS: Record<Exclude<VocalRange, 'custom'>, HzRange> = {
  all: { minHz: 70, maxHz: 1000 },
  bass: { minHz: 80, maxHz: 350 },
  tenor: { minHz: 100, maxHz: 520 },
  alto: { minHz: 160, maxHz: 700 },
  soprano: { minHz: 250, maxHz: 1050 },
}

/** Hz bounds for a preset, or null for 'custom' (caller keeps the current min/max). */
export function boundsForRange(preset: VocalRange): HzRange | null {
  return preset === 'custom' ? null : RANGE_BOUNDS[preset]
}

/**
 * Reverse map: which preset (if any) exactly matches these bounds, else 'custom'.
 * Lets the UI show the right selection after a min/max is restored or nudged.
 */
export function rangeForBounds(minHz: number, maxHz: number): VocalRange {
  for (const key of Object.keys(RANGE_BOUNDS) as Exclude<VocalRange, 'custom'>[]) {
    const b = RANGE_BOUNDS[key]
    if (b.minHz === minHz && b.maxHz === maxHz) return key
  }
  return 'custom'
}

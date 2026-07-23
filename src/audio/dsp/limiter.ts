// True output-ceiling shaper for the Web Audio graph.
//
// The graph's DynamicsCompressorNode does smooth, musical gain reduction near the
// ceiling, but a compressor is NOT a dependable peak ceiling: its finite attack
// (a few ms) lets the leading edge of a transient through, and its "threshold"
// is a compression knee, not a hard limit. To make "limiter ceiling" mean what it
// says — output magnitude never exceeds the chosen dBFS — we follow the
// compressor with a WaveShaperNode whose transfer curve saturates to exactly the
// ceiling. This module builds that curve. It is pure and Node-testable; the node
// wiring lives in AudioEngine.
//
// Property guarantees (covered by limiter.test.ts):
//   1. |output| <= ceilingLinear for every input in [-1, 1] (and, because a
//      WaveShaper clamps out-of-range input to the curve endpoints, for every
//      input outside [-1, 1] too — so master gains > 1 can't breach the ceiling).
//   2. transparent (output === input) while |input| stays below the soft knee, so
//      normal-level material is unaffected.

/** dBFS ceiling → linear amplitude. -Inf-safe; clamped to a sane (0, 1] range. */
export function ceilingToLinear(ceilingDb: number): number {
  if (!Number.isFinite(ceilingDb)) return 1
  const lin = Math.pow(10, ceilingDb / 20)
  if (!Number.isFinite(lin) || lin <= 0) return 1e-4
  return Math.min(1, lin)
}

// Knee width as a fraction of the ceiling: the top KNEE_FRACTION of the range
// eases toward the ceiling with a slope that reaches zero exactly at the ceiling,
// so the brickwall corner isn't a hard edge (less harsh than pure clipping) while
// still guaranteeing the bound.
const KNEE_FRACTION = 0.15

/**
 * Soft-ceiling transfer for a single sample. Identity below the knee; eases to
 * exactly `c` at |x| == c; flat `c` beyond. Monotone and continuous.
 */
export function limiterShape(x: number, c: number): number {
  if (!Number.isFinite(x)) return 0
  const s = x < 0 ? -1 : 1
  const ax = x < 0 ? -x : x
  const kStart = c * (1 - KNEE_FRACTION)
  if (ax <= kStart) return x
  if (ax >= c) return s * c
  // Ease-out quadratic across the knee: slope 0 at the ceiling, so the corner is
  // rounded. eased(0)=0, eased(1)=1.
  const t = (ax - kStart) / (c - kStart)
  const eased = 1 - (1 - t) * (1 - t)
  return s * (kStart + (c - kStart) * eased)
}

/**
 * Build a WaveShaperNode transfer curve sampling `limiterShape` across the node's
 * [-1, 1] input domain. `n` is the table resolution (odd so exactly one sample
 * lands on 0, keeping the curve symmetric and DC-clean).
 */
export function buildLimiterCurve(ceilingDb: number, n = 2049): Float32Array<ArrayBuffer> {
  const size = n % 2 === 0 ? n + 1 : n
  const c = ceilingToLinear(ceilingDb)
  // Back the table with a concrete ArrayBuffer so the result matches
  // WaveShaperNode.curve's non-shared Float32Array type without a cast.
  const curve = new Float32Array(new ArrayBuffer(size * Float32Array.BYTES_PER_ELEMENT))
  for (let i = 0; i < size; i += 1) {
    const x = (i / (size - 1)) * 2 - 1
    curve[i] = limiterShape(x, c)
  }
  return curve
}

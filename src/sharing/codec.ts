/**
 * Backend-free share codec: an MvoxPatch ⇆ a self-contained URL fragment.
 *
 * Share links carry the PATCH only, never audio, and live in the URL hash so the
 * payload never hits a server. The pipeline is deliberately simple for v1:
 *
 *   patch → sanitizePatch → JSON → encodeURIComponent → btoa  (encode)
 *   atob → decodeURIComponent → JSON.parse → sanitizePatch      (decode)
 *
 * Unlike mchord we skip integer-index compaction: the patch is small enough that
 * plain JSON keeps the link readable and the code obvious. `btoa` needs Latin-1,
 * and encodeURIComponent guarantees an ASCII-safe string, so the pair round-trips
 * arbitrary Unicode safely and stays dependency-free. If the patch ever grew
 * large, a compress step (lz-string/DEFLATE) would slot in exactly around btoa/atob.
 *
 * Every decode routes through sanitizePatch() so a hand-crafted or corrupted link
 * can never inject out-of-range values or a malformed shape into the DSP core.
 */
import { sanitizePatch, type MvoxPatch } from '../audio/contracts'

/** Stable URL-fragment param key: `…#p=<payload>`. */
export const FRAGMENT_KEY = 'p'

/** Compact-format version. Independent of PATCH_VERSION; bump on wire-format
 *  changes (e.g. if v2 introduces index compaction). Sanitize tolerates old links. */
export const COMPACT_VERSION = 1

// ---------------------------------------------------------------------------
// Base64 over Unicode-safe JSON
// ---------------------------------------------------------------------------

function utf8ToBase64(str: string): string {
  // encodeURIComponent → %XX escapes → unescape gives a Latin-1 string btoa accepts.
  return btoa(unescape(encodeURIComponent(str)))
}

function base64ToUtf8(b64: string): string {
  return decodeURIComponent(escape(atob(b64)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a patch into a URL-fragment-safe base64 string. Sanitises first so a
 * link can never carry garbage — only a valid, in-range patch is ever shared.
 */
export function encodePatch(patch: MvoxPatch): string {
  const clean = sanitizePatch(patch)
  return utf8ToBase64(JSON.stringify(clean))
}

/**
 * Decode a share string back into a valid MvoxPatch, or null on garbage. Never
 * throws — base64 and JSON failures return null, and any object that does decode
 * is finalised through sanitizePatch so out-of-range fields are clamped.
 */
export function decodePatch(str: string | null | undefined): MvoxPatch | null {
  if (typeof str !== 'string' || str.length === 0) return null
  let json: string
  try {
    json = base64ToUtf8(str)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  // Only objects can describe a patch; arrays/primitives are rejected outright.
  if (!isRecord(parsed)) return null
  return sanitizePatch(parsed)
}

/** Build a full share URL with the patch in a `#p=` fragment. */
export function patchToShareUrl(patch: MvoxPatch, baseUrl: string): string {
  return `${baseUrl}#${FRAGMENT_KEY}=${encodePatch(patch)}`
}

/**
 * Extract and decode a patch from a location.hash string. Accepts a bare
 * fragment (`#p=…` or `p=…`); the fragment may carry multiple `&`-separated
 * params. Returns null if the `p=` param is absent or invalid.
 */
export function patchFromUrl(hash: string): MvoxPatch | null {
  if (typeof hash !== 'string') return null
  // Take everything after the first '#', if present; otherwise the whole string.
  const hashIndex = hash.indexOf('#')
  const fragment = hashIndex >= 0 ? hash.slice(hashIndex + 1) : hash

  for (const part of fragment.split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq) === FRAGMENT_KEY) {
      return decodePatch(part.slice(eq + 1))
    }
  }
  return null
}

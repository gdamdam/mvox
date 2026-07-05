/**
 * Backend-free share codec: an MvoxPatch ⇆ a self-contained URL fragment.
 *
 * Share links carry the PATCH only, never audio, and live in the URL hash so the
 * payload never hits a server. The pipeline is deliberately simple for v1:
 *
 *   patch → sanitizePatch → JSON → utf8 base64url → `<ver>.<payload>`   (encode)
 *   strip `<ver>.` → base64url → JSON.parse → sanitizePatch            (decode)
 *
 * The payload is base64url (RFC 4648 §5: `+/`→`-_`, no `=` padding) so it survives
 * a URL fragment untouched — encodeURIComponent leaves it byte-for-byte. Decode
 * still accepts the old standard alphabet (and any percent-escaping an intermediary
 * added) so existing links keep working. A leading `<COMPACT_VERSION>.` marker lets
 * a future decoder tell wire formats apart; unmarked (legacy) links decode as v1.
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
import { migratePatch } from '../persistence/schema'

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
  // Then map to base64url so the payload needs no percent-escaping in a URL fragment.
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64ToUtf8(b64: string): string {
  // Accept both alphabets: base64url (-_) and the legacy standard alphabet (+/).
  // '-'/'_' never appear in standard base64, so the reverse map is a safe no-op there.
  let std = b64.replace(/-/g, '+').replace(/_/g, '/')
  // Restore stripped '=' padding to a multiple of 4 (atob wants it).
  const pad = std.length % 4
  if (pad === 2) std += '=='
  else if (pad === 3) std += '='
  return decodeURIComponent(escape(atob(std)))
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
  // Prefix the wire-format version so a future decoder can tell v1 links apart.
  return `${COMPACT_VERSION}.${utf8ToBase64(JSON.stringify(clean))}`
}

/**
 * Decode a share string back into a valid MvoxPatch, or null on garbage. Never
 * throws — base64 and JSON failures return null, and any object that does decode
 * is finalised through sanitizePatch so out-of-range fields are clamped.
 */
export function decodePatch(str: string | null | undefined): MvoxPatch | null {
  if (typeof str !== 'string' || str.length === 0) return null
  // An intermediary may have percent-escaped the fragment value (old links carry
  // +, /, = which get %-encoded); undo that first. A malformed escape leaves it as-is.
  let raw = str
  try {
    raw = decodeURIComponent(str)
  } catch {
    // keep the original string; base64 decode below will reject it if truly broken
  }
  // Strip an optional `<version>.` marker. base64url/base64 never contain '.', so a
  // dot unambiguously fronts a version; a legacy (unmarked) link is treated as v1.
  let payload = raw
  const dot = raw.indexOf('.')
  if (dot >= 0) {
    const version = Number(raw.slice(0, dot))
    if (Number.isInteger(version)) {
      if (version !== COMPACT_VERSION) return null // unknown/future wire format
      payload = raw.slice(dot + 1)
    }
  }
  let json: string
  try {
    json = base64ToUtf8(payload)
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
  // Same trust boundary as file import: migratePatch rejects a link written by a
  // NEWER client (future PATCH_VERSION) instead of silently stripping its fields.
  try {
    return migratePatch(parsed)
  } catch {
    return null
  }
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

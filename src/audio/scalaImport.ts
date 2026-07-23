/**
 * Guarded entrypoint for importing Scala `.scl` files (DEFECT #11).
 *
 * The actual parser lives in the VENDORED src/vendor/tuning-core/scala.ts,
 * which is byte-identical to the mdrone sibling repo and drift-guarded by
 * `npm run vendored:check`. Size/DoS limits must therefore live OUTSIDE that
 * file, in this thin non-vendored wrapper: it enforces caps, then delegates to
 * the untouched vendored `parseScl`.
 *
 * Callers that import untrusted `.scl` text (currently src/audio/tuning.ts's
 * `importSclText`, which calls `parseScl` directly) should route through
 * `parseSclGuarded` instead. The return shape is identical to `parseScl`, so
 * the swap is a one-line import change.
 */

import { parseScl, type SclData } from '../vendor/tuning-core/scala'

// A real .scl file is a short text list of pitches — even a 1000-note scale is
// only ~15 KB. 512 Ki chars is orders of magnitude above anything legitimate
// yet small enough that splitting/scanning it can never stall the UI thread.
// We measure JS string length (UTF-16 code units, O(1)) rather than encoded
// bytes so the guard itself does no work proportional to a huge input.
export const MAX_SCL_TEXT_CHARS = 512 * 1024

// The .scl header declares a note count that the parser trusts to slice and
// loop over. A malicious/corrupt file can declare an enormous count; we reject
// it up front (before any per-note work) with a specific message. 4096 degrees
// is far beyond any real scale (Scala's own archive tops out in the low
// thousands) while keeping the bound generous.
export const MAX_SCL_NOTE_COUNT = 4096

/**
 * Parse a `.scl` file after enforcing input-size limits. Throws a friendly,
 * actionable Error when a limit is exceeded; otherwise behaves exactly like the
 * vendored `parseScl` (same SclData result, same errors for malformed files).
 */
export function parseSclGuarded(text: string): SclData {
  if (typeof text !== 'string') {
    throw new Error('mvox: .scl input is not text')
  }
  if (text.length > MAX_SCL_TEXT_CHARS) {
    throw new Error(
      `mvox: .scl file is too large (${text.length} characters; limit ${MAX_SCL_TEXT_CHARS}). ` +
        'Please import a normal Scala scale file.',
    )
  }
  // Peek at the declared note count and reject an absurd value before the
  // vendored parser does any per-note allocation/looping. Mirrors the vendored
  // comment-stripping (lines beginning with `!`) just enough to read line 2 (the
  // count). Splitting is bounded because the text length is already capped.
  const contentLines = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('!'))
  if (contentLines.length >= 2) {
    const declared = Number.parseInt(contentLines[1].trim(), 10)
    if (Number.isInteger(declared) && declared > MAX_SCL_NOTE_COUNT) {
      throw new Error(
        `mvox: .scl declares ${declared} notes (limit ${MAX_SCL_NOTE_COUNT}). ` +
          'This does not look like a real scale file.',
      )
    }
  }
  return parseScl(text)
}

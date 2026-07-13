/**
 * mdrone share-link decoder — the reader half of mdrone's URL share codec, so
 * mvox can import a tuning straight from a pasted mdrone link ("harmonize your
 * voice in your mdrone tuning"). Ported from ../mraga/src/shareCodec.ts, which
 * mirrors ../mdrone/src/shareCodec.ts. Decode-only: mvox never writes these links.
 *
 * Zero dependencies — native `DecompressionStream("deflate")`, `atob`,
 * `TextDecoder`. Every input crosses a trust boundary, so payload size is capped
 * (a deflate-bomb guard) and malformed data throws rather than resolving to junk.
 */

/** Decode url-safe base64 (`-_`, no padding) to bytes. */
export function urlSafeB64ToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const MAX_INFLATED_BYTES = 256 * 1024
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const stream = new Response(bytes as unknown as BodyInit).body!.pipeThrough(ds)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > MAX_INFLATED_BYTES) {
        await reader.cancel()
        throw new Error('mvox: decompressed share payload too large')
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Pull the share payload from an mdrone URL: `?z=` = deflate-compressed,
 *  `?b=` = plain. Returns null when neither param is present. */
export function extractPayloadFromUrl(url: string): { payload: string; compressed: boolean } | null {
  const u = new URL(url)
  // mdrone carries the payload in the URL HASH fragment (`#?z=…`), so also parse
  // params that live after the '#'. Fall back to the query string.
  const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
  const params = hash.includes('=') ? new URLSearchParams(hash.replace(/^\?/, '')) : u.searchParams
  const z = params.get('z')
  if (z) return { payload: z, compressed: true }
  const b = params.get('b')
  if (b) return { payload: b, compressed: false }
  return null
}

const MAX_PAYLOAD_CHARS = 32 * 1024
export async function decodePayload(payload: string, compressed: boolean): Promise<unknown> {
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_CHARS) {
    throw new Error('mvox: share payload too large')
  }
  let bytes = urlSafeB64ToBytes(payload)
  if (compressed) {
    try {
      bytes = await inflate(bytes)
    } catch (e) {
      if (e instanceof Error && /too large/.test(e.message)) throw e
      throw new Error('mvox: failed to decompress share payload', { cause: e })
    }
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (e) {
    throw new Error('mvox: share payload is not valid JSON', { cause: e })
  }
}

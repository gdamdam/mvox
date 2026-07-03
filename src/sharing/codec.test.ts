import { describe, expect, it } from 'vitest'
import { DEFAULT_PATCH, sanitizePatch, type MvoxPatch } from '../audio/contracts'
import {
  COMPACT_VERSION,
  FRAGMENT_KEY,
  decodePatch,
  encodePatch,
  patchFromUrl,
  patchToShareUrl,
} from './codec'

// Latin-1 base64 of a JSON string, mirroring the codec's utf8ToBase64. Lets tests
// forge arbitrary (including tampered) payloads without importing the private helper.
const toPayload = (obj: unknown): string => btoa(unescape(encodeURIComponent(JSON.stringify(obj))))

describe('codec', () => {
  it('exposes stable format constants', () => {
    expect(FRAGMENT_KEY).toBe('p')
    expect(COMPACT_VERSION).toBe(1)
  })

  it('round-trips the default patch (deep-equal to sanitized original)', () => {
    const decoded = decodePatch(encodePatch(DEFAULT_PATCH))
    expect(decoded).toEqual(sanitizePatch(DEFAULT_PATCH))
  })

  it('round-trips a mutated patch', () => {
    const mutated: MvoxPatch = {
      ...DEFAULT_PATCH,
      name: 'My Preset ✨',
      mode: 'harmony',
      shared: { ...DEFAULT_PATCH.shared, keyRoot: 7, scaleMode: 'dorian' },
      harmony: { ...DEFAULT_PATCH.harmony, voiceCount: 4, intervals: [3, 5, -2, 8] },
    }
    const decoded = decodePatch(encodePatch(mutated))
    expect(decoded).toEqual(sanitizePatch(mutated))
  })

  it('handles garbage input without throwing (null or valid patch)', () => {
    for (const bad of [null, undefined, '', 'not-base64!!!', 'e30=']) {
      expect(() => decodePatch(bad)).not.toThrow()
      const out = decodePatch(bad)
      // Either rejected (null) or salvaged into a fully-valid patch.
      if (out !== null) expect(out).toEqual(sanitizePatch(out))
    }
  })

  it('decodes an empty object to the default-sanitized patch', () => {
    // 'e30=' is base64 for '{}' — a valid object, so it becomes the default patch.
    expect(decodePatch('e30=')).toEqual(sanitizePatch({}))
  })

  it('rejects a non-object JSON payload as null', () => {
    expect(decodePatch(toPayload([1, 2, 3]))).toBeNull()
    expect(decodePatch(toPayload(42))).toBeNull()
    expect(decodePatch(toPayload('hi'))).toBeNull()
  })

  it('builds a share URL and round-trips it through the hash', () => {
    const url = patchToShareUrl(DEFAULT_PATCH, 'https://mvox.app/')
    expect(url).toContain(`#${FRAGMENT_KEY}=`)
    const payload = url.split(`#${FRAGMENT_KEY}=`)[1]
    // Simulate a hash carrying extra params after the patch.
    const decoded = patchFromUrl(`#${FRAGMENT_KEY}=${payload}&x=1`)
    expect(decoded).toEqual(sanitizePatch(DEFAULT_PATCH))
  })

  it('patchFromUrl returns null when the p= param is absent', () => {
    expect(patchFromUrl('#foo=bar')).toBeNull()
    expect(patchFromUrl('')).toBeNull()
  })

  it('round-trips non-ASCII names through a full share URL', () => {
    const unicode: MvoxPatch = { ...DEFAULT_PATCH, name: '日本語 🎹 café — ✨' }
    const url = patchToShareUrl(unicode, 'https://mvox.app/')
    expect(patchFromUrl(url)).toEqual(sanitizePatch(unicode))
  })

  it('emits a version-marked, URL-safe payload (no +, /, = or %-escaping)', () => {
    const payload = encodePatch(DEFAULT_PATCH)
    expect(payload.startsWith(`${COMPACT_VERSION}.`)).toBe(true)
    // base64url + version marker must survive a URL fragment untouched.
    expect(payload).not.toMatch(/[+/=]/)
    expect(encodeURIComponent(payload)).toBe(payload)
  })

  it('rejects a payload marked with an unknown wire-format version', () => {
    const body = encodePatch(DEFAULT_PATCH).split('.')[1]
    expect(decodePatch(`2.${body}`)).toBeNull()
    expect(decodePatch(`${COMPACT_VERSION}.${body}`)).toEqual(sanitizePatch(DEFAULT_PATCH))
  })

  it('decodes legacy old-alphabet (unmarked) links containing +//=', () => {
    // '>>>' forces a '+' into standard base64 — the exact char an intermediary mangles.
    const legacyPatch: MvoxPatch = { ...DEFAULT_PATCH, name: 'mvox>>>' }
    const legacy = toPayload(legacyPatch) // standard alphabet, padded, no version marker
    expect(legacy).toMatch(/[+/=]/)
    expect(decodePatch(legacy)).toEqual(sanitizePatch(legacyPatch))
  })

  it('decodes a fragment an intermediary percent-encoded (legacy +//=)', () => {
    const legacyPatch: MvoxPatch = { ...DEFAULT_PATCH, name: 'mvox>>>' }
    const legacy = toPayload(legacyPatch)
    // Simulate any hop that percent-escapes the fragment value: +→%2B, /→%2F, =→%3D.
    const escaped = encodeURIComponent(legacy)
    expect(escaped).not.toBe(legacy)
    expect(decodePatch(escaped)).toEqual(sanitizePatch(legacyPatch))
    // And through the hash-parsing path.
    expect(patchFromUrl(`#${FRAGMENT_KEY}=${escaped}`)).toEqual(sanitizePatch(legacyPatch))
  })

  it('clamps a tampered payload with out-of-range values', () => {
    // Hand-forge a link claiming absurd values; sanitize must clamp them.
    const tampered = toPayload({
      shared: { keyRoot: 999, masterGain: 50 },
      vocoder: { bands: 9999 },
      harmony: { voiceCount: -10, intervals: [500, 0, 0, 0] },
    })
    const out = decodePatch(tampered)
    expect(out).not.toBeNull()
    // keyRoot range is 0–11; masterGain 0–1.5; bands 8–32; voiceCount 0–4.
    expect(out!.shared.keyRoot).toBeLessThanOrEqual(11)
    expect(out!.shared.keyRoot).toBeGreaterThanOrEqual(0)
    expect(out!.shared.masterGain).toBeLessThanOrEqual(1.5)
    expect(out!.vocoder.bands).toBeLessThanOrEqual(32)
    expect(out!.harmony.voiceCount).toBeGreaterThanOrEqual(0)
    expect(out!.harmony.voiceCount).toBeLessThanOrEqual(4)
    // Intervals capped at ±14 scale degrees.
    expect(out!.harmony.intervals[0]).toBeLessThanOrEqual(14)
  })
})

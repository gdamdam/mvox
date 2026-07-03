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

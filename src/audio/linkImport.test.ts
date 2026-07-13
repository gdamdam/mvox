import { describe, expect, it } from 'vitest'
import { importTuningFromUrl, sceneToImportedTuning } from './linkImport'

// Build the url-safe base64 an mdrone `?b=` (uncompressed) share link carries.
// Scenes are ASCII, so btoa (Latin-1) round-trips them without Buffer.
function b64url(json: string): string {
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function bLink(scene: unknown): string {
  return `https://mdrone.mpump.live/#?b=${b64url(JSON.stringify(scene))}`
}
// Build a compressed `?z=` link the same way mdrone does (native deflate).
async function zLink(scene: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(scene))
  const cs = new CompressionStream('deflate')
  const compressed = new Uint8Array(
    await new Response(new Response(bytes).body!.pipeThrough(cs)).arrayBuffer(),
  )
  let bin = ''
  for (const byte of compressed) bin += String.fromCharCode(byte)
  const payload = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `https://mdrone.mpump.live/#?z=${payload}`
}

const BP_PERIOD = 1200 * Math.log2(3)
const BP_STEP = BP_PERIOD / 13
// Legacy [scaleCents…, period] degrees array: 13 sounding degrees + the period.
const BP_DEGREES = [...Array.from({ length: 13 }, (_, i) => i * BP_STEP), BP_PERIOD]

describe('sceneToImportedTuning', () => {
  it('imports a custom non-octave scale, splitting the trailing period out', () => {
    const scene = {
      drone: { root: 'D', octave: 4, tuningId: null },
      customTuning: { id: 'custom:bp', label: 'My Bohlen-Pierce', degrees: BP_DEGREES },
    }
    const imported = sceneToImportedTuning(scene)
    expect(imported).not.toBeNull()
    expect(imported!.root).toBe(2) // D
    expect(imported!.tuning.name).toBe('My Bohlen-Pierce')
    expect(imported!.tuning.period).toBeCloseTo(BP_PERIOD, 6)
    expect(imported!.tuning.scaleCents).toHaveLength(13) // period entry dropped
    expect(imported!.tuning.scaleCents[0]).toBe(0)
  })

  it('imports a builtin tuningId reference by resolving its vendored degrees', () => {
    const scene = { drone: { root: 'A', octave: 4, tuningId: 'just5' } }
    const imported = sceneToImportedTuning(scene)
    expect(imported).not.toBeNull()
    expect(imported!.root).toBe(9) // A
    expect(imported!.tuning.period).toBe(1200)
    // Just 5-limit major third degree survives.
    expect(imported!.tuning.scaleCents).toContain(386.31)
  })

  it('returns null for a missing/invalid root (state must stay unchanged)', () => {
    expect(sceneToImportedTuning({ drone: { root: 'H', octave: 4 } })).toBeNull()
    expect(sceneToImportedTuning({ drone: { octave: 4 } })).toBeNull()
    expect(sceneToImportedTuning({})).toBeNull()
    expect(sceneToImportedTuning(null)).toBeNull()
  })

  it('returns null when custom degrees are malformed', () => {
    const scene = {
      drone: { root: 'C', octave: 4 },
      customTuning: { id: 'custom:x', degrees: [10, 20, 30] }, // not rooted at 0
    }
    expect(sceneToImportedTuning(scene)).toBeNull()
  })
})

describe('importTuningFromUrl', () => {
  it('decodes a valid uncompressed (?b=) mdrone link', async () => {
    const scene = {
      drone: { root: 'G', octave: 3, tuningId: null },
      customTuning: { id: 'custom:1', label: 'Penta', degrees: [0, 240, 480, 720, 960, 1200] },
    }
    const imported = await importTuningFromUrl(bLink(scene))
    expect(imported).not.toBeNull()
    expect(imported!.root).toBe(7) // G
    expect(imported!.tuning.scaleCents).toEqual([0, 240, 480, 720, 960])
    expect(imported!.tuning.period).toBe(1200)
  })

  it('decodes a valid compressed (?z=) mdrone link', async () => {
    const scene = { drone: { root: 'C', octave: 4, tuningId: 'slendro' } }
    const imported = await importTuningFromUrl(await zLink(scene))
    expect(imported).not.toBeNull()
    expect(imported!.root).toBe(0)
    expect(imported!.tuning.scaleCents.length).toBeGreaterThan(0)
  })

  it('returns null for garbage, non-mdrone, or payload-less URLs', async () => {
    expect(await importTuningFromUrl('not a url')).toBeNull()
    expect(await importTuningFromUrl('https://example.com/#foo=bar')).toBeNull()
    expect(await importTuningFromUrl('https://mdrone.mpump.live/#?b=%%%not-base64%%%')).toBeNull()
  })
})

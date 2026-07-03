import { describe, it, expect } from 'vitest'
import {
  MODES,
  NOTE_NAMES,
  mod12,
  scaleSemitones,
  scalePitchClasses,
  snapMidiToScale,
  diatonicHarmony,
  hzToMidi,
  midiToHz,
  centsOff,
  type Mode,
} from './scale'

describe('constants', () => {
  it('MODES is append-only and chromatic is last (share-codec index stability)', () => {
    expect(MODES).toEqual([
      'major',
      'natural-minor',
      'dorian',
      'mixolydian',
      'phrygian',
      'lydian',
      'harmonic-minor',
      'chromatic',
    ])
  })

  it('NOTE_NAMES maps pitch class to name, C=0 … B=11', () => {
    expect(NOTE_NAMES).toHaveLength(12)
    expect(NOTE_NAMES[0]).toBe('C')
    expect(NOTE_NAMES[9]).toBe('A')
    expect(NOTE_NAMES[11]).toBe('B')
  })
})

describe('mod12', () => {
  it('normalises negatives and overflow to 0–11', () => {
    expect(mod12(0)).toBe(0)
    expect(mod12(12)).toBe(0)
    expect(mod12(-1)).toBe(11)
    expect(mod12(25)).toBe(1)
  })
  it('never returns NaN for non-finite input', () => {
    expect(mod12(NaN)).toBe(0)
    expect(mod12(Infinity)).toBe(0)
  })
})

describe('scaleSemitones / scalePitchClasses', () => {
  it('C major pitch classes', () => {
    expect(scalePitchClasses(0, 'major')).toEqual([0, 2, 4, 5, 7, 9, 11])
  })
  it('A natural-minor pitch classes (relative minor of C major)', () => {
    expect(scalePitchClasses(9, 'natural-minor')).toEqual([9, 11, 0, 2, 4, 5, 7])
  })
  it('D dorian pitch classes', () => {
    expect(scalePitchClasses(2, 'dorian')).toEqual([2, 4, 5, 7, 9, 11, 0])
  })
  it('chromatic yields all 12 pitch classes', () => {
    expect(scaleSemitones('chromatic')).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ])
    expect(scalePitchClasses(3, 'chromatic')).toHaveLength(12)
  })
})

describe('snapMidiToScale', () => {
  it('snaps out-of-scale C#(61) to nearest, tie resolves DOWN to C(60)', () => {
    // C# sits exactly between C and D; spec requires the lower note.
    expect(snapMidiToScale(61, 0, 'major')).toBe(60)
  })
  it('leaves an in-scale note unchanged', () => {
    expect(snapMidiToScale(64, 0, 'major')).toBe(64) // E4 is diatonic
  })
  it('chromatic passthrough leaves the (rounded) note unchanged', () => {
    expect(snapMidiToScale(61, 0, 'chromatic')).toBe(61)
    expect(snapMidiToScale(61.4, 0, 'chromatic')).toBe(61)
  })
  it('chooses the nearest octave placement, not just nearest class', () => {
    // F#(66) in C major snaps up to G(67), not down to F(65)? F#->F and ->G are
    // equidistant, tie resolves down to F(65).
    expect(snapMidiToScale(66, 0, 'major')).toBe(65)
  })
  it('is idempotent: snap(snap(x)) === snap(x)', () => {
    for (const midi of [59, 60, 61, 66, 70, 73]) {
      const once = snapMidiToScale(midi, 0, 'major')
      expect(snapMidiToScale(once, 0, 'major')).toBe(once)
    }
  })
})

describe('diatonicHarmony', () => {
  it('+2 degrees from C4(60) in C major → E4(64)', () => {
    expect(diatonicHarmony(60, 0, 'major', 2)).toBe(64)
  })
  it('-1 degree from C4(60) in C major → B3(59)', () => {
    expect(diatonicHarmony(60, 0, 'major', -1)).toBe(59)
  })
  it('+7 degrees wraps exactly one octave → C5(72)', () => {
    expect(diatonicHarmony(60, 0, 'major', 7)).toBe(72)
  })
  it('-3 degrees from C4 wraps down across the octave → F3(53)', () => {
    // Degrees down from C: B3, A3, G3 => G3 is 55. Wait: -1=B3(59), -2=A3(57),
    // -3=G3(55).
    expect(diatonicHarmony(60, 0, 'major', -3)).toBe(55)
  })
  it('offset 0 returns the snapped note', () => {
    expect(diatonicHarmony(61, 0, 'major', 0)).toBe(60)
  })
  it('chromatic treats one degree as one semitone', () => {
    expect(diatonicHarmony(60, 0, 'chromatic', 3)).toBe(63)
  })
  it('+2 degrees from A4(69) in A major → C#5(73), crossing the pc wrap', () => {
    // A major pcs=[9,11,1,2,4,6,8] wraps 11->1 mid-scale; the interval must
    // stay ascending (+4 semitones), not drop an octave.
    expect(diatonicHarmony(69, 9, 'major', 2)).toBe(73)
  })
  it('+1 degree from F#4(66) in G major → G4(67), crossing the octave wrap', () => {
    expect(diatonicHarmony(66, 7, 'major', 1)).toBe(67)
  })
  it('-1 degree from A4(69) in A major → G#4(68), descending across the wrap', () => {
    expect(diatonicHarmony(69, 9, 'major', -1)).toBe(68)
  })
})

describe('hz / midi / cents', () => {
  it('hzToMidi/midiToHz round-trip at A4 (440→69→440)', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 10)
    expect(midiToHz(69)).toBeCloseTo(440, 10)
    expect(midiToHz(hzToMidi(440))).toBeCloseTo(440, 10)
  })
  it('centsOff of 440Hz vs midi 69 ≈ 0', () => {
    expect(centsOff(440, 69)).toBeCloseTo(0, 10)
  })
  it('a note one semitone sharp is ~100 cents', () => {
    expect(centsOff(midiToHz(70), 69)).toBeCloseTo(100, 6)
  })
})

describe('robustness: all outputs finite, never NaN', () => {
  const modes: Mode[] = [...MODES]
  it('handles non-finite and extreme inputs', () => {
    for (const mode of modes) {
      for (const root of [0, 5, 11, -3, 15]) {
        expect(Number.isFinite(snapMidiToScale(NaN, root, mode))).toBe(true)
        expect(Number.isFinite(diatonicHarmony(NaN, root, mode, 2))).toBe(true)
        expect(Number.isFinite(snapMidiToScale(60.7, root, mode))).toBe(true)
      }
    }
    expect(Number.isFinite(hzToMidi(0))).toBe(true)
    expect(Number.isFinite(hzToMidi(-100))).toBe(true)
    expect(Number.isFinite(midiToHz(Infinity))).toBe(true)
    expect(Number.isFinite(centsOff(0, 69))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest';
import {
  clampOctave,
  isEditableTarget,
  MAX_OCTAVE,
  MIN_OCTAVE,
  midiForCode,
  NOTE_CODES,
  semitoneForCode,
} from './layout';

describe('semitoneForCode', () => {
  it('maps white home-row keys to the C-major scale', () => {
    expect(semitoneForCode('KeyA')).toBe(0);
    expect(semitoneForCode('KeyS')).toBe(2);
    expect(semitoneForCode('KeyK')).toBe(12);
  });

  it('maps black upper-row keys to sharps', () => {
    expect(semitoneForCode('KeyW')).toBe(1);
    expect(semitoneForCode('KeyO')).toBe(13);
  });

  it('returns null for the intentional black-key gaps (E/F and B/C)', () => {
    expect(semitoneForCode('KeyR')).toBeNull();
    expect(semitoneForCode('KeyI')).toBeNull();
  });

  it('returns null for random / non-note keys', () => {
    expect(semitoneForCode('Space')).toBeNull();
    expect(semitoneForCode('Enter')).toBeNull();
    expect(semitoneForCode('KeyQ')).toBeNull();
  });
});

describe('NOTE_CODES integrity', () => {
  it('has no duplicate semitone collisions among note codes', () => {
    const semis = Object.values(NOTE_CODES);
    expect(new Set(semis).size).toBe(semis.length);
  });
});

describe('midiForCode', () => {
  it('places middle C (KeyA at octave 4) at MIDI 60', () => {
    expect(midiForCode('KeyA', 4)).toBe(60);
  });

  it('shifts up an octave (KeyA at octave 5) to MIDI 72', () => {
    expect(midiForCode('KeyA', 5)).toBe(72);
  });

  it('returns null for non-note keys', () => {
    expect(midiForCode('KeyR', 4)).toBeNull();
    expect(midiForCode('Space', 4)).toBeNull();
  });

  it('clamps the octave before computing MIDI', () => {
    // octave 99 clamps to MAX_OCTAVE (8): 12*(8+1)+0 = 108.
    expect(midiForCode('KeyA', 99)).toBe(12 * (MAX_OCTAVE + 1));
    // octave -99 clamps to MIN_OCTAVE (0): 12*(0+1)+0 = 12.
    expect(midiForCode('KeyA', -99)).toBe(12 * (MIN_OCTAVE + 1));
  });
});

describe('isEditableTarget', () => {
  it('is true for text-editable form elements', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
  });

  it('is true for contentEditable elements', () => {
    expect(
      isEditableTarget({ isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  it('is false for non-editable elements and null', () => {
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('clampOctave', () => {
  it('clamps below MIN_OCTAVE and above MAX_OCTAVE', () => {
    expect(clampOctave(MIN_OCTAVE - 5)).toBe(MIN_OCTAVE);
    expect(clampOctave(MAX_OCTAVE + 5)).toBe(MAX_OCTAVE);
    expect(clampOctave(4)).toBe(4);
  });
});

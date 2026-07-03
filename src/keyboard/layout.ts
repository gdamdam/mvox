// Ableton-style computer-keyboard note layout.
//
// Pure, framework-free module: no React, no DOM globals at import time, so it
// is fully unit-testable under Node/Vitest. We key everything off
// `event.code` (physical key position) rather than `event.key` because
// `event.key` changes with keyboard layout (QWERTY/AZERTY) and modifier
// state, whereas the piano metaphor is spatial — the physical key positions
// are what map to notes.

/**
 * Physical key code -> semitone offset from the base C.
 *
 * White keys live on the home row (A S D F G H J K) and black keys on the
 * upper row (W E _ T Y U _ O), mirroring a piano octave:
 *
 *   black:   W  E     T  Y  U     O
 *   white:  A  S  D  F  G  H  J  K
 *   semis:  0  2  4  5  7  9  11 12   (white)
 *              1  3     6  8  10   13 (black)
 *
 * The gaps in the upper row (KeyR between E/F, KeyI between B/C) are
 * intentionally unmapped: a real keyboard has no black key between E–F or
 * B–C, so those upper-row keys produce no note.
 */
export const NOTE_CODES: Readonly<Record<string, number>> = Object.freeze({
  // White keys — home row (C major scale, one octave inclusive of the top C).
  KeyA: 0, // C
  KeyS: 2, // D
  KeyD: 4, // E
  KeyF: 5, // F
  KeyG: 7, // G
  KeyH: 9, // A
  KeyJ: 11, // B
  KeyK: 12, // C (octave up)
  // Black keys — upper row.
  KeyW: 1, // C#
  KeyE: 3, // D#
  // (KeyR unmapped — no black key between E and F)
  KeyT: 6, // F#
  KeyY: 8, // G#
  KeyU: 10, // A#
  // (KeyI unmapped — no black key between B and C)
  KeyO: 13, // C# (octave up)
});

/** Returns the semitone offset for a note key, or null for non-note keys. */
export function semitoneForCode(code: string): number | null {
  // Use hasOwnProperty semantics via `in` on the frozen own-keys object; a
  // missing code (e.g. 'KeyR', 'KeyI', 'Space') yields null rather than
  // undefined so callers get an explicit "not a note" signal.
  return code in NOTE_CODES ? NOTE_CODES[code] : null;
}

export const OCTAVE_DOWN_CODE = 'KeyZ';
export const OCTAVE_UP_CODE = 'KeyX';
export const VELOCITY_DOWN_CODE = 'KeyC';
export const VELOCITY_UP_CODE = 'KeyV';

export const MIN_OCTAVE = 0;
export const MAX_OCTAVE = 8;

/** Clamp a base-octave number into the supported [MIN_OCTAVE, MAX_OCTAVE] range. */
export function clampOctave(o: number): number {
  // Guard against NaN/non-finite input collapsing the clamp: fall back to a
  // sane middle octave so a stray value can never produce a NaN MIDI note.
  if (!Number.isFinite(o)) return MIN_OCTAVE;
  const truncated = Math.trunc(o);
  return Math.min(MAX_OCTAVE, Math.max(MIN_OCTAVE, truncated));
}

/**
 * MIDI note number for a note key at a given base octave, or null.
 *
 * Convention: C at octave N is MIDI 12*(N+1), so C4 = 60 (middle C). The base
 * octave is clamped first, then the semitone offset is added. If the result
 * still falls outside the valid MIDI range 0..127 it returns null.
 */
export function midiForCode(code: string, octave: number): number | null {
  const semitone = semitoneForCode(code);
  if (semitone === null) return null;
  const baseC = 12 * (clampOctave(octave) + 1);
  const midi = baseC + semitone;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * True when the event target is a text-editable element (INPUT/TEXTAREA/SELECT
 * or contentEditable). Note keys must NOT fire while the user is typing into a
 * form field, so key handlers should bail early when this returns true.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  // We only read a couple of shape properties, so narrow structurally instead
  // of depending on the DOM lib's HTMLElement (keeps this Node-testable).
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  if (typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

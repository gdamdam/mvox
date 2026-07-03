// Pure inbound MIDI message decoder. No I/O, no DOM.
//
// Adapted from mchord's src/midi/parse.ts. mvox only needs note on/off to drive
// the carrier, so this variant collapses everything that is not a note event
// into `{ type: 'other' }` and normalizes velocity to 0..1 for the audio engine.
//
// Byte conventions: status & 0xf0 = message type, status & 0x0f = channel.
// A Note On with velocity 0 is treated as a Note Off (running-status idiom).
// Live Web MIDI always delivers a complete message with its status byte, so
// running status (used in offline .mid files) does not occur here.

// Status nibbles
const NOTE_OFF = 0x80
const NOTE_ON = 0x90

/**
 * A decoded inbound MIDI event. `note` is clamped to 0..127 and `velocity` is
 * normalized to 0..1 (raw data byte / 127) so the audio engine never sees a
 * raw MIDI 0..127 value.
 */
export type MidiEvent =
  | { type: 'noteon'; note: number; velocity: number }
  | { type: 'noteoff'; note: number }
  | { type: 'other' }

/**
 * Decode one raw MIDI message.
 *
 * - Note On with velocity 0 → `noteoff` (running-status convention).
 * - Note Off → `noteoff`.
 * - Everything else (CC, aftertouch, pitch bend, clock, SysEx) → `other`.
 *
 * Tolerates empty/short/junk buffers: a buffer that does not begin with a
 * status byte, or has no decodable note type, returns `{ type: 'other' }`.
 */
export function parseMidi(data: Uint8Array | number[]): MidiEvent {
  if (!data || data.length === 0) return { type: 'other' }

  const status = data[0] ?? 0

  // A status byte always has its high bit set. A buffer beginning with a data
  // byte (sliced payload or non-compliant driver) is not decodable.
  if ((status & 0x80) === 0) return { type: 'other' }

  // status & 0xf0 selects the message type; the low nibble (channel) is ignored
  // because mvox is a single monophonic-ish carrier that plays any channel.
  const type = status & 0xf0

  switch (type) {
    case NOTE_ON: {
      // Note On carries status + note + velocity; a truncated message is not
      // decodable and must not fabricate a note-off that kills a held note.
      if (data.length < 3) return { type: 'other' }
      const note = data[1] & 0x7f
      const velocity = (data[2] & 0x7f) / 127
      // A Note On at zero velocity is the idiomatic Note Off.
      if (velocity === 0) return { type: 'noteoff', note }
      return { type: 'noteon', note, velocity }
    }
    case NOTE_OFF: {
      // Note Off carries status + note + release velocity; the release byte is
      // discarded but a truncated message is still undecodable.
      if (data.length < 3) return { type: 'other' }
      const note = data[1] & 0x7f
      return { type: 'noteoff', note }
    }
    default:
      return { type: 'other' }
  }
}

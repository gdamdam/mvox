// Pure inbound MIDI message decoder. No I/O, no DOM.
//
// Adapted from mchord's src/midi/parse.ts. Decodes note on/off (to drive the
// carrier) plus the channel-voice messages MIDI-learn needs — CC, pitch bend,
// and channel pressure — carrying the channel on each. Values are normalized
// (velocity/CC/pressure to 0..1, pitch bend to -1..1) so the audio engine and
// mapping layer never see raw MIDI 0..127 / 0..16383 values.
//
// Byte conventions: status & 0xf0 = message type, status & 0x0f = channel.
// A Note On with velocity 0 is treated as a Note Off (running-status idiom).
// Live Web MIDI always delivers a complete message with its status byte, so
// running status (used in offline .mid files) does not occur here.

// Status nibbles
const NOTE_OFF = 0x80
const NOTE_ON = 0x90
const CONTROL_CHANGE = 0xb0
const PROGRAM_CHANGE = 0xc0
const CHANNEL_PRESSURE = 0xd0
const PITCH_BEND = 0xe0
// Continuous controller number for the sustain (damper) pedal.
const CC_SUSTAIN = 0x40
// MIDI CC convention: >= 64 is "on" (pedal down), < 64 is "off".
const CC_ON_THRESHOLD = 64
// Pitch bend is a 14-bit value 0..16383 with 8192 as center (no bend).
const PITCH_BEND_CENTER = 8192

/**
 * A decoded inbound MIDI event. `note` is clamped to 0..127 and `velocity` is
 * normalized to 0..1 (raw data byte / 127) so the audio engine never sees a
 * raw MIDI 0..127 value. Every channel-voice event carries `channel` (0..15,
 * from the status low nibble) so subscribers can filter or MIDI-learn per port.
 */
export type MidiEvent =
  | { type: 'noteon'; note: number; velocity: number; channel: number }
  | { type: 'noteoff'; note: number; channel: number }
  | { type: 'sustain'; on: boolean; channel: number }
  | { type: 'cc'; controller: number; value: number; channel: number } // value normalized 0..1
  | { type: 'pitchbend'; value: number; channel: number } // value -1..1, 0 = center
  | { type: 'pressure'; value: number; channel: number } // channel pressure, 0..1
  | { type: 'program'; program: number; channel: number } // program change, program 0..127
  | { type: 'other' }

/**
 * Decode one raw MIDI message.
 *
 * - Note On with velocity 0 → `noteoff` (running-status convention).
 * - Note Off → `noteoff`.
 * - CC 64 (sustain/damper pedal) → `sustain` (on when value >= 64).
 * - Every other CC → `cc` (value normalized 0..1) for MIDI-learn.
 * - Pitch bend → `pitchbend` (value -1..1, 0 = center).
 * - Channel pressure → `pressure` (value 0..1).
 * - Program change → `program` (program 0..127) to recall a performance slot.
 * - Everything else (aftertouch by key, clock, SysEx) → `other`.
 *
 * Tolerates empty/short/junk buffers: a buffer that does not begin with a
 * status byte, or has no decodable type, returns `{ type: 'other' }`.
 */
export function parseMidi(data: Uint8Array | number[]): MidiEvent {
  if (!data || data.length === 0) return { type: 'other' }

  const status = data[0] ?? 0

  // A status byte always has its high bit set. A buffer beginning with a data
  // byte (sliced payload or non-compliant driver) is not decodable.
  if ((status & 0x80) === 0) return { type: 'other' }

  // status & 0xf0 selects the message type; status & 0x0f is the channel (0..15).
  const type = status & 0xf0
  const channel = status & 0x0f

  switch (type) {
    case NOTE_ON: {
      // Note On carries status + note + velocity; a truncated message is not
      // decodable and must not fabricate a note-off that kills a held note.
      if (data.length < 3) return { type: 'other' }
      const note = data[1] & 0x7f
      const velocity = (data[2] & 0x7f) / 127
      // A Note On at zero velocity is the idiomatic Note Off.
      if (velocity === 0) return { type: 'noteoff', note, channel }
      return { type: 'noteon', note, velocity, channel }
    }
    case NOTE_OFF: {
      // Note Off carries status + note + release velocity; the release byte is
      // discarded but a truncated message is still undecodable.
      if (data.length < 3) return { type: 'other' }
      const note = data[1] & 0x7f
      return { type: 'noteoff', note, channel }
    }
    case CONTROL_CHANGE: {
      // CC carries status + controller + value. The sustain pedal keeps its
      // dedicated 'sustain' role; every other controller decodes to 'cc' with a
      // normalized value so subscribers can MIDI-learn it (mod wheel, etc.).
      if (data.length < 3) return { type: 'other' }
      const controller = data[1] & 0x7f
      if (controller === CC_SUSTAIN)
        return { type: 'sustain', on: (data[2] & 0x7f) >= CC_ON_THRESHOLD, channel }
      return { type: 'cc', controller, value: (data[2] & 0x7f) / 127, channel }
    }
    case PROGRAM_CHANGE: {
      // Program change carries status + one program byte; truncated is
      // undecodable. Used to recall a performance slot from a controller.
      if (data.length < 2) return { type: 'other' }
      return { type: 'program', program: data[1] & 0x7f, channel }
    }
    case CHANNEL_PRESSURE: {
      // Channel pressure carries status + one pressure byte; truncated is
      // undecodable.
      if (data.length < 2) return { type: 'other' }
      return { type: 'pressure', value: (data[1] & 0x7f) / 127, channel }
    }
    case PITCH_BEND: {
      // Pitch bend carries status + LSB + MSB (14-bit, 0..16383, center 8192).
      // Normalize to -1..1; 16383 lands just above +1, which is fine for a knob.
      if (data.length < 3) return { type: 'other' }
      const raw = (data[1] & 0x7f) | ((data[2] & 0x7f) << 7)
      return { type: 'pitchbend', value: (raw - PITCH_BEND_CENTER) / PITCH_BEND_CENTER, channel }
    }
    default:
      return { type: 'other' }
  }
}

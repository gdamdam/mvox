/**
 * Pure, framework-free 16-bit PCM WAV encoder.
 *
 * No React/DOM/Vite imports so it runs unchanged under Node (Vitest) and the
 * browser. Used to export master recordings to a downloadable .wav.
 */

const BYTES_PER_SAMPLE = 16 / 8; // 16-bit PCM => 2 bytes per sample
const BITS_PER_SAMPLE = 16;
const AUDIO_FORMAT_PCM = 1; // WAVE_FORMAT_PCM
const HEADER_SIZE = 44; // canonical RIFF/WAVE header: 12 (RIFF) + 24 (fmt) + 8 (data)

/**
 * Convert a normalized float sample in [-1, 1] to a signed 16-bit integer.
 *
 * WHY: the positive and negative ranges of int16 are asymmetric (32767 vs
 * -32768), so we scale by a different magnitude per sign after clamping. NaN /
 * Infinity are coerced to silence to avoid emitting garbage that would surface
 * as clicks or corrupt the file.
 */
function floatToInt16(sample: number): number {
  if (!Number.isFinite(sample)) {
    return 0;
  }
  // Clamp to [-1, 1] before scaling so out-of-range input saturates instead of
  // wrapping around when written as a 16-bit int.
  const clamped = Math.max(-1, Math.min(1, sample));
  // Math.round (not truncation) so 1.0 maps exactly to the int16 extreme and
  // rounding is symmetric about zero.
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Encode one or more equal-length channels of float audio into a canonical
 * 16-bit PCM WAV file.
 *
 * @param channels Non-empty array of Float32Array, one per channel (1 = mono,
 *   2 = stereo). All channels must have identical length (frame count).
 * @param sampleRate Positive finite integer sample rate in Hz.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (channels.length === 0) {
    throw new Error("encodeWav: channels must contain at least one channel");
  }

  const numChannels = channels.length;
  const numFrames = channels[0].length;

  // Validate equal length up front: interleaving assumes a shared frame count,
  // and a mismatch here would silently read past the end of a short channel.
  for (let c = 1; c < numChannels; c += 1) {
    if (channels[c].length !== numFrames) {
      throw new Error(
        `encodeWav: all channels must have equal length (channel 0 has ${numFrames}, ` +
          `channel ${c} has ${channels[c].length})`,
      );
    }
  }

  if (!Number.isFinite(sampleRate) || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodeWav: sampleRate must be a positive finite integer, got ${sampleRate}`);
  }

  const blockAlign = numChannels * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign; // == sampleRate * numChannels * 2
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(HEADER_SIZE + dataSize);
  const view = new DataView(buffer);

  // --- RIFF chunk descriptor ---
  writeAscii(view, 0, "RIFF");
  // ChunkSize: size of everything after this field == 4 ("WAVE") + fmt (24) +
  // data (8 + dataSize) == 36 + dataSize.
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");

  // --- fmt sub-chunk ---
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, AUDIO_FORMAT_PCM, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  // --- data sub-chunk ---
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave: for each frame, write every channel's sample in order. Samples
  // are little-endian signed 16-bit, the canonical PCM layout.
  let offset = HEADER_SIZE;
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      view.setInt16(offset, floatToInt16(channels[c][frame]), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return buffer;
}

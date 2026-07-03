import { describe, expect, it } from "vitest";
import { encodeWav } from "./wav";

/** Read a 4-byte ASCII magic string at the given offset. */
function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

describe("encodeWav", () => {
  it("writes RIFF/WAVE/fmt /data magic strings at the correct offsets", () => {
    const view = new DataView(encodeWav([new Float32Array([0, 0])], 44100));
    expect(readAscii(view, 0, 4)).toBe("RIFF");
    expect(readAscii(view, 8, 4)).toBe("WAVE");
    expect(readAscii(view, 12, 4)).toBe("fmt ");
    expect(readAscii(view, 36, 4)).toBe("data");
  });

  it("writes a correct header for mono", () => {
    const numFrames = 5;
    const sampleRate = 44100;
    const view = new DataView(encodeWav([new Float32Array(numFrames)], sampleRate));

    expect(view.getUint16(20, true)).toBe(1); // audioFormat = PCM
    expect(view.getUint16(22, true)).toBe(1); // numChannels
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 1 * 2); // byteRate
    expect(view.getUint16(32, true)).toBe(1 * 2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // bitsPerSample
    expect(view.getUint32(16, true)).toBe(16); // fmt subchunk size
  });

  it("writes a correct header for stereo", () => {
    const numFrames = 5;
    const sampleRate = 48000;
    const view = new DataView(
      encodeWav([new Float32Array(numFrames), new Float32Array(numFrames)], sampleRate),
    );

    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2); // numChannels
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 2 * 2); // byteRate
    expect(view.getUint16(32, true)).toBe(2 * 2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("computes data chunk length and total file size correctly", () => {
    const numFrames = 10;
    const buffer = encodeWav([new Float32Array(numFrames), new Float32Array(numFrames)], 44100);
    const view = new DataView(buffer);
    const blockAlign = 2 * 2;
    const dataLen = numFrames * blockAlign;

    expect(view.getUint32(40, true)).toBe(dataLen); // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + dataLen); // RIFF chunk size
    expect(buffer.byteLength).toBe(44 + dataLen); // total file size
  });

  it("round-trips known sample values to the right int16 (mono)", () => {
    const view = new DataView(encodeWav([new Float32Array([1.0, -1.0, 0])], 44100));
    // Data begins at offset 44; each sample is 2 bytes, little-endian signed.
    expect(view.getInt16(44, true)).toBe(32767); // 1.0
    expect(view.getInt16(46, true)).toBe(-32768); // -1.0
    expect(view.getInt16(48, true)).toBe(0); // 0
  });

  it("clamps out-of-range samples and coerces NaN to silence", () => {
    const view = new DataView(
      encodeWav([new Float32Array([2.0, -2.0, Number.NaN, Number.POSITIVE_INFINITY])], 44100),
    );
    expect(view.getInt16(44, true)).toBe(32767); // 2.0 clamps to +full scale
    expect(view.getInt16(46, true)).toBe(-32768); // -2.0 clamps to -full scale
    expect(view.getInt16(48, true)).toBe(0); // NaN -> 0
    expect(view.getInt16(50, true)).toBe(0); // Infinity -> 0
  });

  it("interleaves stereo samples into the correct byte positions", () => {
    const left = new Float32Array([1.0, 0]);
    const right = new Float32Array([-1.0, 0]);
    const view = new DataView(encodeWav([left, right], 44100));

    // Frame 0: L then R. Frame 1: L then R.
    expect(view.getInt16(44, true)).toBe(32767); // frame 0 left
    expect(view.getInt16(46, true)).toBe(-32768); // frame 0 right
    expect(view.getInt16(48, true)).toBe(0); // frame 1 left
    expect(view.getInt16(50, true)).toBe(0); // frame 1 right
  });

  it("throws on mismatched channel lengths", () => {
    expect(() => encodeWav([new Float32Array(4), new Float32Array(3)], 44100)).toThrow(
      /equal length/,
    );
  });

  it("throws on empty channels array", () => {
    expect(() => encodeWav([], 44100)).toThrow(/at least one channel/);
  });

  it("throws on invalid sample rates", () => {
    const mono = [new Float32Array(2)];
    expect(() => encodeWav(mono, 0)).toThrow(/sampleRate/);
    expect(() => encodeWav(mono, -44100)).toThrow(/sampleRate/);
    expect(() => encodeWav(mono, 44100.5)).toThrow(/sampleRate/);
    expect(() => encodeWav(mono, Number.NaN)).toThrow(/sampleRate/);
  });
});

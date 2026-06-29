import { describe, expect, it } from "vitest";
import OpusScript from "opusscript";
import { TranscriptOpusDecoder } from "../server/transcript/opusDecoder.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960;

const sineFrame = (): Buffer => {
  const buffer = Buffer.alloc(FRAME_SIZE * CHANNELS * 2);
  for (let frame = 0; frame < FRAME_SIZE; frame += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * frame) / SAMPLE_RATE) * 9000,
    );
    buffer.writeInt16LE(sample, frame * 4);
    buffer.writeInt16LE(sample, frame * 4 + 2);
  }
  return buffer;
};

describe("TranscriptOpusDecoder", () => {
  it("decodes a realistic Opus speech frame into 24k mono PCM", () => {
    const encoder = new OpusScript(
      SAMPLE_RATE,
      CHANNELS,
      OpusScript.Application.AUDIO,
    );
    const decoder = new TranscriptOpusDecoder();
    try {
      const encoded = encoder.encode(sineFrame(), FRAME_SIZE);
      const decoded = decoder.decodeTo24kMono(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded!.length).toBeGreaterThan(0);
      expect(decoded!.length % 2).toBe(0);
      expect(
        Array.from({ length: decoded!.length / 2 }).some(
          (_, index) => decoded!.readInt16LE(index * 2) !== 0,
        ),
      ).toBe(true);
    } finally {
      encoder.delete();
      decoder.close();
    }
  });
});

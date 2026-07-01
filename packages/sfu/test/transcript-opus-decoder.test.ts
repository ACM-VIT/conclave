import { describe, expect, it } from "vitest";
import OpusScript from "opusscript";
import { TranscriptOpusDecoder } from "../server/transcript/opusDecoder.js";

const SAMPLE_RATE = 48000;
const MONO_CHANNELS = 1;
const STEREO_CHANNELS = 2;
const FRAME_SIZE = 960;

const sineFrame = (channels: number): Buffer => {
  const buffer = Buffer.alloc(FRAME_SIZE * channels * 2);
  for (let frame = 0; frame < FRAME_SIZE; frame += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * frame) / SAMPLE_RATE) * 9000,
    );
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(sample, (frame * channels + channel) * 2);
    }
  }
  return buffer;
};

const encodeSineFrame = (channels: number): Buffer => {
  const encoder = new OpusScript(
    SAMPLE_RATE,
    channels,
    OpusScript.Application.AUDIO,
  );
  try {
    return encoder.encode(sineFrame(channels), FRAME_SIZE);
  } finally {
    encoder.delete();
  }
};

const expectAudiblePcm = (decoded: Buffer | null): void => {
  expect(decoded).not.toBeNull();
  expect(decoded!.length).toBeGreaterThan(0);
  expect(decoded!.length % 2).toBe(0);
  let sumSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let previousSign = 0;
  const sampleCount = decoded!.length / 2;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = decoded!.readInt16LE(index * 2);
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
    peak = Math.max(peak, Math.abs(normalized));
    const sign = sample === 0 ? previousSign : sample > 0 ? 1 : -1;
    if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
      zeroCrossings += 1;
    }
    previousSign = sign;
  }

  expect(Math.sqrt(sumSquares / sampleCount)).toBeGreaterThan(0.05);
  expect(peak).toBeGreaterThan(0.1);
  expect(zeroCrossings / sampleCount).toBeGreaterThan(0.005);
};

describe("TranscriptOpusDecoder", () => {
  it("decodes a realistic mono Opus speech frame into 24k mono PCM", () => {
    const decoder = new TranscriptOpusDecoder();
    try {
      const encoded = encodeSineFrame(MONO_CHANNELS);
      const decoded = decoder.decodeTo24kMono(encoded);

      expectAudiblePcm(decoded);
    } finally {
      decoder.close();
    }
  });

  it("decodes a realistic stereo Opus speech frame into 24k mono PCM", () => {
    const decoder = new TranscriptOpusDecoder();
    try {
      const encoded = encodeSineFrame(STEREO_CHANNELS);
      const decoded = decoder.decodeTo24kMono(encoded);

      expectAudiblePcm(decoded);
    } finally {
      decoder.close();
    }
  });

  it("keeps decoding after the shared OpusScript WASM heap grows", () => {
    const heapPressure: OpusScript[] = [];
    const decoder = new TranscriptOpusDecoder();
    try {
      const encoded = encodeSineFrame(MONO_CHANNELS);
      for (let index = 0; index < 120; index += 1) {
        heapPressure.push(
          new OpusScript(
            SAMPLE_RATE,
            MONO_CHANNELS,
            OpusScript.Application.AUDIO,
          ),
        );
      }

      const decoded = decoder.decodeTo24kMono(encoded);

      expectAudiblePcm(decoded);
    } finally {
      decoder.close();
      for (const opus of heapPressure) {
        opus.delete();
      }
    }
  });
});

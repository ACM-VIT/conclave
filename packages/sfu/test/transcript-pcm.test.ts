import { describe, expect, it } from "vitest";
import { downsamplePcm16LeTo24kMono } from "../server/transcript/pcm.js";

const stereo48k = (frames: Array<[number, number]>): Buffer => {
  const buffer = Buffer.alloc(frames.length * 4);
  frames.forEach(([left, right], index) => {
    buffer.writeInt16LE(left, index * 4);
    buffer.writeInt16LE(right, index * 4 + 2);
  });
  return buffer;
};

describe("downsamplePcm16LeTo24kMono", () => {
  it("averages stereo channels and every two 48k frames into one 24k mono sample", () => {
    const output = downsamplePcm16LeTo24kMono(
      stereo48k([
        [100, 300],
        [500, 700],
        [-100, -300],
        [-500, -700],
      ]),
      2,
    );

    expect(output.length).toBe(4);
    expect(output.readInt16LE(0)).toBe(400);
    expect(output.readInt16LE(2)).toBe(-400);
  });
});

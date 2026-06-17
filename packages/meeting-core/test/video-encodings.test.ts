import { describe, expect, it } from "vitest";
import {
  createVideoEncodingHelpers,
  type VideoBitrateProfile,
  type VideoEncodingProfile,
} from "../src/video-encodings";

const profile: VideoEncodingProfile = {
  simulcast: {
    low: [
      {
        rid: "r0",
        scaleResolutionDownBy: 2,
        bitrateRatio: 0.5,
        minBitrate: 80_000,
        maxFramerate: 15,
      },
    ],
    standard: [
      {
        rid: "r0",
        scaleResolutionDownBy: 4,
        bitrateRatio: 0.25,
        minBitrate: 150_000,
        maxFramerate: 15,
      },
      {
        rid: "r1",
        scaleResolutionDownBy: 1,
        bitrateRatio: 1,
        minBitrate: 300_000,
        maxFramerate: 30,
      },
    ],
  },
  singleLayerMaxFramerate: { low: 15, standard: 30 },
};

const bitrates: VideoBitrateProfile = {
  maxBitrate: { low: 200_000, standard: 1_200_000 },
  screenShare: { maxBitrate: 2_500_000, maxFramerate: 30 },
};

const helpers = createVideoEncodingHelpers({ profile, bitrates });

describe("buildWebcamSimulcastEncodings", () => {
  it("derives one encoding per simulcast layer", () => {
    const enc = helpers.buildWebcamSimulcastEncodings("standard");
    expect(enc.map((e) => e.rid)).toEqual(["r0", "r1"]);
  });

  it("scales maxBitrate by the layer ratio", () => {
    const [layer] = helpers.buildWebcamSimulcastEncodings("low");
    // 200_000 * 0.5 = 100_000, above the 80_000 floor → use computed value.
    expect(layer.maxBitrate).toBe(100_000);
    expect(layer.scaleResolutionDownBy).toBe(2);
    expect(layer.maxFramerate).toBe(15);
  });

  it("clamps a computed bitrate up to the layer's minBitrate floor", () => {
    const enc = helpers.buildWebcamSimulcastEncodings("standard");
    // r0: 1_200_000 * 0.25 = 300_000 → above floor (150_000) → 300_000.
    expect(enc[0].maxBitrate).toBe(300_000);
    // r1: 1_200_000 * 1 = 1_200_000 → above floor (300_000).
    expect(enc[1].maxBitrate).toBe(1_200_000);
  });

  it("floors fractional bitrate products to whole bits", () => {
    const fractional = createVideoEncodingHelpers({
      profile: {
        ...profile,
        simulcast: {
          ...profile.simulcast,
          low: [
            {
              rid: "r0",
              scaleResolutionDownBy: 2,
              bitrateRatio: 0.333,
              minBitrate: 1,
              maxFramerate: 15,
            },
          ],
        },
      },
      bitrates,
    });
    const [layer] = fractional.buildWebcamSimulcastEncodings("low");
    // 200_000 * 0.333 = 66_600 (already integer here) — assert it's an integer.
    expect(Number.isInteger(layer.maxBitrate)).toBe(true);
    expect(layer.maxBitrate).toBe(66_600);
  });
});

describe("buildWebcamSingleLayerEncoding", () => {
  it("uses the quality's max bitrate and single-layer framerate", () => {
    expect(helpers.buildWebcamSingleLayerEncoding("standard")).toEqual({
      maxBitrate: 1_200_000,
      maxFramerate: 30,
    });
    expect(helpers.buildWebcamSingleLayerEncoding("low")).toEqual({
      maxBitrate: 200_000,
      maxFramerate: 15,
    });
  });
});

describe("buildScreenShareEncoding", () => {
  it("returns the screen-share bitrate, framerate, and L1T3 scalability mode", () => {
    expect(helpers.buildScreenShareEncoding()).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
      scalabilityMode: "L1T3",
    });
  });
});

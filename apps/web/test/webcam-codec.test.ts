import { describe, expect, it } from "vitest";
import type { RtpCodecCapability } from "mediasoup-client/types";
import { getPreferredScreenShareCodec } from "../src/app/lib/webcam-codec";

type ScreenShareCodecDevice = Parameters<
  typeof getPreferredScreenShareCodec
>[0];

const videoCodec = (
  mimeType: string,
  preferredPayloadType: number,
): RtpCodecCapability => ({
  kind: "video" as const,
  mimeType,
  preferredPayloadType,
  clockRate: 90000,
});

describe("getPreferredScreenShareCodec", () => {
  it("keeps VP8 ahead of VP9 for desktop screen shares", () => {
    const device: ScreenShareCodecDevice = {
      rtpCapabilities: {
        codecs: [
          videoCodec("video/VP9", 101),
          videoCodec("video/VP8", 102),
          videoCodec("video/H264", 103),
        ],
      },
    };

    const codec = getPreferredScreenShareCodec(device);

    expect(codec?.mimeType).toBe("video/VP8");
  });

  it("uses VP9 only when the safer screen-share codecs are unavailable", () => {
    const device: ScreenShareCodecDevice = {
      rtpCapabilities: {
        codecs: [videoCodec("video/VP9", 101)],
      },
    };

    const codec = getPreferredScreenShareCodec(device);

    expect(codec?.mimeType).toBe("video/VP9");
  });
});

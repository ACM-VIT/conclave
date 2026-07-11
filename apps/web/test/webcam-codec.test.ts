import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Producer,
  RtpCodecCapability,
  Transport,
} from "mediasoup-client/types";
import {
  getPreferredScreenShareCodec,
  produceScreenShareTrack,
} from "../src/app/lib/webcam-codec";

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

afterEach(() => {
  vi.restoreAllMocks();
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

  it("keeps the preferred codec when only temporal scalability is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const preferredCodec = videoCodec("video/VP8", 102);
    const producer = {} as Producer;
    const produce = vi
      .fn()
      .mockRejectedValueOnce(new Error("unsupported scalability mode"))
      .mockResolvedValueOnce(producer);
    const transport = { produce } as unknown as Transport;
    const track = {
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as MediaStreamTrack;

    await expect(
      produceScreenShareTrack({
        transport,
        track,
        networkProfile: "good",
        preferredCodec,
      }),
    ).resolves.toBe(producer);

    expect(produce).toHaveBeenCalledTimes(2);
    const firstOptions = produce.mock.calls[0]?.[0];
    const secondOptions = produce.mock.calls[1]?.[0];
    expect(firstOptions?.codec).toBe(preferredCodec);
    expect(secondOptions?.codec).toBe(preferredCodec);
    expect(firstOptions?.encodings?.[0]).toHaveProperty("scalabilityMode");
    expect(secondOptions?.encodings?.[0]).not.toHaveProperty(
      "scalabilityMode",
    );
  });
});

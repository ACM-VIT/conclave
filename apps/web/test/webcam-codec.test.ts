import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Producer,
  RtpCodecCapability,
  Transport,
} from "mediasoup-client/types";
import {
  applyScreenShareProducerNetworkProfile,
  applyWebcamProducerNetworkProfile,
  buildWebcamCodecOptions,
  getWebcamSenderRtpPriority,
  getWebcamEncodingCountForQuality,
  getWebcamProducerTopology,
  getPreferredScreenShareCodec,
  isVp9SvcWebcamProducer,
  produceScreenShareTrack,
  produceWebcamTrack,
  requestVideoSenderKeyFrame,
  shouldRecreateWebcamProducerForQuality,
} from "../src/app/lib/webcam-codec";

describe("video sender key-frame requests", () => {
  it("requests every active encoding through the WebRTC extension", async () => {
    const parameters = {
      encodings: [{ rid: "q" }, { rid: "h" }],
      transactionId: "transaction",
    } as RTCRtpSendParameters;
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const sender = {
      getParameters: () => parameters,
      setParameters,
    } as unknown as RTCRtpSender;

    await expect(requestVideoSenderKeyFrame(sender)).resolves.toBe(true);
    expect(setParameters).toHaveBeenCalledWith(parameters, {
      encodingOptions: [{ keyFrame: true }, { keyFrame: true }],
    });
  });

  it("keeps quality switching non-fatal when the extension is unavailable", async () => {
    const sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn().mockRejectedValue(new Error("unsupported")),
    } as unknown as RTCRtpSender;

    await expect(requestVideoSenderKeyFrame(sender)).resolves.toBe(false);
    await expect(
      requestVideoSenderKeyFrame({
        getParameters: () => {
          throw new Error("sender closed");
        },
      } as unknown as RTCRtpSender),
    ).resolves.toBe(false);
    await expect(requestVideoSenderKeyFrame(null)).resolves.toBe(false);
  });

});

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
  it("uses sender capabilities instead of the deprecated receive view", () => {
    const device: ScreenShareCodecDevice = {
      sendRtpCapabilities: {
        codecs: [videoCodec("video/H264", 103)],
      },
      rtpCapabilities: {
        codecs: [videoCodec("video/VP8", 102)],
      },
    };

    expect(getPreferredScreenShareCodec(device)?.mimeType).toBe("video/H264");
  });

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

describe("webcam encoding topology", () => {
  it("negotiates one VP8 encoding from the exact live track with only a server transition", async () => {
    const preferredCodec = videoCodec("video/VP8", 102);
    const track = {
      id: "live-track",
      getSettings: () => ({ width: 1280, height: 720 }),
    } as MediaStreamTrack;
    const producer = {
      kind: "video",
      closed: false,
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8" }],
        encodings: [{}],
      },
    } as unknown as Producer;
    const produce = vi.fn().mockResolvedValue(producer);

    await produceWebcamTrack({
      transport: { produce } as unknown as Transport,
      track,
      quality: "standard",
      networkProfile: "good",
      paused: false,
      preferredCodec,
      forceSingleLayer: true,
      receiverCapacityTransition: {
        fromProducerId: "old-producer",
        nonce: "server-nonce",
      },
    });

    expect(produce).toHaveBeenCalledOnce();
    expect(produce.mock.calls[0]?.[0]).toMatchObject({
      track,
      stopTracks: false,
      encodings: [expect.objectContaining({ maxFramerate: 30 })],
      appData: {
        type: "webcam",
        webcamReceiverCapacityTransition: {
          fromProducerId: "old-producer",
          nonce: "server-nonce",
        },
      },
    });
    expect(getWebcamProducerTopology(producer)).toBe("vp8-single-layer");
  });

  it("does not let a default-codec retry mask a transition ACK timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const preferredCodec = videoCodec("video/VP8", 102);
    const acknowledgementTimeout = new Error(
      "produce acknowledgement timeout",
    );
    const staleNonceRejection = new Error(
      "receiver-capacity transition nonce already used",
    );
    const produce = vi
      .fn()
      .mockRejectedValueOnce(acknowledgementTimeout)
      .mockRejectedValueOnce(staleNonceRejection);
    const track = {
      id: "processed-track",
      getSettings: () => ({ width: 1280, height: 720 }),
    } as MediaStreamTrack;

    await expect(
      produceWebcamTrack({
        transport: { produce } as unknown as Transport,
        track,
        quality: "standard",
        networkProfile: "good",
        paused: false,
        preferredCodec,
        forceSingleLayer: true,
        receiverCapacityTransition: {
          fromProducerId: "old-producer",
          nonce: "one-use-nonce",
        },
      }),
    ).rejects.toBe(acknowledgementTimeout);

    expect(produce).toHaveBeenCalledOnce();
    expect(produce.mock.calls[0]?.[0]).toMatchObject({
      codec: preferredCodec,
      appData: {
        webcamReceiverCapacityTransition: {
          fromProducerId: "old-producer",
          nonce: "one-use-nonce",
        },
      },
    });
  });

  it("retains preferred-to-default codec fallback without a transition", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const preferredCodec = videoCodec("video/VP8", 102);
    const producer = {
      kind: "video",
      closed: false,
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8" }],
        encodings: [{}],
      },
    } as unknown as Producer;
    const produce = vi
      .fn()
      .mockRejectedValueOnce(new Error("preferred codec rejected"))
      .mockResolvedValueOnce(producer);
    const track = {
      id: "ordinary-track",
      getSettings: () => ({ width: 1280, height: 720 }),
    } as MediaStreamTrack;

    await expect(
      produceWebcamTrack({
        transport: { produce } as unknown as Transport,
        track,
        quality: "standard",
        networkProfile: "good",
        paused: false,
        preferredCodec,
        forceSingleLayer: true,
      }),
    ).resolves.toBe(producer);

    expect(produce).toHaveBeenCalledTimes(2);
    expect(produce.mock.calls[0]?.[0]?.codec).toBe(preferredCodec);
    expect(produce.mock.calls[1]?.[0]?.codec).toBeUndefined();
    expect(
      produce.mock.calls[1]?.[0]?.appData
        ?.webcamReceiverCapacityTransition,
    ).toBeUndefined();
  });

  it("forces restoration to the full VP8 simulcast ladder without transition authority", async () => {
    const preferredCodec = videoCodec("video/VP8", 102);
    const track = {
      id: "same-live-track",
      getSettings: () => ({ width: 1280, height: 720 }),
    } as MediaStreamTrack;
    const producer = {
      kind: "video",
      closed: false,
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8" }],
        encodings: [{}, {}, {}],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;
    const produce = vi.fn().mockResolvedValue(producer);

    await produceWebcamTrack({
      transport: { produce } as unknown as Transport,
      track,
      quality: "standard",
      networkProfile: "good",
      paused: false,
      preferredCodec,
      forceSimulcast: true,
    });

    expect(produce.mock.calls[0]?.[0]?.track).toBe(track);
    expect(produce.mock.calls[0]?.[0]?.encodings).toHaveLength(3);
    expect(
      produce.mock.calls[0]?.[0]?.appData
        ?.webcamReceiverCapacityTransition,
    ).toBeUndefined();
    expect(getWebcamProducerTopology(producer)).toBe("vp8-simulcast");
  });

  it("keeps the stable sender-wide priority while entering and leaving sole-receiver VP8", () => {
    expect(getWebcamSenderRtpPriority("good", true)).toBe("medium");
    expect(getWebcamSenderRtpPriority("good", false)).toBe("medium");
  });

  it("publishes negotiated VP9 as one continuous L2T1 SVC encoding", async () => {
    const preferredCodec = videoCodec("video/VP9", 101);
    preferredCodec.parameters = { "profile-id": 0 };
    const producer = {
      kind: "video",
      closed: false,
      rtpParameters: {
        codecs: [{ mimeType: "video/VP9" }],
        encodings: [{ scalabilityMode: "L2T1" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;
    const produce = vi.fn().mockResolvedValue(producer);
    const transport = { produce } as unknown as Transport;
    const track = {
      getSettings: () => ({ width: 1280, height: 720 }),
    } as MediaStreamTrack;

    await produceWebcamTrack({
      transport,
      track,
      quality: "standard",
      networkProfile: "good",
      paused: false,
      preferredCodec,
      codecPolicy: {
        codec: "vp9",
        mimeType: "video/VP9",
        profileId: 0,
        scalabilityMode: "L2T1",
        epoch: 3,
      },
    });

    expect(produce).toHaveBeenCalledTimes(1);
    expect(produce.mock.calls[0]?.[0]).toMatchObject({
      codec: preferredCodec,
      encodings: [
        {
          active: true,
          scalabilityMode: "L2T1",
          maxBitrate: 1_650_000,
          maxFramerate: 30,
        },
      ],
    });
  });

  it("caps VP9 SVC without a simulcast-only spatial-layer renegotiation", async () => {
    let parameters = {
      encodings: [
        {
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 30,
          scalabilityMode: "L2T1",
        },
      ],
    };
    const setParameters = vi.fn().mockImplementation(async (next) => {
      parameters = next;
    });
    const setMaxSpatialLayer = vi.fn().mockResolvedValue(undefined);
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 640, height: 360 }) },
      rtpSender: {
        getParameters: () => parameters,
        setParameters,
      },
      rtpParameters: {
        codecs: [{ mimeType: "video/VP9" }],
        encodings: [{ scalabilityMode: "L2T1" }],
      },
      setMaxSpatialLayer,
    } as unknown as Producer;

    await applyWebcamProducerNetworkProfile(producer, "standard", "fair");

    expect(setMaxSpatialLayer).not.toHaveBeenCalled();
    expect(setParameters).toHaveBeenCalledTimes(1);
    expect(parameters.encodings[0]).toMatchObject({
      active: true,
      maxBitrate: 900_000,
      maxFramerate: 24,
      scaleResolutionDownBy: 1,
      scalabilityMode: "L2T1",
    });
  });

  it("keeps VP9 SVC geometry stable while changing live bandwidth caps", async () => {
    const track = {
      id: "stable-vp9-track",
      getSettings: () => ({ width: 1280, height: 720 }),
    } as MediaStreamTrack;
    let parameters = {
      encodings: [
        {
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 30,
          scalabilityMode: "L2T1",
          scaleResolutionDownBy: 1,
        },
      ],
    };
    const setParameters = vi.fn().mockImplementation(async (next) => {
      parameters = next;
    });
    const producer = {
      kind: "video",
      closed: false,
      track,
      rtpSender: {
        getParameters: () => parameters,
        setParameters,
      },
      rtpParameters: {
        codecs: [{ mimeType: "video/VP9" }],
        encodings: [{ scalabilityMode: "L2T1" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;

    expect(isVp9SvcWebcamProducer(producer)).toBe(true);

    await applyWebcamProducerNetworkProfile(producer, "low", "poor");
    expect(producer.track).toBe(track);
    expect(parameters.encodings[0]).toMatchObject({
      maxBitrate: 160_000,
      maxFramerate: 12,
      scaleResolutionDownBy: 1,
      scalabilityMode: "L2T1",
    });

    await applyWebcamProducerNetworkProfile(producer, "standard", "good");
    expect(producer.track).toBe(track);
    expect(parameters.encodings[0]).toMatchObject({
      maxBitrate: 1_650_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
      scalabilityMode: "L2T1",
    });
    expect(setParameters).toHaveBeenCalledTimes(2);
  });

  it("does not classify a geometry-changing VP9 mode as continuous SVC", () => {
    const producer = {
      kind: "video",
      closed: false,
      rtpParameters: {
        codecs: [{ mimeType: "video/VP9" }],
        encodings: [{ scalabilityMode: "L2T1_KEY" }],
      },
    } as unknown as Producer;

    expect(isVp9SvcWebcamProducer(producer)).toBe(false);
  });

  it("starts healthy 720p senders quickly without overshooting constrained profiles", () => {
    expect(buildWebcamCodecOptions("standard", "good")).toEqual({
      videoGoogleStartBitrate: 1_800,
    });
    expect(buildWebcamCodecOptions("low", "good")).toEqual({
      videoGoogleStartBitrate: 300,
    });
    expect(buildWebcamCodecOptions("standard", "fair")).toEqual({
      videoGoogleStartBitrate: 350,
    });
    expect(buildWebcamCodecOptions("standard", "poor")).toEqual({
      videoGoogleStartBitrate: 90,
    });
    expect(buildWebcamCodecOptions("standard", "emergency")).toEqual({
      videoGoogleStartBitrate: 65,
    });
  });

  it("recreates simulcast producers for both 3-to-2 and 2-to-3 switches", () => {
    expect(getWebcamEncodingCountForQuality("standard", true)).toBe(3);
    expect(getWebcamEncodingCountForQuality("low", true)).toBe(2);
    expect(getWebcamEncodingCountForQuality("standard", false)).toBe(1);

    expect(
      shouldRecreateWebcamProducerForQuality("low", true, 3),
    ).toBe(true);
    expect(
      shouldRecreateWebcamProducerForQuality("standard", true, 2),
    ).toBe(true);
    expect(
      shouldRecreateWebcamProducerForQuality("low", true, 2),
    ).toBe(false);
    expect(
      shouldRecreateWebcamProducerForQuality("standard", true, 3),
    ).toBe(false);
  });

  it("publishes a poor-profile low ladder without changing encoder topology", async () => {
    const preferredCodec = videoCodec("video/VP8", 102);
    const setMaxSpatialLayer = vi.fn().mockResolvedValue(undefined);
    const producer = {
      kind: "video",
      closed: false,
      rtpParameters: { encodings: [{ rid: "q" }, { rid: "f" }] },
      setMaxSpatialLayer,
    } as unknown as Producer;
    const produce = vi.fn().mockResolvedValue(producer);
    const transport = { produce } as unknown as Transport;
    const track = {
      id: "camera-track",
      getSettings: () => ({ width: 426, height: 240 }),
    } as MediaStreamTrack;

    await produceWebcamTrack({
      transport,
      track,
      quality: "low",
      networkProfile: "poor",
      paused: false,
      preferredCodec,
    });

    const encodings = produce.mock.calls[0]?.[0]?.encodings;
    expect(produce.mock.calls[0]?.[0]?.codecOptions).toEqual({
      videoGoogleStartBitrate: 90,
    });
    expect(encodings).toHaveLength(2);
    expect(encodings?.[0]).toMatchObject({
      rid: "q",
      active: true,
      scaleResolutionDownBy: 2,
      maxBitrate: 80_000,
      maxFramerate: 12,
    });
    expect(encodings?.[1]).toMatchObject({
      rid: "f",
      active: true,
      scaleResolutionDownBy: 1,
      maxBitrate: 25_000,
      maxFramerate: 5,
    });
    expect(setMaxSpatialLayer).not.toHaveBeenCalled();
  });

  it("keeps canonical RID geometry and tiny top-layer standby on fair", async () => {
    const preferredCodec = videoCodec("video/VP8", 102);
    const producer = {
      kind: "video",
      closed: false,
      rtpParameters: {
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;
    const produce = vi.fn().mockResolvedValue(producer);
    const transport = { produce } as unknown as Transport;
    const track = {
      id: "fair-camera-track",
      getSettings: () => ({ width: 640, height: 360 }),
    } as MediaStreamTrack;

    await produceWebcamTrack({
      transport,
      track,
      quality: "standard",
      networkProfile: "fair",
      paused: false,
      preferredCodec,
    });

    expect(produce.mock.calls[0]?.[0]?.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        active: true,
        scaleResolutionDownBy: 4,
        maxBitrate: 80_000,
        maxFramerate: 12,
      }),
      expect.objectContaining({
        rid: "h",
        active: true,
        scaleResolutionDownBy: 2,
        maxBitrate: 220_000,
        maxFramerate: 20,
      }),
      expect.objectContaining({
        rid: "f",
        active: true,
        scaleResolutionDownBy: 1,
        maxBitrate: 35_000,
        maxFramerate: 5,
      }),
    ]);
  });

  it("caps a live low ladder without toggling or rescaling its RIDs", async () => {
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const getParameters = vi.fn(() => ({
      encodings: [
        { rid: "q", active: true, scaleResolutionDownBy: 2 },
        { rid: "f", active: true, scaleResolutionDownBy: 1 },
      ],
    }));
    const setMaxSpatialLayer = vi.fn().mockResolvedValue(undefined);
    const producer = {
      kind: "video",
      closed: false,
      track: {
        getSettings: () => ({ width: 426, height: 240 }),
      },
      rtpSender: { getParameters, setParameters },
      rtpParameters: { encodings: [{ rid: "q" }, { rid: "f" }] },
      setMaxSpatialLayer,
    } as unknown as Producer;

    await applyWebcamProducerNetworkProfile(producer, "low", "poor");

    expect(setMaxSpatialLayer).not.toHaveBeenCalled();
    expect(setParameters).toHaveBeenCalledTimes(1);
    const parameters = setParameters.mock.calls[0]?.[0];
    expect(parameters?.encodings?.[0]).toMatchObject({
      rid: "q",
      active: true,
      scaleResolutionDownBy: 2,
      maxBitrate: 80_000,
      maxFramerate: 12,
    });
    expect(parameters?.encodings?.[1]).toMatchObject({
      rid: "f",
      active: true,
      scaleResolutionDownBy: 1,
      maxBitrate: 25_000,
      maxFramerate: 5,
    });
  });

  it.each([
    ["poor", [80_000, 25_000, 15_000], [12, 5, 3]],
    ["emergency", [65_000, 12_000, 8_000], [8, 4, 2]],
  ] as const)(
    "keeps every canonical RID alive under the %s live cap",
    async (profile, expectedBitrates, expectedFramerates) => {
      let currentParameters = {
        encodings: [
          { rid: "q", active: true, scaleResolutionDownBy: 4 },
          { rid: "h", active: true, scaleResolutionDownBy: 2 },
          { rid: "f", active: true, scaleResolutionDownBy: 1 },
        ],
      };
      const setParameters = vi.fn().mockImplementation(async (next) => {
        currentParameters = next;
      });
      const producer = {
        kind: "video",
        closed: false,
        track: { getSettings: () => ({ width: 1280, height: 720 }) },
        rtpSender: {
          getParameters: () => currentParameters,
          setParameters,
        },
        rtpParameters: {
          encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
        },
        setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
      } as unknown as Producer;

      await applyWebcamProducerNetworkProfile(
        producer,
        "standard",
        profile,
      );

      expect(currentParameters.encodings).toEqual([
        expect.objectContaining({
          rid: "q",
          active: true,
          scaleResolutionDownBy: 4,
          maxBitrate: expectedBitrates[0],
          maxFramerate: expectedFramerates[0],
        }),
        expect.objectContaining({
          rid: "h",
          active: true,
          scaleResolutionDownBy: 2,
          maxBitrate: expectedBitrates[1],
          maxFramerate: expectedFramerates[1],
        }),
        expect.objectContaining({
          rid: "f",
          active: true,
          scaleResolutionDownBy: 1,
          maxBitrate: expectedBitrates[2],
          maxFramerate: expectedFramerates[2],
        }),
      ]);
    },
  );

  it("restores canonical layer scales after a constrained profile recovers", async () => {
    let currentParameters = {
      encodings: [
        { rid: "q", active: true, scaleResolutionDownBy: 1 },
        { rid: "h", active: false, scaleResolutionDownBy: 2 },
        { rid: "f", active: false, scaleResolutionDownBy: 1 },
      ],
    };
    const setParameters = vi.fn().mockImplementation(async (next) => {
      currentParameters = next;
    });
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      rtpSender: {
        getParameters: () => currentParameters,
        setParameters,
      },
      rtpParameters: {
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;

    await applyWebcamProducerNetworkProfile(producer, "standard", "good");

    expect(currentParameters.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        active: true,
        scaleResolutionDownBy: 4,
      }),
      expect.objectContaining({
        rid: "h",
        active: true,
        scaleResolutionDownBy: 2,
      }),
      expect.objectContaining({
        rid: "f",
        active: true,
        scaleResolutionDownBy: 1,
      }),
    ]);
  });

  it("keeps sender priority stable while reserving the one-receiver budget for 720p", async () => {
    let currentParameters = {
      encodings: [
        {
          rid: "q",
          active: true,
          scaleResolutionDownBy: 4,
          priority: "low" as RTCPriorityType,
          networkPriority: "low" as RTCPriorityType,
        },
        {
          rid: "h",
          active: true,
          scaleResolutionDownBy: 2,
          priority: "low" as RTCPriorityType,
          networkPriority: "low" as RTCPriorityType,
        },
        {
          rid: "f",
          active: true,
          scaleResolutionDownBy: 1,
          priority: "low" as RTCPriorityType,
          networkPriority: "low" as RTCPriorityType,
        },
      ],
    };
    const setParameters = vi.fn().mockImplementation(async (next) => {
      currentParameters = next;
    });
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      rtpSender: {
        getParameters: () => currentParameters,
        setParameters,
      },
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;

    await applyWebcamProducerNetworkProfile(
      producer,
      "standard",
      "good",
      { optimizeForSingleReceiver: true },
    );

    expect(currentParameters.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        active: true,
        maxBitrate: 35_000,
        maxFramerate: 12,
        priority: "low",
        networkPriority: "low",
      }),
      expect.objectContaining({
        rid: "h",
        active: true,
        maxBitrate: 90_000,
        maxFramerate: 20,
      }),
      expect.objectContaining({
        rid: "f",
        active: true,
        maxBitrate: 1_750_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 1,
      }),
    ]);

    await applyWebcamProducerNetworkProfile(producer, "standard", "good");
    expect(currentParameters.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        active: true,
        maxBitrate: 80_000,
        priority: "low",
        networkPriority: "low",
      }),
      expect.objectContaining({
        rid: "h",
        active: true,
        maxBitrate: 220_000,
        priority: "low",
        networkPriority: "low",
      }),
      expect.objectContaining({
        rid: "f",
        active: true,
        maxBitrate: 1_650_000,
        priority: "low",
        networkPriority: "low",
      }),
    ]);
  });

  it("falls back to fresh cap-only parameters when the preferred update is rejected", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    let currentParameters = {
      encodings: [
        {
          rid: "q",
          active: true,
          scaleResolutionDownBy: 4,
          priority: "low" as RTCPriorityType,
          networkPriority: "low" as RTCPriorityType,
        },
        {
          rid: "h",
          active: true,
          scaleResolutionDownBy: 2,
          priority: "low" as RTCPriorityType,
          networkPriority: "low" as RTCPriorityType,
        },
        {
          rid: "f",
          active: true,
          scaleResolutionDownBy: 1,
          priority: "low" as RTCPriorityType,
          networkPriority: "low" as RTCPriorityType,
        },
      ],
    };
    let attempts = 0;
    const setParameters = vi.fn().mockImplementation(async (next) => {
      attempts += 1;
      if (attempts === 1) throw new Error("sender priority rejected");
      currentParameters = next;
    });
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      rtpSender: {
        getParameters: () => currentParameters,
        setParameters,
      },
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;

    await applyWebcamProducerNetworkProfile(
      producer,
      "standard",
      "good",
      { optimizeForSingleReceiver: true },
    );

    expect(setParameters).toHaveBeenCalledTimes(2);
    expect(setParameters.mock.calls[0]?.[0]?.encodings).toEqual([
      expect.objectContaining({ priority: "low" }),
      expect.objectContaining({ priority: "low" }),
      expect.objectContaining({ priority: "low" }),
    ]);
    expect(currentParameters.encodings).toEqual([
      expect.objectContaining({ rid: "q", active: true, priority: "low" }),
      expect.objectContaining({ rid: "h", active: true, priority: "low" }),
      expect.objectContaining({
        rid: "f",
        active: true,
        maxBitrate: 1_750_000,
        priority: "low",
      }),
    ]);
  });

  it("changes only bitrate across a good-start live VP8 transition", async () => {
    let currentParameters = {
      degradationPreference: "maintain-framerate" as RTCDegradationPreference,
      encodings: [
        {
          rid: "q",
          active: true,
          maxBitrate: 80_000,
          maxFramerate: 12,
          scaleResolutionDownBy: 4,
          priority: "low" as RTCPriorityType,
          networkPriority: "low" as RTCPriorityType,
        },
        {
          rid: "h",
          active: true,
          maxBitrate: 220_000,
          maxFramerate: 20,
          scaleResolutionDownBy: 2,
        },
        {
          rid: "f",
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 30,
          scaleResolutionDownBy: 1,
        },
      ],
    };
    const setParameters = vi.fn().mockImplementation(async (next) => {
      currentParameters = next;
    });
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      rtpSender: {
        getParameters: () => currentParameters,
        setParameters,
      },
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;

    await applyWebcamProducerNetworkProfile(producer, "standard", "poor");
    expect(currentParameters.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        active: true,
        maxBitrate: 80_000,
        maxFramerate: 12,
        priority: "low",
        networkPriority: "low",
      }),
      expect.objectContaining({
        rid: "h",
        active: true,
        maxBitrate: 25_000,
        maxFramerate: 20,
      }),
      expect.objectContaining({
        rid: "f",
        active: true,
        maxBitrate: 15_000,
        maxFramerate: 30,
      }),
    ]);

    await applyWebcamProducerNetworkProfile(producer, "standard", "good");
    expect(currentParameters.encodings).toEqual([
      expect.objectContaining({
        rid: "q",
        active: true,
        maxBitrate: 80_000,
        maxFramerate: 12,
        priority: "low",
        networkPriority: "low",
      }),
      expect.objectContaining({
        rid: "h",
        active: true,
        maxBitrate: 220_000,
        maxFramerate: 20,
      }),
      expect.objectContaining({
        rid: "f",
        active: true,
        maxBitrate: 1_650_000,
        maxFramerate: 30,
      }),
    ]);
    expect(producer.setMaxSpatialLayer).not.toHaveBeenCalled();
  });

  it("does not apply a two-layer low cap table to a live three-layer producer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const getParameters = vi.fn(() => ({
      encodings: [
        { rid: "q", scaleResolutionDownBy: 4 },
        { rid: "h", scaleResolutionDownBy: 2 },
        { rid: "f", scaleResolutionDownBy: 1 },
      ],
    }));
    const producer = {
      kind: "video",
      closed: false,
      track: {
        getSettings: () => ({ width: 640, height: 360 }),
      },
      rtpSender: { getParameters, setParameters },
      rtpParameters: {
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;

    await expect(
      applyWebcamProducerNetworkProfile(producer, "low", "poor"),
    ).rejects.toThrow("Producer recreation is required");

    expect(setParameters).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("incompatible encoding topology"),
      expect.objectContaining({
        quality: "low",
        currentEncodingCount: 3,
        expectedEncodingCount: 2,
      }),
    );
  });

  it("rejects a profile when sender parameters cannot be applied", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const setParameters = vi.fn().mockRejectedValue(
      new Error("setParameters rejected"),
    );
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      rtpSender: {
        getParameters: () => ({
          encodings: [
            { rid: "q", scaleResolutionDownBy: 4 },
            { rid: "h", scaleResolutionDownBy: 2 },
            { rid: "f", scaleResolutionDownBy: 1 },
          ],
        }),
        setParameters,
      },
      rtpParameters: {
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockResolvedValue(undefined),
    } as unknown as Producer;

    await expect(
      applyWebcamProducerNetworkProfile(producer, "standard", "fair"),
    ).rejects.toThrow("setParameters rejected");
    expect(setParameters).toHaveBeenCalledTimes(3);
  });

  it("does not invoke the topology-toggling spatial-layer API", async () => {
    const layerError = new Error("setMaxSpatialLayer rejected");
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      rtpSender: {
        getParameters: () => ({
          encodings: [
            { rid: "q", scaleResolutionDownBy: 4 },
            { rid: "h", scaleResolutionDownBy: 2 },
            { rid: "f", scaleResolutionDownBy: 1 },
          ],
        }),
        setParameters,
      },
      rtpParameters: {
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer: vi.fn().mockRejectedValue(layerError),
    } as unknown as Producer;

    await expect(
      applyWebcamProducerNetworkProfile(producer, "standard", "good"),
    ).resolves.toBeUndefined();
    expect(producer.setMaxSpatialLayer).not.toHaveBeenCalled();
    expect(setParameters).toHaveBeenCalledTimes(1);
  });

  it("uses sender caps only for a constrained simulcast profile", async () => {
    const layerError = new Error("middle layer rejected");
    const setMaxSpatialLayer = vi
      .fn()
      .mockRejectedValueOnce(layerError)
      .mockResolvedValueOnce(undefined);
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const producer = {
      kind: "video",
      closed: false,
      track: { getSettings: () => ({ width: 1280, height: 720 }) },
      rtpSender: {
        getParameters: () => ({
          encodings: [
            { rid: "q", scaleResolutionDownBy: 4 },
            { rid: "h", scaleResolutionDownBy: 2 },
            { rid: "f", scaleResolutionDownBy: 1 },
          ],
        }),
        setParameters,
      },
      rtpParameters: {
        encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }],
      },
      setMaxSpatialLayer,
    } as unknown as Producer;

    await expect(
      applyWebcamProducerNetworkProfile(producer, "standard", "fair"),
    ).resolves.toBeUndefined();
    expect(setMaxSpatialLayer).not.toHaveBeenCalled();
    expect(setParameters).toHaveBeenCalledTimes(1);
  });
});

describe("screen-share network profile application", () => {
  it("applies RTP caps but rejects when capture constraints fail", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const constraintError = new Error("capture constraints rejected");
    const applyConstraints = vi.fn().mockRejectedValue(constraintError);
    const setParameters = vi.fn().mockResolvedValue(undefined);
    const producer = {
      kind: "video",
      closed: false,
      track: {
        readyState: "live",
        applyConstraints,
        getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
      },
      rtpSender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters,
      },
      rtpParameters: { encodings: [{}] },
    } as unknown as Producer;

    await expect(
      applyScreenShareProducerNetworkProfile(producer, "poor"),
    ).rejects.toBe(constraintError);
    expect(applyConstraints).toHaveBeenCalledTimes(2);
    expect(setParameters).toHaveBeenCalledTimes(1);
  });
});

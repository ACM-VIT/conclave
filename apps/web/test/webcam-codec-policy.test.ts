import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachVp9ZeroFrameReproducer,
  BASELINE_WEBCAM_CODEC_POLICY,
  buildBrowserWebcamCodecCapabilities,
  classifyVp9CodecFailure,
  createVp9EncoderNegativeCapabilityCache,
  createVp9ZeroFrameProof,
  detectLoadedDeviceWebcamCodecCapabilities,
  getProvenVp9ZeroFrameStall,
  isNewerWebcamCodecPolicy,
  normalizeWebcamCodecPolicy,
  resolveWebcamCodecRecoveryOverride,
} from "../src/app/lib/webcam-codec-policy";

const capabilities = (...codecs: Array<[string, string?]>) => ({
  codecs: codecs.map(([mimeType, sdpFmtpLine]) => ({
    mimeType,
    sdpFmtpLine,
  })),
});

const installStaticVideoCapabilities = (options: {
  sender: ReturnType<typeof capabilities>;
  receiver: ReturnType<typeof capabilities>;
}) => {
  vi.stubGlobal("RTCRtpSender", {
    getCapabilities: () => options.sender,
  });
  vi.stubGlobal("RTCRtpReceiver", {
    getCapabilities: () => options.receiver,
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser webcam codec negotiation", () => {
  it("advertises VP9 SVC only for a mediasoup handler that supports it", () => {
    const rtpCapabilities = capabilities(
      ["video/VP8"],
      ["video/H264", "packetization-mode=1;profile-level-id=42e01f"],
      ["video/VP9", "profile-id=0"],
    );
    expect(
      buildBrowserWebcamCodecCapabilities({
        handlerName: "Chrome111",
        senderCapabilities: rtpCapabilities,
        receiverCapabilities: rtpCapabilities,
      }),
    ).toEqual({
      webcam: {
      negotiationVersion: 3,
        receive: ["vp8", "h264-cb", "vp9-p0"],
        send: ["vp8", "h264-cb", "vp9-p0-l2t1"],
        preferredBaseline: "vp8",
      },
    });

    expect(
      buildBrowserWebcamCodecCapabilities({
        handlerName: "Safari12",
        senderCapabilities: rtpCapabilities,
        receiverCapabilities: rtpCapabilities,
      }).webcam.send,
    ).toEqual(["vp8", "h264-cb"]);
  });

  it("does not infer profile-0 support from VP9 profile 2", () => {
    const vp9ProfileTwo = capabilities(["video/VP9", "profile-id=2"]);
    expect(
      buildBrowserWebcamCodecCapabilities({
        handlerName: "Chrome111",
        senderCapabilities: vp9ProfileTwo,
        receiverCapabilities: vp9ProfileTwo,
      }),
    ).toEqual({
      webcam: {
      negotiationVersion: 3,
        receive: [],
        send: [],
        preferredBaseline: "vp8",
      },
    });
  });

  it("does not advertise H264 packetization mode 0 or missing FMTP as mode 1", () => {
    const unsupported = capabilities(
      ["video/H264", "packetization-mode=0;profile-level-id=42e01f"],
      ["video/H264"],
      ["video/H264", "packetization-mode=1;profile-level-id=42001f"],
    );
    expect(
      buildBrowserWebcamCodecCapabilities({
        handlerName: "Chrome111",
        senderCapabilities: unsupported,
        receiverCapabilities: unsupported,
      }),
    ).toEqual({
      webcam: {
      negotiationVersion: 3,
        receive: [],
        send: [],
        preferredBaseline: "vp8",
      },
    });
  });

  it("keeps mobile-class handlers off optimistic VP9 and prefers H264", () => {
    const rtpCapabilities = capabilities(
      ["video/VP8"],
      ["video/H264", "packetization-mode=1;profile-level-id=42e01f"],
      ["video/VP9", "profile-id=0"],
    );
    expect(
      buildBrowserWebcamCodecCapabilities({
        handlerName: "Chrome111",
        senderCapabilities: rtpCapabilities,
        receiverCapabilities: rtpCapabilities,
        allowVp9SvcSend: false,
        preferredBaseline: "h264",
      }),
    ).toEqual({
      webcam: {
        negotiationVersion: 3,
        receive: ["vp8", "h264-cb", "vp9-p0"],
        send: ["vp8", "h264-cb"],
        preferredBaseline: "h264",
      },
    });
  });

  it("refines VP9 send support from a loaded device capability intersection", () => {
    const staticCapabilities = capabilities(
      ["video/VP8"],
      ["video/H264", "packetization-mode=1;profile-level-id=42e01f"],
      ["video/VP9", "profile-id=0"],
    );
    installStaticVideoCapabilities({
      sender: staticCapabilities,
      receiver: staticCapabilities,
    });
    const loadedCapabilities = {
      codecs: [
        { mimeType: "video/VP8", parameters: {} },
        { mimeType: "video/VP9", parameters: { "profile-id": 0 } },
        {
          mimeType: "video/H264",
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
          },
        },
      ],
    };
    expect(
      detectLoadedDeviceWebcamCodecCapabilities({
        handlerName: "Chrome111",
        sendRtpCapabilities: loadedCapabilities,
        rtpCapabilities: loadedCapabilities,
      }).webcam,
    ).toEqual({
      negotiationVersion: 3,
      receive: ["vp8", "h264-cb", "vp9-p0"],
      send: ["vp8", "h264-cb", "vp9-p0-l2t1"],
      preferredBaseline: "vp8",
    });
  });

  it("cannot re-add VP9 when the active browser capability surface removes it", () => {
    const loadedCapabilities = {
      codecs: [
        { mimeType: "video/VP8", parameters: {} },
        { mimeType: "video/VP9", parameters: { "profile-id": 0 } },
        {
          mimeType: "video/H264",
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
          },
        },
      ],
    };
    installStaticVideoCapabilities({
      sender: capabilities(["video/VP8"]),
      receiver: capabilities(
        ["video/VP8"],
        ["video/H264", "packetization-mode=1;profile-level-id=42e01f"],
      ),
    });

    expect(
      detectLoadedDeviceWebcamCodecCapabilities({
        handlerName: "Chrome111",
        sendRtpCapabilities: loadedCapabilities,
        rtpCapabilities: loadedCapabilities,
      }).webcam,
    ).toEqual({
      negotiationVersion: 3,
      receive: ["vp8", "h264-cb"],
      send: ["vp8"],
      preferredBaseline: "vp8",
    });
  });

  it("persists only a proven-negative VP9 sender capability for the same session/device", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const firstCache = createVp9EncoderNegativeCapabilityCache(storage);
    const scope = {
      handlerName: "Chrome111",
      videoInputDeviceId: "camera-a",
    };
    firstCache.mark(scope);

    const reconnectedCache = createVp9EncoderNegativeCapabilityCache(storage);
    expect(reconnectedCache.has(scope)).toBe(true);
    expect(
      reconnectedCache.has({ ...scope, videoInputDeviceId: "camera-b" }),
    ).toBe(false);
    expect(
      reconnectedCache.has({ ...scope, handlerName: "Chrome112" }),
    ).toBe(false);

    const rtpCapabilities = capabilities(
      ["video/VP8"],
      ["video/VP9", "profile-id=0"],
    );
    expect(
      buildBrowserWebcamCodecCapabilities({
        handlerName: "Chrome111",
        senderCapabilities: rtpCapabilities,
        receiverCapabilities: rtpCapabilities,
        provenVp9EncoderIncompatibility: true,
      }).webcam,
    ).toEqual({
      negotiationVersion: 3,
      receive: ["vp8", "vp9-p0"],
      send: ["vp8"],
      preferredBaseline: "vp8",
    });
  });

  it("keeps a proven-negative entry in memory when session storage is unavailable", () => {
    const cache = createVp9EncoderNegativeCapabilityCache({
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    });
    const scope = { handlerName: "Firefox120", videoInputDeviceId: "cam" };
    cache.mark(scope);
    expect(cache.has(scope)).toBe(true);
  });

  it("classifies only explicit local VP9 encoder rejection as capability proof", () => {
    expect(
      classifyVp9CodecFailure(
        new DOMException(
          "VP9 L2T1 scalability mode is not supported by this encoder",
          "NotSupportedError",
        ),
      ),
    ).toBe("proven-encoder-incompatibility");
    expect(
      classifyVp9CodecFailure(
        new Error(
          "Room requires VP9 profile 0, but the sender codec is unavailable",
        ),
      ),
    ).toBe("proven-encoder-incompatibility");

    for (const error of [
      new Error("Producer transport closed"),
      new Error("Socket timeout while producing VP9"),
      new Error("ICE connection failed"),
      new Error("Webcam codec does not match current room policy"),
      new Error("Failed to produce video"),
    ]) {
      expect(classifyVp9CodecFailure(error)).toBe("transient-or-unknown");
    }
  });

  it("requires a fresh-track proof and a distinct zero-frame reproducer", () => {
    const proof = createVp9ZeroFrameProof({
      epoch: 7,
      initialProducerId: "producer-a",
      freshTrackId: "fresh-track",
    });
    expect(
      attachVp9ZeroFrameReproducer(proof, {
        epoch: 7,
        producerId: "producer-a",
      }),
    ).toBeNull();

    const reproduced = attachVp9ZeroFrameReproducer(proof, {
      epoch: 7,
      producerId: "producer-b",
    });
    expect(
      getProvenVp9ZeroFrameStall(reproduced, {
        epoch: 7,
        producerId: "producer-b",
        frames: 0,
      }),
    ).toMatchObject({
      kind: "vp9-zero-frame-stall",
      initialProducerId: "producer-a",
      freshTrackId: "fresh-track",
      reproducerProducerId: "producer-b",
    });
    expect(
      getProvenVp9ZeroFrameStall(reproduced, {
        epoch: 8,
        producerId: "producer-b",
        frames: 0,
      }),
    ).toBeNull();
    expect(
      getProvenVp9ZeroFrameStall(reproduced, {
        epoch: 7,
        producerId: "producer-b",
        frames: 1,
      }),
    ).toBeNull();
  });

  it("invalidates recovery overrides when the policy epoch advances", () => {
    const override = {
      policyEpoch: 3,
      codec: "video/VP8",
      forceSingleLayer: true,
    };
    expect(
      resolveWebcamCodecRecoveryOverride(override, {
        ...BASELINE_WEBCAM_CODEC_POLICY,
        epoch: 3,
      }),
    ).toBe(override);
    expect(
      resolveWebcamCodecRecoveryOverride(override, {
        ...BASELINE_WEBCAM_CODEC_POLICY,
        epoch: 4,
      }),
    ).toBeNull();
  });

  it("applies only strictly newer server epochs", () => {
    expect(
      isNewerWebcamCodecPolicy(BASELINE_WEBCAM_CODEC_POLICY, {
        codec: "vp9",
        mimeType: "video/VP9",
        profileId: 0,
        scalabilityMode: "L2T1",
        epoch: 1,
      }),
    ).toBe(true);
    expect(
      isNewerWebcamCodecPolicy(
        { ...BASELINE_WEBCAM_CODEC_POLICY, epoch: 2 },
        { ...BASELINE_WEBCAM_CODEC_POLICY, epoch: 2 },
      ),
    ).toBe(false);
  });

  it("rejects malformed or internally inconsistent server policies", () => {
    expect(
      normalizeWebcamCodecPolicy({
        codec: "vp9",
        mimeType: "video/VP9",
        profileId: 0,
        scalabilityMode: "L2T1",
        epoch: 4,
      }),
    ).toEqual({
      codec: "vp9",
      mimeType: "video/VP9",
      profileId: 0,
      scalabilityMode: "L2T1",
      epoch: 4,
    });
    expect(
      normalizeWebcamCodecPolicy({
        codec: "vp9",
        mimeType: "video/VP9",
        profileId: 0,
        scalabilityMode: "L3T1_KEY",
        epoch: 4,
      }),
    ).toBeNull();
    expect(
      normalizeWebcamCodecPolicy({
        codec: "vp9",
        mimeType: "video/VP8",
        epoch: 4,
      }),
    ).toBeNull();
    expect(
      normalizeWebcamCodecPolicy({
        codec: "vp8",
        mimeType: "video/VP8",
        epoch: -1,
      }),
    ).toBeNull();
  });
});

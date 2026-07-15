import { describe, expect, it } from "vitest";
import {
  buildWebcamCodecPolicy,
  normalizeClientMediaCapabilities,
  participantsSupportWebcamCodec,
  producerMatchesWebcamCodecPolicy,
  selectRoomWebcamCodec,
} from "../server/webcamCodecPolicy.js";

const modernWeb = (id: string) => ({
  id,
  isObserver: false,
  capabilities: normalizeClientMediaCapabilities({
    webcam: {
      negotiationVersion: 3,
      receive: ["vp8", "h264-cb", "vp9-p0"],
      send: ["vp8", "h264-cb", "vp9-p0-l2t1"],
    },
  }),
});

describe("room webcam codec policy", () => {
  it("fails closed across the v2-to-v3 negotiation-version boundary", () => {
    expect(
      normalizeClientMediaCapabilities({
        webcam: {
          negotiationVersion: 1,
          receive: ["vp8", "vp9-p0"],
          send: ["vp8", "vp9-p0-l3t1-key"],
        },
      }),
    ).toBeNull();
  });

  it("selects VP9 only when every receiver and publisher explicitly supports it", () => {
    expect(selectRoomWebcamCodec([modernWeb("a"), modernWeb("b")])).toBe(
      "vp9",
    );

    expect(
      selectRoomWebcamCodec([
        modernWeb("a"),
        { id: "legacy", isObserver: false, capabilities: null },
      ]),
    ).toBe("vp8");

    expect(
      selectRoomWebcamCodec([
        modernWeb("a"),
        {
          id: "decode-only",
          isObserver: false,
          capabilities: normalizeClientMediaCapabilities({
            webcam: {
              negotiationVersion: 3,
              receive: ["vp8", "vp9-p0"],
              send: ["vp8"],
            },
          }),
        },
      ]),
    ).toBe("vp8");
  });

  it("fails closed when a publisher declares only the legacy L3T3 capability", () => {
    const legacyL3T3 = {
      id: "legacy-l3t3",
      isObserver: false,
      capabilities: normalizeClientMediaCapabilities({
        webcam: {
          negotiationVersion: 3,
          receive: ["vp8", "vp9-p0"],
          send: ["vp8", "vp9-p0-l3t3-key"],
        },
      }),
    };

    expect(legacyL3T3.capabilities?.send.has("vp8")).toBe(true);
    expect(legacyL3T3.capabilities?.send.size).toBe(1);
    expect(selectRoomWebcamCodec([modernWeb("modern"), legacyL3T3])).toBe(
      "vp8",
    );
  });

  it("requires observers to decode VP9 but not publish it", () => {
    expect(
      selectRoomWebcamCodec([
        modernWeb("speaker"),
        {
          id: "viewer",
          isObserver: true,
          capabilities: normalizeClientMediaCapabilities({
            webcam: {
              negotiationVersion: 3,
              receive: ["vp8", "vp9-p0"],
              send: [],
            },
          }),
        },
      ]),
    ).toBe("vp9");

    expect(
      selectRoomWebcamCodec([
        modernWeb("speaker"),
        {
          id: "legacy-viewer",
          isObserver: true,
          capabilities: null,
        },
      ]),
    ).toBe("vp8");
  });

  it("distinguishes a mandatory compatibility change from an optional upgrade", () => {
    const modern = [modernWeb("a"), modernWeb("b")];
    expect(participantsSupportWebcamCodec(modern, "vp8")).toBe(true);
    expect(participantsSupportWebcamCodec(modern, "vp9")).toBe(true);

    const withLegacy = [
      ...modern,
      { id: "legacy", isObserver: false, capabilities: null },
    ];
    expect(participantsSupportWebcamCodec(withLegacy, "vp9")).toBe(false);
  });

  it("falls back to common constrained-baseline H264 when VP8 is unavailable", () => {
    const h264Only = (id: string) => ({
      id,
      isObserver: false,
      capabilities: normalizeClientMediaCapabilities({
        webcam: {
          negotiationVersion: 3,
          receive: ["h264-cb"],
          send: ["h264-cb"],
        },
      }),
    });
    expect(selectRoomWebcamCodec([h264Only("a"), h264Only("b")])).toBe(
      "h264",
    );
  });

  it("retains receiver-adaptive VP8 when an H264-sensitive publisher supports it", () => {
    const h264Sensitive = {
      id: "mobile-web",
      isObserver: false,
      capabilities: normalizeClientMediaCapabilities({
        webcam: {
          negotiationVersion: 3,
          receive: ["vp8", "h264-cb", "vp9-p0"],
          send: ["vp8", "h264-cb"],
          preferredBaseline: "h264",
        },
      }),
    };
    expect(selectRoomWebcamCodec([modernWeb("desktop"), h264Sensitive])).toBe(
      "vp8",
    );
  });

  it("uses receiver-adaptive VP8 with native viewers and publishers", () => {
    const safariPublisher = {
      id: "safari",
      isObserver: false,
      capabilities: normalizeClientMediaCapabilities({
        webcam: {
          negotiationVersion: 3,
          receive: ["vp8", "h264-cb"],
          send: ["vp8", "h264-cb"],
          preferredBaseline: "h264",
        },
      }),
    };
    const nativeViewer = {
      id: "native-viewer",
      isObserver: true,
      capabilities: normalizeClientMediaCapabilities({
        webcam: {
          negotiationVersion: 3,
          receive: ["vp8", "h264-cb"],
          send: [],
          preferredBaseline: "vp8",
        },
      }),
    };
    const nativePublisher = {
      ...nativeViewer,
      id: "native-publisher",
      isObserver: false,
      capabilities: normalizeClientMediaCapabilities({
        webcam: {
          negotiationVersion: 3,
          receive: ["vp8", "h264-cb"],
          send: ["vp8"],
          preferredBaseline: "vp8",
        },
      }),
    };

    expect(selectRoomWebcamCodec([safariPublisher, nativeViewer])).toBe(
      "vp8",
    );
    expect(selectRoomWebcamCodec([safariPublisher, nativePublisher])).toBe(
      "vp8",
    );
  });

  it("rejects VP9 producers without profile 0 L2T1 SVC", () => {
    const policy = buildWebcamCodecPolicy("vp9", 7);
    expect(policy.scalabilityMode).toBe("L2T1");
    const rtp = (profileId: number, scalabilityMode?: string) => ({
      codecs: [
        {
          mimeType: "video/VP9",
          parameters: { "profile-id": profileId },
        },
      ],
      encodings: [{ scalabilityMode }],
    });

    expect(producerMatchesWebcamCodecPolicy(rtp(0, "L2T1"), policy)).toBe(
      true,
    );
    expect(producerMatchesWebcamCodecPolicy(rtp(0, "L3T3_KEY"), policy)).toBe(
      false,
    );
    expect(producerMatchesWebcamCodecPolicy(rtp(0, "l2t1_key"), policy)).toBe(
      false,
    );
    expect(producerMatchesWebcamCodecPolicy(rtp(0, "L1T3"), policy)).toBe(
      false,
    );
    expect(producerMatchesWebcamCodecPolicy(rtp(2, "L2T1"), policy)).toBe(
      false,
    );
    expect(
      producerMatchesWebcamCodecPolicy(
        {
          ...rtp(0, "L2T1"),
          encodings: [
            { scalabilityMode: "L2T1" },
            { scalabilityMode: "L2T1" },
          ],
        },
        policy,
      ),
    ).toBe(false);
    expect(
      producerMatchesWebcamCodecPolicy(
        {
          codecs: [{ mimeType: "video/VP8", parameters: {} }],
          encodings: [{ rid: "f" }],
        },
        policy,
      ),
    ).toBe(false);
  });

  it("keeps H264 producers on constrained baseline packetization mode 1", () => {
    const policy = buildWebcamCodecPolicy("h264", 2);
    const rtp = (profileLevelId: string, packetizationMode: number) => ({
      codecs: [
        {
          mimeType: "video/H264",
          parameters: {
            "profile-level-id": profileLevelId,
            "packetization-mode": packetizationMode,
          },
        },
      ],
      encodings: [{}],
    });
    expect(producerMatchesWebcamCodecPolicy(rtp("42e01f", 1), policy)).toBe(
      true,
    );
    expect(producerMatchesWebcamCodecPolicy(rtp("640c1f", 1), policy)).toBe(
      false,
    );
    expect(producerMatchesWebcamCodecPolicy(rtp("42001f", 1), policy)).toBe(
      false,
    );
    expect(producerMatchesWebcamCodecPolicy(rtp("42e01f", 0), policy)).toBe(
      false,
    );
    expect(
      producerMatchesWebcamCodecPolicy(
        {
          codecs: [
            {
              mimeType: "video/H264",
              parameters: { "profile-level-id": "42e01f" },
            },
          ],
          encodings: [{}],
        },
        policy,
      ),
    ).toBe(false);
  });
});

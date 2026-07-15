import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCodecNegotiation,
  buildCodecCapabilityOverrideScript,
  parseCodecScenario,
} from "./codec-negotiation.mjs";

const publisherSnapshot = ({
  mimeType = "video/VP9",
  sdpFmtpLine = "profile-id=0",
  encodings = [{ active: true, scalabilityMode: "L2T1" }],
} = {}) => ({
  peerConnections: [
    {
      id: "pc-publisher",
      senders: [
        {
          track: {
            id: "camera",
            kind: "video",
            readyState: "live",
          },
          parameters: {
            codecs: [
              { mimeType, sdpFmtpLine, payloadType: 96 },
              { mimeType: "video/rtx", payloadType: 97 },
            ],
            encodings,
          },
        },
      ],
    },
  ],
});

const publisherRtc = (mimeTypes, encodingOverrides = {}) => {
  const encodings = mimeTypes.map((codecMimeType, index) => ({
    id: `out-${index}`,
    active: true,
    transmitted: true,
    bytesSentDelta: 100_000,
    framesEncodedDelta: 30,
    codecMimeType,
    ...(codecMimeType.toLowerCase() === "video/vp9"
      ? {
          codecFmtpLine: "profile-id=0",
          scalabilityMode: "L2T1",
        }
      : { scalabilityMode: "L1T1" }),
    ...encodingOverrides,
  }));
  return {
    encodingCount: encodings.length,
    activeEncodingCount: encodings.filter((encoding) => encoding.active).length,
    binding: {
      matched: true,
      senderId: "sender-current",
      connectionId: "pc-publisher",
      trackId: "camera",
    },
    encodings,
  };
};

const compatibleCapabilities = {
  sender: {
    installed: true,
    videoCalls: 2,
    vp9Removed: true,
    vp8Present: true,
    h264Removed: true,
    h264Present: false,
  },
  receiver: {
    installed: true,
    videoCalls: 2,
    vp9Removed: true,
    vp8Present: true,
    h264Removed: false,
    h264Present: true,
  },
};

test("codec scenario parsing is strict and defaults to all-modern", () => {
  assert.equal(parseCodecScenario(), "all-modern");
  assert.equal(parseCodecScenario("native-compat"), "native-compat");
  assert.throws(() => parseCodecScenario("legacy"), /codec scenario/);
});

test("all-modern requires actual VP9 profile 0 L2T1 media", () => {
  const assessment = assessCodecNegotiation({
    scenario: "all-modern",
    receiverRtc: { codecMimeType: "video/VP9" },
    publisherRtc: publisherRtc(["video/VP9"]),
    publisherSnapshot: publisherSnapshot(),
    transition: {
      initialProducerId: "stable-producer",
      finalProducerId: "stable-producer",
    },
  });

  assert.equal(assessment.passed, true);
  assert.deepEqual(assessment.failures, []);
});

test("all-modern fails wrong VP9 profile and missing SVC evidence", () => {
  const assessment = assessCodecNegotiation({
    scenario: "all-modern",
    receiverRtc: { codecMimeType: "video/VP9" },
    publisherRtc: publisherRtc(["video/VP9", "video/VP9"]),
    publisherSnapshot: publisherSnapshot({
      sdpFmtpLine: "profile-id=2",
      encodings: [{ active: true }],
    }),
    transition: {
      initialProducerId: "producer-a",
      finalProducerId: "producer-b",
    },
  });

  assert.equal(assessment.passed, false);
  assert.match(assessment.failures.join("\n"), /profile 0/);
  assert.match(assessment.failures.join("\n"), /L2T1/);
  assert.match(assessment.failures.join("\n"), /exactly one active VP9/);
  assert.match(assessment.failures.join("\n"), /preserve the publisher producer/);
});

test("all-modern rejects incorrect active RTP despite correct requested parameters", () => {
  const assessment = assessCodecNegotiation({
    scenario: "all-modern",
    receiverRtc: { codecMimeType: "video/VP9" },
    publisherRtc: publisherRtc(["video/VP9"], {
      codecFmtpLine: "profile-id=2;x-google-start-bitrate=1800",
      scalabilityMode: "L1T3",
    }),
    publisherSnapshot: publisherSnapshot(),
    transition: {
      initialProducerId: "stable-producer",
      finalProducerId: "stable-producer",
    },
  });

  assert.equal(assessment.passed, false);
  assert.match(
    assessment.failures.join("\n"),
    /active outbound RTP codec to be VP9 profile 0/,
  );
  assert.match(
    assessment.failures.join("\n"),
    /active outbound RTP encoding to report L2T1/,
  );
});

test("codec evidence rejects RTP stats not bound to the current sender", () => {
  const rtc = publisherRtc(["video/VP9"]);
  rtc.binding = {
    matched: false,
    senderId: null,
    connectionId: null,
    trackId: "stale-camera",
  };
  const assessment = assessCodecNegotiation({
    scenario: "all-modern",
    receiverRtc: { codecMimeType: "video/VP9" },
    publisherRtc: rtc,
    publisherSnapshot: publisherSnapshot(),
    transition: {
      initialProducerId: "stable-producer",
      finalProducerId: "stable-producer",
    },
  });

  assert.equal(assessment.passed, false);
  assert.match(assessment.failures.join("\n"), /bound to the sole live sender/);
});

test("native-compat proves capability filtering and VP9-to-VP8 republish", () => {
  const assessment = assessCodecNegotiation({
    scenario: "native-compat",
    receiverRtc: { codecMimeType: "video/VP8" },
    publisherRtc: publisherRtc([
      "video/VP8",
      "video/VP8",
      "video/VP8",
    ]),
    publisherSnapshot: publisherSnapshot({
      mimeType: "video/VP8",
      sdpFmtpLine: "",
      encodings: [
        {
          active: true,
          rid: "r0",
          maxBitrate: 80_000,
          maxFramerate: 12,
          scalabilityMode: "L1T1",
        },
        {
          active: true,
          rid: "r1",
          maxBitrate: 220_000,
          maxFramerate: 20,
          scalabilityMode: "L1T1",
        },
        {
          active: true,
          rid: "r2",
          maxBitrate: 1_650_000,
          maxFramerate: 30,
          scalabilityMode: "L1T1",
        },
      ],
    }),
    viewerCapabilities: compatibleCapabilities,
    transition: {
      initialProducerId: "vp9-producer",
      finalProducerId: "vp8-producer",
      durationMs: 1_250,
      initialPublisherRtc: publisherRtc(["video/VP9"]),
    },
    receiverCount: 2,
    receiverConsumer: {
      currentLayers: { spatialLayer: 2, temporalLayer: 0 },
    },
  });

  assert.equal(assessment.passed, true);
});

test("native-compat accepts authoritative one-receiver VP8 single encoding", () => {
  const assessment = assessCodecNegotiation({
    scenario: "native-compat",
    receiverCount: 1,
    receiverRtc: { codecMimeType: "video/VP8" },
    publisherRtc: publisherRtc(["video/VP8"]),
    publisherSnapshot: publisherSnapshot({
      mimeType: "video/VP8",
      sdpFmtpLine: "",
      encodings: [
        {
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 30,
          scalabilityMode: "L1T1",
        },
      ],
    }),
    viewerCapabilities: compatibleCapabilities,
    transition: {
      initialProducerId: "vp9-producer",
      finalProducerId: "vp8-simulcast-producer",
      durationMs: 1_250,
      initialPublisherRtc: publisherRtc(["video/VP9"]),
    },
  });

  assert.equal(assessment.passed, true);
  assert.equal(assessment.expected.activeOutboundEncodings, 1);
});

test("one-receiver codec evidence rejects standby layers and zero-traffic placeholders", () => {
  const standbyAssessment = assessCodecNegotiation({
    scenario: "native-compat",
    receiverCount: 1,
    receiverRtc: { codecMimeType: "video/VP8" },
    publisherRtc: publisherRtc(["video/VP8", "video/VP8", "video/VP8"]),
    publisherSnapshot: publisherSnapshot({
      mimeType: "video/VP8",
      sdpFmtpLine: "",
      encodings: [
        { active: true, rid: "r0", maxBitrate: 35_000, maxFramerate: 12 },
        { active: true, rid: "r1", maxBitrate: 90_000, maxFramerate: 20 },
        {
          active: true,
          rid: "r2",
          maxBitrate: 1_750_000,
          maxFramerate: 30,
        },
      ],
    }),
    viewerCapabilities: compatibleCapabilities,
    transition: {
      initialProducerId: "vp9-producer",
      finalProducerId: "vp8-producer",
      durationMs: 1_250,
      initialPublisherRtc: publisherRtc(["video/VP9"]),
    },
  });
  assert.equal(standbyAssessment.passed, false);
  assert.match(standbyAssessment.failures.join("\n"), /exactly 1 configured/);

  const rtcWithPlaceholder = publisherRtc(["video/VP8"]);
  rtcWithPlaceholder.encodingCount = 2;
  rtcWithPlaceholder.encodings.push({
    id: "out-placeholder",
    active: false,
    transmitted: false,
    bytesSentDelta: 0,
    framesEncodedDelta: 0,
    codecMimeType: "video/VP8",
  });
  const placeholderAssessment = assessCodecNegotiation({
    scenario: "native-compat",
    receiverCount: 1,
    receiverRtc: { codecMimeType: "video/VP8" },
    publisherRtc: rtcWithPlaceholder,
    publisherSnapshot: publisherSnapshot({
      mimeType: "video/VP8",
      sdpFmtpLine: "",
      encodings: [
        { active: true, maxBitrate: 1_650_000, maxFramerate: 30 },
      ],
    }),
    viewerCapabilities: compatibleCapabilities,
    transition: {
      initialProducerId: "vp9-producer",
      finalProducerId: "vp8-producer",
      durationMs: 1_250,
      initialPublisherRtc: publisherRtc(["video/VP9"]),
    },
  });
  assert.equal(placeholderAssessment.passed, false);
  assert.match(placeholderAssessment.failures.join("\n"), /no placeholders/);
});

test("native-compat rejects temporal layering in configured, outbound, or receive evidence", () => {
  const input = {
    scenario: "native-compat",
    receiverCount: 2,
    receiverRtc: { codecMimeType: "video/VP8" },
    publisherRtc: publisherRtc(["video/VP8", "video/VP8", "video/VP8"]),
    publisherSnapshot: publisherSnapshot({
      mimeType: "video/VP8",
      sdpFmtpLine: "",
      encodings: [
        {
          active: true,
          rid: "r0",
          maxBitrate: 80_000,
          maxFramerate: 12,
          scalabilityMode: "L1T1",
        },
        {
          active: true,
          rid: "r1",
          maxBitrate: 220_000,
          maxFramerate: 20,
          scalabilityMode: "L1T1",
        },
        {
          active: true,
          rid: "r2",
          maxBitrate: 1_650_000,
          maxFramerate: 30,
          scalabilityMode: "L1T1",
        },
      ],
    }),
    viewerCapabilities: compatibleCapabilities,
    receiverConsumer: {
      currentLayers: { spatialLayer: 2, temporalLayer: 0 },
    },
    transition: {
      initialProducerId: "vp9-producer",
      finalProducerId: "vp8-producer",
      durationMs: 1_250,
      initialPublisherRtc: publisherRtc(["video/VP9"]),
    },
  };

  for (const mutate of [
    (value) => {
      value.publisherSnapshot.peerConnections[0].senders[0].parameters.encodings[0].scalabilityMode =
        "L1T3";
    },
    (value) => {
      value.publisherRtc.encodings[0].scalabilityMode = "L1T3";
    },
    (value) => {
      value.receiverConsumer.currentLayers.temporalLayer = 1;
    },
  ]) {
    const value = structuredClone(input);
    mutate(value);
    const assessment = assessCodecNegotiation(value);
    assert.equal(assessment.passed, false);
    assert.match(assessment.failures.join("\n"), /L1T1|temporal layer 0/);
  }
});

test("native-compat fails when override evidence is missing or VP9 remains", () => {
  const assessment = assessCodecNegotiation({
    scenario: "native-compat",
    receiverRtc: { codecMimeType: "video/VP9" },
    publisherRtc: publisherRtc(["video/VP9"]),
    publisherSnapshot: publisherSnapshot(),
    viewerCapabilities: {
      sender: { installed: false, videoCalls: 0 },
      receiver: { installed: false, videoCalls: 0 },
    },
    transition: {
      initialProducerId: "same",
      finalProducerId: "same",
      durationMs: 16_000,
      initialPublisherRtc: publisherRtc(["video/VP9"]),
    },
  });

  assert.equal(assessment.passed, false);
  assert.match(assessment.failures.join("\n"), /override was not proven/);
  assert.match(assessment.failures.join("\n"), /video\/VP8/);
  assert.match(assessment.failures.join("\n"), /producer replacement/);
});

test("native capability override cannot capture or emit audio", () => {
  const script = buildCodecCapabilityOverrideScript("native-compat");
  assert.match(script, /RTCRtpSender/);
  assert.match(script, /RTCRtpReceiver/);
  assert.match(script, /video\/vp9/);
  assert.doesNotMatch(script, /getUserMedia|AudioContext|AudioNode|\.play\s*\(/);
  assert.equal(buildCodecCapabilityOverrideScript("all-modern"), "");
});

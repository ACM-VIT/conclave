import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceMediaPathStability,
  assessStableMediaPath,
  findInboundVideoEvidence,
} from "./media-path-stability.mjs";

const stats = ({ framesDecoded = 120, ssrc = 42, height = 720 } = {}) => ({
  peerConnections: [
    {
      id: "pc-viewer",
      stats: [
        { id: "codec", type: "codec", mimeType: "video/VP8" },
        {
          id: "inbound",
          type: "inbound-rtp",
          kind: "video",
          codecId: "codec",
          ssrc,
          trackIdentifier: "consumer-final",
          framesDecoded,
          bytesReceived: 500_000,
          frameWidth: 1280,
          frameHeight: height,
        },
        {
          id: "probator",
          type: "inbound-rtp",
          kind: "video",
          mid: "probator",
          trackIdentifier: "probator",
          framesDecoded: 999,
        },
      ],
    },
  ],
});

const sample = (overrides = {}) =>
  assessStableMediaPath({
    publisher: {
      producerId: "producer-final",
      closed: false,
      trackId: "track-final",
      codecs: [{ mimeType: "video/VP8" }],
      encodings: [
        {
          rid: null,
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 30,
          scalabilityMode: "L1T1",
        },
      ],
    },
    publisherRtc: {
      encodingCount: 1,
      activeEncodingCount: 1,
      binding: {
        matched: true,
        senderId: "sender-final",
        connectionId: "pc-publisher",
        trackId: "track-final",
      },
      encodings: [
        {
          id: "out-final",
          ssrc: 42,
          active: true,
          transmitted: true,
          bytesSentDelta: 100_000,
          framesEncodedDelta: 30,
          codecMimeType: "video/VP8",
          scalabilityMode: "L1T1",
        },
      ],
    },
    viewer: {
      connectionState: "joined",
      consumers: [
        {
          producerId: "producer-final",
          consumerId: "consumer-final",
          status: "applied",
          paused: false,
          preferredLayers: { spatialLayer: 2, temporalLayer: 0 },
          currentLayers: { spatialLayer: 2, temporalLayer: 0 },
        },
      ],
      renderedVideo: { width: 1280, height: 720 },
    },
    viewerStats: stats(),
    expectedProducerId: "producer-final",
    expectedCodecMimeType: "video/VP8",
    expectedSenderEncodingCount: 1,
    expectedActiveSenderEncodings: 1,
    expectedSenderEncodings: [
      {
        rid: null,
        maxBitrate: 1_650_000,
        maxFramerate: 30,
        scalabilityMode: "L1T1",
      },
    ],
    expectedConsumerTemporalLayer: 0,
    minimumDecodedHeight: 640,
    ...overrides,
  });

test("binds inbound RTP evidence to the final consumer and ignores probator", () => {
  assert.equal(findInboundVideoEvidence(stats(), "consumer-final")?.statId, "inbound");
  const assessment = sample();
  assert.equal(assessment.passed, true);
  assert.match(assessment.signature, /producer-final\|consumer-final/);
});

test("rejects stale layers, extra sender encodings, and the wrong codec", () => {
  const assessment = sample({
    publisher: {
      producerId: "producer-final",
      trackId: "track-final",
      codecs: [{ mimeType: "video/VP9" }],
      encodings: [
        {
          rid: "q",
          active: true,
          maxBitrate: 80_000,
          maxFramerate: 12,
        },
        {
          rid: "f",
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 30,
        },
      ],
    },
    viewer: {
      connectionState: "joined",
      consumers: [
        {
          producerId: "producer-final",
          consumerId: "consumer-final",
          status: "applied",
          preferredLayers: { spatialLayer: 2 },
          currentLayers: { spatialLayer: 1 },
        },
      ],
      renderedVideo: { width: 1280, height: 720 },
    },
  });
  assert.equal(assessment.passed, false);
  assert.match(assessment.reasons.join("\n"), /codec/);
  assert.match(assessment.reasons.join("\n"), /encoding count/);
  assert.match(assessment.reasons.join("\n"), /topology/);
  assert.match(assessment.reasons.join("\n"), /preferred spatial layer/);
});

test("rejects inactive placeholders and incorrect full-layer caps", () => {
  const placeholder = sample({
    publisher: {
      producerId: "producer-final",
      trackId: "track-final",
      closed: false,
      codecs: [{ mimeType: "video/VP8" }],
      encodings: [
        {
          rid: null,
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 30,
        },
        {
          rid: "r0",
          active: false,
          maxBitrate: 35_000,
          maxFramerate: 12,
        },
      ],
    },
  });
  assert.equal(placeholder.passed, false);
  assert.match(placeholder.reasons.join("\n"), /configured sender encoding count/);

  const wrongCap = sample({
    publisher: {
      producerId: "producer-final",
      trackId: "track-final",
      closed: false,
      codecs: [{ mimeType: "video/VP8" }],
      encodings: [
        {
          rid: null,
          active: true,
          maxBitrate: 1_650_000,
          maxFramerate: 29,
        },
      ],
    },
  });
  assert.equal(wrongCap.passed, false);
  assert.match(wrongCap.reasons.join("\n"), /expected active cap/);
});

test("rejects configured, outbound, or receive temporal layering", () => {
  for (const overrides of [
    {
      publisher: {
        producerId: "producer-final",
        closed: false,
        trackId: "track-final",
        codecs: [{ mimeType: "video/VP8" }],
        encodings: [
          {
            rid: null,
            active: true,
            maxBitrate: 1_650_000,
            maxFramerate: 30,
            scalabilityMode: "L1T3",
          },
        ],
      },
    },
    {
      publisherRtc: {
        encodingCount: 1,
        activeEncodingCount: 1,
        binding: {
          matched: true,
          senderId: "sender-final",
          connectionId: "pc-publisher",
          trackId: "track-final",
        },
        encodings: [
          {
            id: "out-final",
            ssrc: 42,
            active: true,
            transmitted: true,
            bytesSentDelta: 100_000,
            framesEncodedDelta: 30,
            codecMimeType: "video/VP8",
            scalabilityMode: "L1T3",
          },
        ],
      },
    },
    {
      viewer: {
        connectionState: "joined",
        consumers: [
          {
            producerId: "producer-final",
            consumerId: "consumer-final",
            status: "applied",
            paused: false,
            preferredLayers: { spatialLayer: 2, temporalLayer: 0 },
            currentLayers: { spatialLayer: 2, temporalLayer: 1 },
          },
        ],
        renderedVideo: { width: 1280, height: 720 },
      },
    },
  ]) {
    const assessment = sample(overrides);
    assert.equal(assessment.passed, false);
    assert.match(
      assessment.reasons.join("\n"),
      /expected active cap|not flowing|temporal layer/,
    );
  }
});

test("rejects ambiguous or placeholder-bearing current sender RTP evidence", () => {
  const ambiguous = sample({
    publisherRtc: {
      encodingCount: 1,
      activeEncodingCount: 1,
      binding: {
        matched: false,
        senderId: null,
        connectionId: null,
        trackId: "track-final",
      },
      encodings: [],
    },
  });
  assert.equal(ambiguous.passed, false);
  assert.match(ambiguous.reasons.join("\n"), /not bound/);

  const placeholder = sample({
    publisherRtc: {
      encodingCount: 2,
      activeEncodingCount: 1,
      binding: {
        matched: true,
        senderId: "sender-final",
        connectionId: "pc-publisher",
        trackId: "track-final",
      },
      encodings: [
        {
          id: "out-final",
          ssrc: 42,
          active: true,
          transmitted: true,
          bytesSentDelta: 100_000,
          framesEncodedDelta: 30,
          codecMimeType: "video/VP8",
        },
        {
          id: "out-placeholder",
          ssrc: 43,
          active: false,
          transmitted: false,
          bytesSentDelta: 0,
          framesEncodedDelta: 0,
          codecMimeType: "video/VP8",
        },
      ],
    },
  });
  assert.equal(placeholder.passed, false);
  assert.match(placeholder.reasons.join("\n"), /actual sender RTP encoding count/);
  assert.match(placeholder.reasons.join("\n"), /not flowing/);
});

test("requires one unchanged path for both elapsed time and decoded frames", () => {
  let state = advanceMediaPathStability(null, sample(), {
    now: 1_000,
    requiredStableMs: 4_000,
    minimumDecodedFrames: 100,
  });
  assert.equal(state.ready, false);

  state = advanceMediaPathStability(
    state,
    sample({ viewerStats: stats({ framesDecoded: 230 }) }),
    {
      now: 5_100,
      requiredStableMs: 4_000,
      minimumDecodedFrames: 100,
    },
  );
  assert.equal(state.ready, true);

  const reset = advanceMediaPathStability(
    state,
    sample({ viewerStats: stats({ framesDecoded: 10, ssrc: 99 }) }),
    {
      now: 5_200,
      requiredStableMs: 4_000,
      minimumDecodedFrames: 100,
    },
  );
  assert.equal(reset.ready, false);
  assert.equal(reset.stableMs, 0);
});

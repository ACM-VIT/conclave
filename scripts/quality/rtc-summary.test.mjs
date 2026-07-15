import assert from "node:assert/strict";
import test from "node:test";
import { assessNativeVp8PublisherReadiness } from "./receiver-count.mjs";
import {
  bindPublisherVideoSender,
  summarizePublisherVideoSenderStats,
  summarizePublisherVideoStats,
} from "./rtc-summary.mjs";

const snapshot = (bytesByRid) => ({
  peerConnections: [
    {
      id: "pc-1",
      stats: [
        {
          id: "codec",
          type: "codec",
          mimeType: "video/VP8",
          sdpFmtpLine: "max-fs=3600",
        },
        ...Object.entries(bytesByRid).map(([rid, value], index) => {
          const entry =
            typeof value === "number" ? { bytesSent: value } : value;
          return {
            id: `out-${rid}`,
            type: "outbound-rtp",
            kind: "video",
            rid,
            ssrc: index + 1,
            codecId: "codec",
            scalabilityMode: "L1T3",
            bytesSent: entry.bytesSent,
            framesEncoded:
              entry.framesEncoded ?? entry.bytesSent / 1_000,
            qpSum: entry.bytesSent / 10,
            frameWidth: 320 * (index + 1),
            frameHeight: 180 * (index + 1),
            ...(typeof entry.active === "boolean"
              ? { active: entry.active }
              : {}),
          };
        }),
        {
          id: "probator",
          type: "outbound-rtp",
          kind: "video",
          mid: "probator",
          bytesSent: 999_999,
        },
      ],
    },
  ],
});

test("publisher summary reports simulcast aggregate and per-layer bitrate", () => {
  const result = summarizePublisherVideoStats(
    snapshot({ q: 10_000, h: 20_000, f: 30_000 }),
    snapshot({ q: 20_000, h: 40_000, f: 60_000 }),
    10_000,
  );

  assert.equal(result.activeEncodingCount, 3);
  assert.equal(result.bytesSentDelta, 60_000);
  assert.equal(result.averageVideoBitrateBps, 48_000);
  assert.deepEqual(
    result.encodings.map((encoding) => encoding.rid),
    ["q", "h", "f"],
  );
  assert.ok(result.encodings.every((encoding) => encoding.codecMimeType === "video/VP8"));
  assert.ok(result.encodings.every((encoding) => encoding.scalabilityMode === "L1T3"));
  assert.ok(result.encodings.every((encoding) => encoding.codecFmtpLine === "max-fs=3600"));
  assert.equal(result.counterAuthority.valid, true);
  assert.ok(
    result.encodings.every(
      (encoding) => encoding.counterAuthority.valid === true,
    ),
  );
});

test("publisher summary excludes probator traffic", () => {
  const result = summarizePublisherVideoStats(
    snapshot({ q: 0 }),
    snapshot({ q: 0 }),
    1_000,
  );
  assert.equal(result.encodingCount, 1);
  assert.equal(result.averageVideoBitrateBps, 0);
});

test("inactive maintenance frames count toward bandwidth but not active encodings", () => {
  const start = snapshot([
    ["f", { bytesSent: 100_000, framesEncoded: 100, active: true }],
    ["q", { bytesSent: 10_000, framesEncoded: 10, active: false }],
  ].reduce((entries, [rid, value]) => ({ ...entries, [rid]: value }), {}));
  const end = snapshot([
    ["f", { bytesSent: 300_000, framesEncoded: 200, active: true }],
    ["q", { bytesSent: 12_000, framesEncoded: 11, active: false }],
  ].reduce((entries, [rid, value]) => ({ ...entries, [rid]: value }), {}));

  const summary = summarizePublisherVideoStats(start, end, 1_000);
  assert.equal(summary.activeEncodingCount, 1);
  assert.equal(summary.bytesSentDelta, 202_000);
  assert.deepEqual(
    {
      active: summary.encodings.find((encoding) => encoding.rid === "q")
        ?.active,
      transmitted: summary.encodings.find((encoding) => encoding.rid === "q")
        ?.transmitted,
      bytesSentDelta: summary.encodings.find((encoding) => encoding.rid === "q")
        ?.bytesSentDelta,
    },
    { active: false, transmitted: true, bytesSentDelta: 2_000 },
  );
});

test("zero-traffic Chrome RTP placeholders are not active encodings", () => {
  const start = {
    peerConnections: [
      {
        id: "pc",
        stats: [
          { id: "codec", type: "codec", mimeType: "video/VP8" },
          {
            id: "out-real",
            type: "outbound-rtp",
            kind: "video",
            codecId: "codec",
            active: true,
            bytesSent: 100,
            framesEncoded: 1,
          },
          {
            id: "out-placeholder",
            type: "outbound-rtp",
            kind: "video",
            codecId: "codec",
            active: true,
            bytesSent: 0,
            framesEncoded: 0,
          },
        ],
      },
    ],
  };
  const end = structuredClone(start);
  end.peerConnections[0].stats[1].bytesSent = 10_100;
  end.peerConnections[0].stats[1].framesEncoded = 101;

  const summary = summarizePublisherVideoStats(start, end, 1_000);
  assert.equal(summary.encodingCount, 2);
  assert.equal(summary.activeEncodingCount, 1);
  assert.equal(
    summary.encodings.find((encoding) => encoding.id === "out-placeholder")
      ?.active,
    false,
  );
});

const retainedPredecessorSnapshot = ({
  finalBytes,
  finalFrames,
  includeFinalPlaceholder = false,
}) => {
  const codec = {
    id: "codec-vp8",
    type: "codec",
    mimeType: "video/VP8",
  };
  const predecessorStats = ["r0", "r1", "r2"].map((rid, index) => ({
    id: `old-${rid}`,
    type: "outbound-rtp",
    kind: "video",
    codecId: codec.id,
    rid,
    active: false,
    bytesSent: 10_000 + index,
    framesEncoded: 10 + index,
  }));
  const finalStats = [
    codec,
    {
      id: "out-final",
      type: "outbound-rtp",
      kind: "video",
      codecId: codec.id,
      active: true,
      scalabilityMode: "L1T1",
      bytesSent: finalBytes,
      framesEncoded: finalFrames,
    },
    ...(includeFinalPlaceholder
      ? [
          {
            id: "out-final-placeholder",
            type: "outbound-rtp",
            kind: "video",
            codecId: codec.id,
            rid: "r0",
            active: false,
            bytesSent: 0,
            framesEncoded: 0,
          },
        ]
      : []),
  ];
  return {
    capturedAt: finalFrames * 100,
    peerConnections: [
      {
        id: "pc-publisher",
        stats: [codec, ...predecessorStats, ...finalStats.slice(1)],
        senders: [
          {
            id: "sender-final",
            track: {
              id: "track-final",
              kind: "video",
              readyState: "live",
            },
            parameters: {
              encodings: [
                {
                  active: true,
                  maxBitrate: 1_650_000,
                  maxFramerate: 30,
                  scalabilityMode: "L1T1",
                },
              ],
            },
            stats: finalStats,
            statsError: null,
          },
        ],
      },
    ],
  };
};

const finalAdaptivePublish = {
  participantCount: 2,
  receiverCapacityProofProducerId: "producer-final",
  receiverCapacityProofBasis: "single-layer",
  receiverCapacityHandoffOffered: false,
  webcamProducerTopology: "vp8-single-layer",
  webcamTopologyTransitionPhase: "single",
  lastAppliedProfiles: {
    webcam: "producer-final:standard:good:single-receiver",
  },
  producers: {
    webcam: {
      id: "producer-final",
      closed: false,
      paused: false,
      trackId: "track-final",
      trackReadyState: "live",
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
  },
};

test("producer-bound stats ignore retained predecessor PC stats without relaxing final evidence", () => {
  const start = retainedPredecessorSnapshot({
    finalBytes: 100_000,
    finalFrames: 100,
  });
  const end = retainedPredecessorSnapshot({
    finalBytes: 300_000,
    finalFrames: 200,
  });

  const pcWide = summarizePublisherVideoStats(start, end, 1_000);
  assert.equal(pcWide.encodingCount, 4);
  assert.equal(pcWide.activeEncodingCount, 1);

  const currentSender = summarizePublisherVideoSenderStats(
    start,
    end,
    1_000,
    { trackId: "track-final" },
  );
  assert.equal(currentSender.binding.matched, true);
  assert.equal(currentSender.encodingCount, 1);
  assert.equal(currentSender.activeEncodingCount, 1);
  assert.equal(currentSender.encodings[0].bytesSentDelta, 200_000);
  assert.equal(
    assessNativeVp8PublisherReadiness({
      receiverCount: 1,
      adaptivePublish: structuredClone(finalAdaptivePublish),
      publisherRtc: currentSender,
      initialProducerId: "producer-vp8-simulcast",
    }).ready,
    true,
  );
});

test("producer-bound stats reject placeholders owned by the final sender", () => {
  const start = retainedPredecessorSnapshot({
    finalBytes: 100_000,
    finalFrames: 100,
    includeFinalPlaceholder: true,
  });
  const end = retainedPredecessorSnapshot({
    finalBytes: 300_000,
    finalFrames: 200,
    includeFinalPlaceholder: true,
  });
  const currentSender = summarizePublisherVideoSenderStats(
    start,
    end,
    1_000,
    { trackId: "track-final" },
  );
  assert.equal(currentSender.binding.matched, true);
  assert.equal(currentSender.encodingCount, 2);
  assert.equal(currentSender.activeEncodingCount, 1);
  const readiness = assessNativeVp8PublisherReadiness({
    receiverCount: 1,
    adaptivePublish: structuredClone(finalAdaptivePublish),
    publisherRtc: currentSender,
    initialProducerId: "producer-vp8-simulcast",
  });
  assert.equal(readiness.ready, false);
  assert.match(readiness.reasons.join("\n"), /outbound RTP encoding count/);
});

test("current sender binding exposes ambiguous live-track ownership", () => {
  const snapshot = retainedPredecessorSnapshot({
    finalBytes: 300_000,
    finalFrames: 200,
  });
  snapshot.peerConnections[0].senders.push({
    ...structuredClone(snapshot.peerConnections[0].senders[0]),
    id: "sender-ambiguous",
  });
  const binding = bindPublisherVideoSender(snapshot, {
    trackId: "track-final",
  });
  assert.equal(binding.matched, false);
  assert.equal(binding.candidateCount, 2);
  assert.match(binding.reasons.join("\n"), /exactly one sender/);
});

test("current sender binding uses exact configured topology when a track id is reused", () => {
  const snapshot = retainedPredecessorSnapshot({
    finalBytes: 300_000,
    finalFrames: 200,
  });
  snapshot.peerConnections[0].senders.push({
    ...structuredClone(snapshot.peerConnections[0].senders[0]),
    id: "sender-old-simulcast",
    parameters: {
      encodings: [
        { rid: "r0", active: false, maxBitrate: 35_000, maxFramerate: 12 },
        { rid: "r1", active: false, maxBitrate: 90_000, maxFramerate: 20 },
        {
          rid: "r2",
          active: false,
          maxBitrate: 1_750_000,
          maxFramerate: 30,
        },
      ],
    },
  });
  const binding = bindPublisherVideoSender(snapshot, {
    trackId: "track-final",
    expectedEncodings: [
      {
        rid: null,
        active: true,
        maxBitrate: 1_650_000,
        maxFramerate: 30,
        scalabilityMode: "L1T1",
      },
    ],
  });
  assert.equal(binding.matched, true);
  assert.equal(binding.trackCandidateCount, 2);
  assert.equal(binding.candidateCount, 1);
  assert.equal(binding.senderId, "sender-final");
});

test("current sender binding rejects the wrong configured scalability mode", () => {
  const snapshot = retainedPredecessorSnapshot({
    finalBytes: 300_000,
    finalFrames: 200,
  });
  snapshot.peerConnections[0].senders[0].parameters.encodings[0].scalabilityMode =
    "L1T3";
  const binding = bindPublisherVideoSender(snapshot, {
    trackId: "track-final",
    expectedEncodings: [
      {
        rid: null,
        active: true,
        maxBitrate: 1_650_000,
        maxFramerate: 30,
        scalabilityMode: "L1T1",
      },
    ],
  });
  assert.equal(binding.matched, false);
  assert.match(binding.reasons.join("\n"), /configured topology/);
});

test("publisher summary preserves counter authority across replaceTrack on the fixed sender", () => {
  const start = retainedPredecessorSnapshot({
    finalBytes: 100_000,
    finalFrames: 100,
  });
  const end = retainedPredecessorSnapshot({
    finalBytes: 300_000,
    finalFrames: 200,
  });
  start.peerConnections[0].senders[0].track.id = "track-pristine";
  end.peerConnections[0].senders[0].track.id = "track-poor";
  end.peerConnections[0].senders[0].parameters.encodings[0].maxBitrate =
    180_000;
  end.peerConnections[0].senders[0].parameters.encodings[0].maxFramerate = 12;

  const strict = summarizePublisherVideoSenderStats(start, end, 1_000, {
    trackId: "track-pristine",
    senderId: "sender-final",
  });
  assert.equal(strict.binding.matched, false);

  const adaptive = summarizePublisherVideoSenderStats(start, end, 1_000, {
    trackId: "track-pristine",
    senderId: "sender-final",
    expectedEncodings: null,
    allowTrackReplacement: true,
  });
  assert.equal(adaptive.binding.matched, true);
  assert.equal(adaptive.binding.connectionId, "pc-publisher");
  assert.equal(adaptive.binding.senderId, "sender-final");
  assert.equal(adaptive.binding.trackId, "track-poor");
  assert.equal(adaptive.encodings[0].id, "out-final");
  assert.equal(adaptive.encodings[0].bytesSentDelta, 200_000);
  assert.equal(adaptive.encodings[0].framesEncodedDelta, 100);
  assert.equal(adaptive.counterAuthority.valid, true);
});

test("a bytes-only RTP counter reset never becomes a flattering current-value delta", () => {
  const result = summarizePublisherVideoStats(
    snapshot({
      f: { bytesSent: 100_000, framesEncoded: 100, active: true },
    }),
    snapshot({
      f: { bytesSent: 50_000, framesEncoded: 200, active: true },
    }),
    1_000,
  );

  assert.equal(result.encodings[0].bytesSentDelta, null);
  assert.equal(result.encodings[0].framesEncodedDelta, 100);
  assert.equal(result.encodings[0].counterAuthority.bytesSent.reset, true);
  assert.equal(result.encodings[0].counterAuthority.valid, false);
  assert.equal(result.counterAuthority.valid, false);
  assert.equal(result.counterAuthority.byteCounterResetDetected, true);
  assert.equal(result.bytesSentDelta, null);
  assert.equal(result.averageVideoBitrateBps, null);
});

test("an outbound stat missing from the start snapshot invalidates counter authority", () => {
  const result = summarizePublisherVideoStats(
    snapshot({}),
    snapshot({
      f: { bytesSent: 50_000, framesEncoded: 50, active: true },
    }),
    1_000,
  );

  assert.equal(result.counterAuthority.valid, false);
  assert.equal(result.counterAuthority.missingStartStatDetected, true);
  assert.equal(result.encodings[0].counterAuthority.startStatPresent, false);
  assert.equal(result.encodings[0].bytesSentDelta, null);
  assert.equal(result.averageVideoBitrateBps, null);
});

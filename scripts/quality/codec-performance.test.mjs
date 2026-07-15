import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEC_PERFORMANCE_VERSION,
  assessMeetingPerformance,
  assessPublisherCodecPerformance as assessPublisherCodecPerformanceRaw,
  assessReceiverCodecPerformance as assessReceiverCodecPerformanceRaw,
  extractPublisherCodecObservation,
  publisherSenderEncodingSignature,
} from "./codec-performance.mjs";
import { PROCESS_PERFORMANCE_VERSION } from "./process-performance.mjs";

const measurementWindow = {
  version: 1,
  id: "window-1",
  startedAtEpochMs: 10_000,
  endedAtEpochMs: 20_000,
  durationMs: 10_000,
};

const observerMetadata = {
  measurementWindowId: measurementWindow.id,
  observerStartedAtEpochMs: measurementWindow.startedAtEpochMs,
  observerStoppedAtEpochMs: measurementWindow.endedAtEpochMs,
  observationIntervalMs: 500,
  skippedTickCount: 0,
};

const assessPublisherCodecPerformance = (input) =>
  assessPublisherCodecPerformanceRaw({
    measurementWindow,
    observerMetadata: {
      ...observerMetadata,
      observationIntervalMs:
        input?.observationIntervalMs ?? observerMetadata.observationIntervalMs,
      skippedTickCount:
        input?.skippedTickCount ?? observerMetadata.skippedTickCount,
    },
    ...input,
  });

const assessReceiverCodecPerformance = (input) =>
  assessReceiverCodecPerformanceRaw({ measurementWindow, ...input });

const encodeLimits = {
  maximumMeanMsPerFrame: 20,
  maximumP95MsPerFrame: 35,
  maximumMsPerFrame: 75,
  maximumCpuQualityLimitationRatio: 0.05,
};

const decodeLimits = {
  maximumMeanMsPerFrame: 12,
  maximumP95MsPerFrame: 22,
  maximumMsPerFrame: 50,
};

const publisherObservations = ({
  count = 21,
  spikeIndexes = [],
  cpuDurationPerInterval = 0,
  omitQp = false,
} = {}) => {
  let framesEncoded = 1_000;
  let totalEncodeTime = 4;
  let qpSum = 30_000;
  let noneDuration = 10;
  let cpuDuration = 0;
  return Array.from({ length: count }, (_, index) => {
    if (index > 0) {
      const frames = 15;
      framesEncoded += frames;
      totalEncodeTime += spikeIndexes.includes(index) ? 1.5 : 0.06;
      qpSum += 450;
      noneDuration += 0.5 - cpuDurationPerInterval;
      cpuDuration += cpuDurationPerInterval;
    }
    return {
      capturedAtEpochMs: 10_000 + index * 500,
      sampledAtMs: index * 500,
      measurementWindowId: measurementWindow.id,
      matched: true,
      reasons: [],
      producerId: "producer-1",
      connectionId: "pc-1",
      senderId: "sender-1",
      trackId: "track-1",
      senderEncodingSignature: "signature",
      encodings: [
        {
          id: "out-1",
          ssrc: 111,
          rid: null,
          active: true,
          framesEncoded,
          keyFramesEncoded: Math.floor(framesEncoded / 30),
          totalEncodeTime,
          qpSum: omitQp ? null : qpSum,
          bytesSent: 100_000 + index * 100_000,
          qualityLimitationReason:
            cpuDurationPerInterval > 0 ? "cpu" : "none",
          qualityLimitationDurations: {
            none: noneDuration,
            cpu: cpuDuration,
            bandwidth: 0,
            other: 0,
          },
          encoderImplementation: "libvpx",
          powerEfficientEncoder: false,
          codecId: "codec-1",
          codecPayloadType: 98,
          codecMimeType: "video/vp9",
          codecFmtpLine: "profile-id=0",
          scalabilityMode: "L2T1",
          frameWidth: 1280,
          frameHeight: 720,
        },
      ],
    };
  });
};

const binding = {
  valid: true,
  observationIntervalMs: 500,
  measurementWindowId: measurementWindow.id,
  observationCount: 21,
  observerMetadata: {
    valid: true,
    observationIntervalMs: 500,
    scheduledObservationCount: 21,
    completedObservationCount: 21,
    skippedTickCount: 0,
    lateTickCount: 0,
    overlapTickCount: 0,
    captureErrors: [],
    observerStartedAtEpochMs: measurementWindow.startedAtEpochMs,
    observerStoppedAtEpochMs: measurementWindow.endedAtEpochMs,
  },
  expected: {
    producerId: "producer-1",
    consumerId: "consumer-1",
    connectionId: "pc-2",
    statId: "in-1",
    ssrc: "222",
    codecMimeType: "video/vp9",
    codecId: "codec-1",
    codecPayloadType: 98,
    codecFmtpLine: "profile-id=0",
    scalabilityMode: "L2T1",
    decoderImplementation: "libvpx",
    powerEfficientDecoder: false,
  },
};

const receiverObservations = ({ count = 21, spikeIndexes = [] } = {}) => {
  let framesDecoded = 1_000;
  let totalDecodeTime = 2;
  let qpSum = 25_000;
  return Array.from({ length: count }, (_, index) => {
    if (index > 0) {
      framesDecoded += 15;
      totalDecodeTime += spikeIndexes.includes(index) ? 1 : 0.045;
      qpSum += 375;
    }
    return {
      capturedAtEpochMs: 10_000 + index * 500,
      sampledAtMs: index * 500,
      measurementWindowId: measurementWindow.id,
      matched: true,
      producerId: "producer-1",
      consumerId: "consumer-1",
      connectionId: "pc-2",
      statId: "in-1",
      ssrc: "222",
      codecMimeType: "video/VP9",
      codecId: "codec-1",
      codecPayloadType: 98,
      codecFmtpLine: "profile-id=0",
      scalabilityMode: "L2T1",
      decoderImplementation: "libvpx",
      powerEfficientDecoder: false,
      framesDecoded,
      totalDecodeTime,
      qpSum,
    };
  });
};

const receiverSnapshot = ({
  decoderImplementation = "libvpx",
  powerEfficientDecoder = false,
  statId = "in-1",
} = {}) => ({
  peerConnections: [
    {
      id: "pc-2",
      stats: [
        {
          id: statId,
          type: "inbound-rtp",
          kind: "video",
          ssrc: 222,
          trackIdentifier: "consumer-1",
          codecId: "codec-1",
          scalabilityMode: "L2T1",
          decoderImplementation,
          powerEfficientDecoder,
        },
        {
          id: "codec-1",
          type: "codec",
          mimeType: "video/VP9",
          payloadType: 98,
          sdpFmtpLine: "profile-id=0",
        },
      ],
    },
  ],
});

test("extracts only the exact producer-bound sender and its encode authority", () => {
  const parameters = {
    encodings: [
      {
        active: true,
        maxBitrate: 1_650_000,
        maxFramerate: 30,
        scalabilityMode: "L2T1",
      },
    ],
  };
  const observation = extractPublisherCodecObservation(
    {
      producerId: "producer-1",
      measurementWindowId: measurementWindow.id,
      snapshot: {
        capturedAt: 12_000,
        peerConnections: [
          {
            id: "pc-1",
            connectionState: "connected",
            iceConnectionState: "connected",
            signalingState: "stable",
            senders: [
              {
                id: "sender-1",
                track: { id: "track-1", kind: "video", readyState: "live" },
                parameters,
                stats: [
                  {
                    id: "out-1",
                    type: "outbound-rtp",
                    kind: "video",
                    ssrc: 111,
                    active: true,
                    codecId: "codec-1",
                    framesEncoded: 100,
                    totalEncodeTime: 1,
                    qpSum: 2_000,
                    bytesSent: 100_000,
                    encoderImplementation: "libvpx",
                    powerEfficientEncoder: false,
                    qualityLimitationReason: "none",
                    qualityLimitationDurations: { none: 4, cpu: 0 },
                    scalabilityMode: "L2T1",
                  },
                  {
                    id: "codec-1",
                    type: "codec",
                    mimeType: "video/VP9",
                    payloadType: 98,
                    sdpFmtpLine: "profile-id=0",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      producerId: "producer-1",
      connectionId: "pc-1",
      senderId: "sender-1",
      trackId: "track-1",
      codecMimeType: "video/VP9",
      expectedEncodingCount: 1,
      senderEncodingSignature: publisherSenderEncodingSignature(parameters),
      observerStartedAtEpochMs: 10_000,
      measurementWindowId: measurementWindow.id,
    },
  );

  assert.equal(observation.matched, true);
  assert.equal(observation.sampledAtMs, 2_000);
  assert.equal(observation.encodings[0].totalEncodeTime, 1);
  assert.equal(observation.encodings[0].keyFramesEncoded, null);
  assert.equal(observation.encodings[0].encoderImplementation, "libvpx");
});

test("publisher performance derives exact 500ms mean, nearest-rank p95, maximum, QP, and limitations", () => {
  const result = assessPublisherCodecPerformance({
    observations: publisherObservations(),
    durationMs: 10_000,
    limits: encodeLimits,
  });

  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.timing.intervalCount, 20);
  assert.equal(result.timing.intervalMeanMsPerFrame, 4);
  assert.equal(result.timing.intervalP95MsPerFrame, 4);
  assert.equal(result.timing.intervalMaximumMsPerFrame, 4);
  assert.equal(result.timing.qp.authority, "authoritative");
  assert.equal(result.timing.qp.fullWindowAverage, 30);
  assert.equal(result.qualityLimitations.cpuRatio, 0);
});

test("a single encode spike hidden by the full average fails the maximum gate", () => {
  const result = assessPublisherCodecPerformance({
    observations: publisherObservations({ spikeIndexes: [10] }),
    durationMs: 10_000,
    limits: encodeLimits,
  });

  assert.equal(result.valid, true);
  assert.equal(result.timing.fullWindowMsPerFrame < 10, true);
  assert.equal(result.timing.intervalMaximumMsPerFrame, 100);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /maximum 100ms\/frame/);
});

test("two encode spikes are caught by nearest-rank p95 as well as maximum", () => {
  const result = assessPublisherCodecPerformance({
    observations: publisherObservations({ spikeIndexes: [10, 15] }),
    durationMs: 10_000,
    limits: encodeLimits,
  });

  assert.equal(result.timing.intervalP95MsPerFrame, 100);
  assert.match(result.productFailures.join("\n"), /p95 100ms\/frame/);
});

test("publisher performance rejects reset, sparse, and path-changing evidence", () => {
  const reset = publisherObservations();
  reset[10].encodings[0].totalEncodeTime = 0.1;
  const resetResult = assessPublisherCodecPerformance({
    observations: reset,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(resetResult.valid, false);
  assert.match(resetResult.harnessFailures.join("\n"), /reset|discontinuous/);

  const sparseResult = assessPublisherCodecPerformance({
    observations: publisherObservations({ count: 5 }),
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(sparseResult.valid, false);
  assert.match(sparseResult.harnessFailures.join("\n"), /sparse/);

  const changed = publisherObservations();
  changed[8].encodings[0].ssrc = 999;
  const changedResult = assessPublisherCodecPerformance({
    observations: changed,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(changedResult.valid, false);
  assert.match(changedResult.harnessFailures.join("\n"), /identity set changed|path changed/);
});

test("publisher performance rejects skipped ticks and timer gaps", () => {
  const skipped = assessPublisherCodecPerformance({
    observations: publisherObservations(),
    durationMs: 10_000,
    limits: encodeLimits,
    skippedTickCount: 1,
  });
  assert.equal(skipped.valid, false);
  assert.match(skipped.harnessFailures.join("\n"), /skipped 1 exact 500ms/);

  const gapped = publisherObservations();
  for (let index = 10; index < gapped.length; index += 1) {
    gapped[index].sampledAtMs += 1_300;
  }
  const gappedResult = assessPublisherCodecPerformance({
    observations: gapped,
    durationMs: 11_300,
    limits: encodeLimits,
  });
  assert.equal(gappedResult.valid, false);
  assert.match(
    gappedResult.harnessFailures.join("\n"),
    /cadence|exact codec path|window/,
  );
});

test("publisher performance permits consistently unavailable QP but rejects partial QP authority", () => {
  const unavailable = assessPublisherCodecPerformance({
    observations: publisherObservations({ omitQp: true }),
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(unavailable.valid, true);
  assert.equal(unavailable.timing.qp.authority, "unavailable");

  const partial = publisherObservations();
  partial[8].encodings[0].qpSum = null;
  const partialResult = assessPublisherCodecPerformance({
    observations: partial,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(partialResult.valid, false);
  assert.match(partialResult.harnessFailures.join("\n"), /QP/);
});

test("publisher CPU quality-limitation ratio is a hard product gate", () => {
  const result = assessPublisherCodecPerformance({
    observations: publisherObservations({ cpuDurationPerInterval: 0.1 }),
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(result.valid, true);
  assert.equal(result.qualityLimitations.cpuRatio, 0.2);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /CPU quality-limitation ratio/);
});

test("publisher quality-limitation resets and implementation drift invalidate", () => {
  const reset = publisherObservations();
  reset[10].encodings[0].qualityLimitationDurations.none = 0.1;
  const resetResult = assessPublisherCodecPerformance({
    observations: reset,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(resetResult.valid, false);
  assert.match(resetResult.harnessFailures.join("\n"), /duration counters reset/);

  const changed = publisherObservations();
  changed[10].encodings[0].encoderImplementation = "changed-encoder";
  const changedResult = assessPublisherCodecPerformance({
    observations: changed,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(changedResult.valid, false);
  assert.match(changedResult.harnessFailures.join("\n"), /implementation/);
});

test("publisher timing remains authoritative when hardware metadata is not exposed", () => {
  const observations = publisherObservations();
  observations.forEach((observation) => {
    observation.encodings[0].encoderImplementation = null;
    observation.encodings[0].powerEfficientEncoder = null;
  });
  const result = assessPublisherCodecPerformance({
    observations,
    durationMs: 10_000,
    limits: encodeLimits,
  });

  assert.equal(result.valid, true);
  assert.equal(result.timing.intervalP95MsPerFrame, 4);
  assert.equal(result.metadata.implementationAuthority, "not-exposed");
  assert.equal(result.metadata.powerEfficientAuthority, "not-exposed");
});

test("publisher rejects partially exposed hardware metadata", () => {
  const observations = publisherObservations();
  observations[10].encodings[0].encoderImplementation = null;
  observations[10].encodings[0].powerEfficientEncoder = null;
  const result = assessPublisherCodecPerformance({
    observations,
    durationMs: 10_000,
    limits: encodeLimits,
  });

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /partial/);
});

test("publisher rejects 625ms cadence, stale shifts, and mixed window tokens", () => {
  const slow = publisherObservations({ count: 17 });
  for (let index = 0; index < slow.length; index += 1) {
    slow[index].capturedAtEpochMs = 10_000 + index * 625;
    slow[index].sampledAtMs = index * 625;
  }
  const slowResult = assessPublisherCodecPerformance({
    observations: slow,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(slowResult.valid, false);
  assert.match(slowResult.harnessFailures.join("\n"), /cadence/);

  const stale = publisherObservations();
  stale.forEach((observation) => {
    observation.capturedAtEpochMs += 1_000;
  });
  const staleResult = assessPublisherCodecPerformance({
    observations: stale,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(staleResult.valid, false);
  assert.match(staleResult.harnessFailures.join("\n"), /outside|boundaries/);

  const mixed = publisherObservations();
  mixed[10].measurementWindowId = "another-window";
  const mixedResult = assessPublisherCodecPerformance({
    observations: mixed,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(mixedResult.valid, false);
  assert.match(mixedResult.harnessFailures.join("\n"), /stale|window/);
});

test("publisher observer metadata accepts actual boundary jitter symmetrically", () => {
  const healthy = assessPublisherCodecPerformanceRaw({
    observations: publisherObservations(),
    measurementWindow,
    observerMetadata: {
      ...observerMetadata,
      observerStartedAtEpochMs: measurementWindow.startedAtEpochMs + 20,
      observerStoppedAtEpochMs: measurementWindow.endedAtEpochMs + 20,
    },
    durationMs: measurementWindow.durationMs,
    limits: encodeLimits,
  });
  assert.equal(healthy.valid, true);

  const late = assessPublisherCodecPerformanceRaw({
    observations: publisherObservations(),
    measurementWindow,
    observerMetadata: {
      ...observerMetadata,
      observerStartedAtEpochMs: measurementWindow.startedAtEpochMs + 251,
    },
    durationMs: measurementWindow.durationMs,
    limits: encodeLimits,
  });
  assert.equal(late.valid, false);
  assert.match(late.harnessFailures.join("\n"), /cadence authority/);
});

test("publisher gates every simulcast encoding without aggregate dilution", () => {
  const observations = publisherObservations();
  observations.forEach((observation, index) => {
    const full = observation.encodings[0];
    full.rid = "f";
    full.totalEncodeTime = 4 + index * 0.9;
    const makeLayer = (rid, ssrc, timePerInterval) => ({
      ...structuredClone(full),
      id: `out-${rid}`,
      ssrc,
      rid,
      totalEncodeTime: 4 + index * timePerInterval,
    });
    observation.encodings = [
      makeLayer("q", 112, 0.03),
      makeLayer("h", 113, 0.03),
      full,
    ];
  });
  const result = assessPublisherCodecPerformance({
    observations,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.equal(result.timing.encodings.length, 3);
  assert.equal(
    result.timing.encodings.find((encoding) => encoding.rid === "f")
      .intervalP95MsPerFrame,
    60,
  );
  assert.match(result.productFailures.join("\n"), /publisher encode f p95/);
  assert.equal(
    result.timing.aggregateService.intervalP95CoreEquivalents > 1,
    true,
  );
});

test("publisher invalidates a stalled simulcast layer and tiny limitation duration coverage", () => {
  const stalled = publisherObservations();
  stalled.forEach((observation) => {
    const second = {
      ...structuredClone(observation.encodings[0]),
      id: "out-2",
      ssrc: 222,
      rid: "q",
    };
    observation.encodings[0].rid = "f";
    observation.encodings.push(second);
  });
  stalled[10].encodings[1].framesEncoded =
    stalled[9].encodings[1].framesEncoded;
  const stalledResult = assessPublisherCodecPerformance({
    observations: stalled,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(stalledResult.valid, false);
  assert.match(stalledResult.harnessFailures.join("\n"), /no frame progress/);

  const tinyCoverage = publisherObservations();
  tinyCoverage.forEach((observation, index) => {
    observation.encodings[0].qualityLimitationDurations = {
      none: 1 + index * 0.0005,
      cpu: 0,
      bandwidth: 0,
      other: 0,
    };
  });
  const coverageResult = assessPublisherCodecPerformance({
    observations: tinyCoverage,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(coverageResult.valid, false);
  assert.match(coverageResult.harnessFailures.join("\n"), /duration coverage/);
});

test("publisher invalidates same-MIME codec identity drift and return", () => {
  const observations = publisherObservations();
  observations[10].encodings[0].codecId = "codec-profile-drift";
  observations[10].encodings[0].codecFmtpLine = "profile-id=2";
  const result = assessPublisherCodecPerformance({
    observations,
    durationMs: 10_000,
    limits: encodeLimits,
  });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /identity set|path changed/);
});

test("receiver performance derives bound decode intervals and exact endpoint metadata", () => {
  const result = assessReceiverCodecPerformance({
    label: "viewer",
    observations: receiverObservations(),
    binding,
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot(),
    durationMs: 10_000,
    limits: decodeLimits,
  });

  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.timing.intervalMeanMsPerFrame, 3);
  assert.equal(result.timing.intervalP95MsPerFrame, 3);
  assert.equal(result.metadata.decoderImplementation, "libvpx");
  assert.equal(result.metadata.powerEfficientDecoder, false);
  assert.equal(result.metadata.decoderImplementationAuthority, "reported");
  assert.equal(result.metadata.powerEfficientDecoderAuthority, "reported");
});

test("receiver timing remains authoritative when hardware metadata is not exposed", () => {
  const observations = receiverObservations().map((observation) => ({
    ...observation,
    decoderImplementation: null,
    powerEfficientDecoder: null,
  }));
  const bindingWithoutHardwareMetadata = structuredClone(binding);
  bindingWithoutHardwareMetadata.expected.decoderImplementation = null;
  bindingWithoutHardwareMetadata.expected.powerEfficientDecoder = null;
  const result = assessReceiverCodecPerformance({
    label: "viewer",
    observations,
    binding: bindingWithoutHardwareMetadata,
    startSnapshot: receiverSnapshot({
      decoderImplementation: null,
      powerEfficientDecoder: null,
    }),
    endSnapshot: receiverSnapshot({
      decoderImplementation: null,
      powerEfficientDecoder: null,
    }),
    durationMs: 10_000,
    limits: decodeLimits,
  });

  assert.equal(result.valid, true);
  assert.equal(result.timing.intervalP95MsPerFrame, 3);
  assert.equal(result.metadata.decoderImplementationAuthority, "not-exposed");
  assert.equal(result.metadata.powerEfficientDecoderAuthority, "not-exposed");
});

test("receiver decode interval spikes cannot hide in a healthy average", () => {
  const result = assessReceiverCodecPerformance({
    label: "viewer",
    observations: receiverObservations({ spikeIndexes: [10] }),
    binding,
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot(),
    durationMs: 10_000,
    limits: decodeLimits,
  });

  assert.equal(result.valid, true);
  assert.equal(result.timing.fullWindowMsPerFrame < 10, true);
  assert.equal(result.timing.intervalMaximumMsPerFrame > 50, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /maximum/);
});

test("receiver performance rejects path changes and decoder metadata changes", () => {
  const changedPath = receiverObservations();
  changedPath[10].statId = "stale-stat";
  const pathResult = assessReceiverCodecPerformance({
    label: "viewer",
    observations: changedPath,
    binding,
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot(),
    durationMs: 10_000,
    limits: decodeLimits,
  });
  assert.equal(pathResult.valid, false);
  assert.match(pathResult.harnessFailures.join("\n"), /exact decoder path changed/);

  const metadataResult = assessReceiverCodecPerformance({
    label: "viewer",
    observations: receiverObservations(),
    binding,
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot({ decoderImplementation: "changed" }),
    durationMs: 10_000,
    limits: decodeLimits,
  });
  assert.equal(metadataResult.valid, false);
  assert.match(metadataResult.harnessFailures.join("\n"), /implementation/);
});

test("receiver performance rejects sparse, reset, and non-500ms evidence", () => {
  const reset = receiverObservations();
  reset[9].totalDecodeTime = 0.1;
  const resetResult = assessReceiverCodecPerformance({
    label: "viewer",
    observations: reset,
    binding,
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot(),
    durationMs: 10_000,
    limits: decodeLimits,
  });
  assert.equal(resetResult.valid, false);
  assert.match(resetResult.harnessFailures.join("\n"), /reset|discontinuous/);

  const sparseResult = assessReceiverCodecPerformance({
    label: "viewer",
    observations: receiverObservations({ count: 5 }),
    binding,
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot(),
    durationMs: 10_000,
    limits: decodeLimits,
  });
  assert.equal(sparseResult.valid, false);
  assert.match(sparseResult.harnessFailures.join("\n"), /sparse/);

  const wrongCadenceResult = assessReceiverCodecPerformance({
    label: "viewer",
    observations: receiverObservations(),
    binding: { ...binding, observationIntervalMs: 450 },
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot(),
    durationMs: 10_000,
    limits: decodeLimits,
  });
  assert.equal(wrongCadenceResult.valid, false);
  assert.match(
    wrongCadenceResult.harnessFailures.join("\n"),
    /exact 500ms window/,
  );
});

test("receiver performance consumes fail-closed scheduler authority", () => {
  for (const invalidBinding of [
    { ...binding, valid: false },
    {
      ...binding,
      observerMetadata: { ...binding.observerMetadata, skippedTickCount: 1 },
    },
    {
      ...binding,
      observerMetadata: { ...binding.observerMetadata, lateTickCount: 1 },
    },
    {
      ...binding,
      observerMetadata: { ...binding.observerMetadata, overlapTickCount: 1 },
    },
    {
      ...binding,
      observerMetadata: {
        ...binding.observerMetadata,
        captureErrors: ["getStats failed"],
      },
    },
    {
      ...binding,
      observerMetadata: {
        ...binding.observerMetadata,
        completedObservationCount: 20,
      },
    },
  ]) {
    const result = assessReceiverCodecPerformance({
      label: "viewer",
      observations: receiverObservations(),
      binding: invalidBinding,
      startSnapshot: receiverSnapshot(),
      endSnapshot: receiverSnapshot(),
      durationMs: measurementWindow.durationMs,
      limits: decodeLimits,
    });
    assert.equal(result.valid, false);
    assert.match(result.harnessFailures.join("\n"), /exact 500ms window/);
  }
});

test("meeting performance invalidates mismatched Chrome hardware identities", () => {
  const publisher = assessPublisherCodecPerformance({
    observations: publisherObservations(),
    durationMs: 10_000,
    limits: encodeLimits,
  });
  const receiver = assessReceiverCodecPerformance({
    label: "viewer",
    observations: receiverObservations(),
    binding,
    startSnapshot: receiverSnapshot(),
    endSnapshot: receiverSnapshot(),
    durationMs: 10_000,
    limits: decodeLimits,
  });
  const process = (label, role, expectedBrowserPid, hardwareIdentityId) => ({
    version: PROCESS_PERFORMANCE_VERSION,
    label,
    role,
    expectedBrowserPid,
    hardwareIdentityId,
    measurementWindow,
    measurementWindowId: measurementWindow.id,
    valid: true,
    passed: true,
    harnessFailures: [],
    productFailures: [],
    failures: [],
  });
  const result = assessMeetingPerformance({
    publisherCodec: publisher,
    receiverCodecs: [receiver],
    browserProcesses: [
      process("publisher", "publisher", 100, "hardware-a"),
      process("viewer", "primary-visual-receiver", 200, "hardware-b"),
    ],
    hardwareIdentities: [
      { complete: true, hardwareIdentityId: "hardware-a" },
      { complete: true, hardwareIdentityId: "hardware-b" },
    ],
    primarySamplerOverhead: { mainThreadDutyRatio: 0.01 },
    measurementWindow,
    expectedReceiverCount: 1,
  });

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /differs/);
});

test("meeting performance rejects version-only, duplicate, and incomplete envelopes", () => {
  const versionOnly = {
    version: CODEC_PERFORMANCE_VERSION,
    valid: true,
    passed: true,
    harnessFailures: [],
    productFailures: [],
    measurementWindow,
  };
  const process = (label, role, pid) => ({
    version: PROCESS_PERFORMANCE_VERSION,
    label,
    role,
    expectedBrowserPid: pid,
    hardwareIdentityId: "hardware-a",
    measurementWindow,
    measurementWindowId: measurementWindow.id,
    valid: true,
    passed: true,
    harnessFailures: [],
    productFailures: [],
    failures: [],
  });
  const result = assessMeetingPerformance({
    publisherCodec: versionOnly,
    receiverCodecs: [{ ...versionOnly, label: "viewer" }],
    browserProcesses: [
      process("publisher", "publisher", 100),
      process("publisher", "primary-visual-receiver", 100),
    ],
    hardwareIdentities: [
      { complete: true, hardwareIdentityId: "hardware-a" },
      { complete: true, hardwareIdentityId: "hardware-a" },
    ],
    primarySamplerOverhead: {},
    measurementWindow,
    expectedReceiverCount: 2,
  });
  assert.equal(result.valid, false);
  assert.match(
    result.harnessFailures.join("\n"),
    /covers|duplicated|roles|authority/,
  );
});

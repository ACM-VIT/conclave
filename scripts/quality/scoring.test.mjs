import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_TO_DISPLAY_LATENCY_VERSION } from "./media-latency.mjs";
import { CODEC_PERFORMANCE_VERSION } from "./codec-performance.mjs";
import { PROCESS_PERFORMANCE_VERSION } from "./process-performance.mjs";
import { getVideoQualityProfile } from "./profiles.mjs";
import {
  mean,
  nearestRankPercentile,
  percentile,
  scoreVideoQualityRun,
  summarizeJitterBufferDelayObservations,
  summarizeMatrix,
  summarizeRepeatability,
} from "./scoring.mjs";

const completeVisualSample = (sample) => ({
  valid: true,
  markerCopies: 3,
  multiScaleSsim: sample.ssim,
  chromaPsnrDb: sample.psnrDb,
  chromaSsim: sample.ssim,
  meanAbsoluteChromaError: sample.meanAbsoluteLumaError,
  ...sample,
});

const healthySamples = Array.from({ length: 12 }, () =>
  completeVisualSample({
    ssim: 0.9982,
    psnrDb: 53,
    edgeRetention: 0.995,
    meanAbsoluteLumaError: 0.4,
    blockiness: 0,
  }),
);

const buildJitterBufferObservations = (intervalDelaysMs) => {
  let jitterBufferDelay = 0;
  let jitterBufferTargetDelay = 0;
  let jitterBufferMinimumDelay = 0;
  let jitterBufferEmittedCount = 1_000;
  let sampledAtMs = 0;
  return [
    {
      matched: true,
      connectionId: "pc-1",
      statId: "inbound-1",
      ssrc: "1234",
      consumerId: "consumer-1",
      producerId: "producer-1",
      sampledAtMs,
      requestedJitterBufferTargetMs: 40,
      observedJitterBufferTargetMs: 40,
      jitterBufferTargetStatus: "unchanged",
      jitterBufferDelay,
      jitterBufferTargetDelay,
      jitterBufferMinimumDelay,
      jitterBufferEmittedCount,
    },
    ...intervalDelaysMs.map((delayMs) => {
      const emittedFrames = 15;
      sampledAtMs += 500;
      jitterBufferDelay += (delayMs * emittedFrames) / 1000;
      jitterBufferTargetDelay += (delayMs * emittedFrames) / 1000;
      jitterBufferMinimumDelay += (delayMs * emittedFrames) / 1000;
      jitterBufferEmittedCount += emittedFrames;
      return {
        matched: true,
        connectionId: "pc-1",
        statId: "inbound-1",
        ssrc: "1234",
        consumerId: "consumer-1",
        producerId: "producer-1",
        sampledAtMs,
        requestedJitterBufferTargetMs: 40,
        observedJitterBufferTargetMs: 40,
        jitterBufferTargetStatus: "unchanged",
        jitterBufferDelay,
        jitterBufferTargetDelay,
        jitterBufferMinimumDelay,
        jitterBufferEmittedCount,
      };
    }),
  ];
};

const healthyPlayoutPolicy = {
  evidencePresent: true,
  expectedConsumerId: "consumer-1",
  expectedProducerId: "producer-1",
  consumerId: "consumer-1",
  producerId: "producer-1",
  kind: "video",
  type: "webcam",
  requestedTargetMs: 40,
  observedTargetMs: 40,
  status: "unchanged",
};

test("mean and percentile ignore non-numeric values", () => {
  assert.equal(mean([1, null, 3, Number.NaN]), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
});

test("nearest-rank percentile never interpolates an over-budget SLO sample away", () => {
  assert.equal(nearestRankPercentile([10, 10, 10, 80], 0.95), 80);
});

test("jitter-buffer interval evidence uses counter deltas on one bound path", () => {
  const summary = summarizeJitterBufferDelayObservations(
    buildJitterBufferObservations([20, 30, 40, 50, 60]),
  );
  assert.deepEqual(summary, {
    sampleCount: 5,
    p50MsPerFrame: 40,
    p95MsPerFrame: 60,
    maximumMsPerFrame: 60,
    coveredDurationMs: 2_500,
    maximumObservationIntervalMs: 500,
    counterResetCount: 0,
  });
});

test("missing middle latency evidence reduces coverage and exposes the full gap", () => {
  const observations = buildJitterBufferObservations(
    Array.from({ length: 24 }, () => 20),
  );
  delete observations[10].jitterBufferDelay;

  const summary = summarizeJitterBufferDelayObservations(observations);

  assert.equal(summary.sampleCount, 22);
  assert.equal(summary.coveredDurationMs, 11_000);
  assert.equal(summary.maximumObservationIntervalMs, 1_000);
});

test("target and minimum counter resets are detected before numerical recovery", () => {
  for (const field of [
    "jitterBufferTargetDelay",
    "jitterBufferMinimumDelay",
  ]) {
    const observations = buildJitterBufferObservations(
      Array.from({ length: 20 }, () => 20),
    );
    observations[8] = {
      ...observations[8],
      [field]: observations[8][field] - 2,
    };

    const summary = summarizeJitterBufferDelayObservations(observations);

    assert.equal(summary.counterResetCount, 1, field);
  }
});

test("a crisp, smooth, efficient run passes the pristine gate", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: healthySamples,
      cadence: {
        callbackCount: 298,
        freezeDurationMs: 0,
        freezeCount: 0,
        longestGapMs: 42,
        p95FrameGapMs: 36,
      },
      rtc: {
        framesDecodedDelta: 298,
        framesDroppedDelta: 1,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
      consoleErrorCount: 0,
      unexpectedRecoveryCount: 0,
      startup: {
        navigationToFirstDecodeMs: 1_200,
        targetHeightReachedAtNavigationMs: 2_000,
        firstDecodeToTargetHeightMs: 800,
        transitions: [
          { width: 640, height: 360, sinceFirstDecodeMs: 0 },
          { width: 1280, height: 720, sinceFirstDecodeMs: 800 },
        ],
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, true);
  assert.ok(result.score >= 80);
  assert.equal(result.failures.length, 0);
});

test("consumer-generation reset assessment is a fail-closed scored gate", () => {
  const base = {
    durationMs: 10_000,
    targetFps: 30,
    connectionState: "joined",
    enforceConsumerGenerationReset: true,
    visualSamples: healthySamples,
    cadence: { presentedFrameCount: 298, longestGapMs: 42 },
    rtc: {
      framesDecodedDelta: 298,
      averageVideoBitrateBps: 1_350_000,
      frameHeight: 720,
    },
    startup: {
      navigationToFirstDecodeMs: 1_000,
      targetHeightReachedAtNavigationMs: 1_200,
      firstDecodeToTargetHeightMs: 200,
    },
  };

  const legacy = scoreVideoQualityRun(
    base,
    getVideoQualityProfile("pristine"),
  );
  assert.equal(legacy.harnessValid, false);
  assert.match(
    legacy.harnessFailures.join("\n"),
    /reset assessment is missing/,
  );

  const productFailure = scoreVideoQualityRun(
    {
      ...base,
      consumerGenerationReset: {
        version: 1,
        harnessFailures: [],
        productFailures: ["visible interruption exceeded its budget"],
      },
    },
    getVideoQualityProfile("pristine"),
  );
  assert.equal(productFailure.harnessValid, true);
  assert.equal(productFailure.passed, false);
  assert.match(
    productFailure.productFailures.join("\n"),
    /visible interruption/,
  );

  const passing = scoreVideoQualityRun(
    {
      ...base,
      consumerGenerationReset: {
        version: 1,
        harnessFailures: [],
        productFailures: [],
      },
    },
    getVideoQualityProfile("pristine"),
  );
  assert.equal(passing.harnessValid, true);
  assert.equal(passing.passed, true);
});

test("bounded receiver playout delay passes the pristine latency gate", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: healthyPlayoutPolicy,
      mediaPathBinding: {
        observationIntervalMs: 500,
        observations: buildJitterBufferObservations(
          Array.from({ length: 20 }, (_, index) => 35 + (index % 5) * 2),
        ),
      },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        jitterBufferDelayMsPerFrame: 40,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, true);
  assert.equal(result.reliability.jitterBufferDelayMsPerFrame, 40);
  assert.equal(result.reliability.maximumJitterBufferDelayMsPerFrame, 70);
});

test("excess receiver playout delay is a product failure", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: healthyPlayoutPolicy,
      mediaPathBinding: {
        observationIntervalMs: 500,
        observations: buildJitterBufferObservations(
          Array.from({ length: 20 }, (_, index) => 71 + (index % 5)),
        ),
      },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        jitterBufferDelayMsPerFrame: 70.001,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /jitter-buffer delay/);
  assert.ok(result.reliability.score < 100);
  assert.ok(result.reliability.jitterBufferLatencyScorePenalty > 0);
});

test("missing receiver playout-delay evidence invalidates the harness", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: healthyPlayoutPolicy,
      mediaPathBinding: { observationIntervalMs: 500, observations: [] },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.equal(result.productFailures.length, 0);
  assert.match(result.harnessFailures.join("\n"), /delay evidence is missing/);
});

test("p95 receiver playout delay catches a spike hidden by the run average", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: healthyPlayoutPolicy,
      mediaPathBinding: {
        observationIntervalMs: 500,
        observations: buildJitterBufferObservations([
          ...Array.from({ length: 18 }, (_, index) => 30 + (index % 5) * 2),
          110,
          110,
        ]),
      },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        jitterBufferDelayMsPerFrame: 46.7,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, true);
  assert.equal(result.passed, false);
  assert.match(
    result.productFailures.join("\n"),
    /nearest-rank p95 of 500ms interval-average jitter-buffer delay/,
  );
  assert.ok(result.reliability.score < 100);
});

test("sparse jitter-buffer observations invalidate a flattering partial window", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: healthyPlayoutPolicy,
      mediaPathBinding: {
        observationIntervalMs: 500,
        observations: buildJitterBufferObservations([20, 20, 20, 20]),
      },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        jitterBufferDelayMsPerFrame: 20,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.match(result.harnessFailures.join("\n"), /interval samples/);
  assert.match(result.harnessFailures.join("\n"), /coverage/);
});

test("ineffective exact-bound jitter target is a product failure", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: {
        ...healthyPlayoutPolicy,
        observedTargetMs: null,
        status: "unsupported",
      },
      mediaPathBinding: {
        observationIntervalMs: 500,
        observations: buildJitterBufferObservations(
          Array.from({ length: 20 }, () => 20),
        ),
      },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        jitterBufferDelayMsPerFrame: 20,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /not authoritatively applied/);
});

test("mid-window receiver target drift cannot be hidden by healthy final state", () => {
  const observations = buildJitterBufferObservations(
    Array.from({ length: 20 }, () => 20),
  );
  observations[8] = {
    ...observations[8],
    observedJitterBufferTargetMs: 12,
    jitterBufferTargetStatus: "error",
  };
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: healthyPlayoutPolicy,
      mediaPathBinding: { observationIntervalMs: 500, observations },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        jitterBufferDelayMsPerFrame: 20,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /authoritative for only/);
});

test("mid-window jitter counter resets invalidate evidence even after recovery", () => {
  const observations = buildJitterBufferObservations(
    Array.from({ length: 20 }, () => 20),
  );
  for (let index = 9; index < observations.length; index += 1) {
    observations[index] = {
      ...observations[index],
      jitterBufferDelay: observations[index].jitterBufferDelay - 1,
      jitterBufferEmittedCount:
        observations[index].jitterBufferEmittedCount - 200,
    };
  }
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePlayoutLatency: true,
      receiverPlayoutPolicy: healthyPlayoutPolicy,
      mediaPathBinding: { observationIntervalMs: 500, observations },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        jitterBufferDelayMsPerFrame: 20,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.match(result.harnessFailures.join("\n"), /interval counters reset/);
});

test("high-end visual scoring preserves VP9 and VP8 quality separation", () => {
  const base = {
    durationMs: 10_000,
    targetFps: 30,
    connectionState: "joined",
    cadence: { presentedFrameCount: 300, longestGapMs: 40 },
    rtc: {
      framesDecodedDelta: 300,
      frameHeight: 720,
      packetLossRatio: 0,
    },
    startup: {
      navigationToFirstDecodeMs: 1_000,
      targetHeightReachedAtNavigationMs: 1_000,
      firstDecodeToTargetHeightMs: 0,
    },
  };
  const modern = scoreVideoQualityRun(
    {
      ...base,
      visualSamples: Array.from({ length: 12 }, () =>
        completeVisualSample({
        ssim: 0.9983,
        psnrDb: 53.7,
        edgeRetention: 0.9957,
        meanAbsoluteLumaError: 0.34,
        blockiness: 0,
        }),
      ),
      rtc: { ...base.rtc, averageVideoBitrateBps: 1_660_000 },
    },
    getVideoQualityProfile("pristine"),
  );
  const compatible = scoreVideoQualityRun(
    {
      ...base,
      visualSamples: Array.from({ length: 12 }, (_, index) =>
        completeVisualSample({
          ssim: index < 2 ? 0.962 : 0.985,
          psnrDb: index < 2 ? 33.2 : 43.5,
          edgeRetention: index < 2 ? 0.942 : 0.98,
          meanAbsoluteLumaError: index < 2 ? 3.01 : 1.25,
          blockiness: index < 2 ? 0.001 : 0,
        }),
      ),
      rtc: { ...base.rtc, averageVideoBitrateBps: 1_550_000 },
    },
    getVideoQualityProfile("pristine", "native-compat"),
  );

  assert.ok(modern.visual.score > 98);
  assert.ok(compatible.visual.score < 95);
  assert.ok(modern.visual.score - compatible.visual.score >= 10);
  assert.ok(modern.score > compatible.score);
  assert.ok(compatible.visual.tailScore < compatible.visual.meanScore);
});

test("a frozen low-resolution run fails explicit quality gates", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: [
        {
          valid: true,
          ssim: 0.62,
          psnrDb: 18,
          edgeRetention: 0.3,
          meanAbsoluteLumaError: 40,
          blockiness: 1,
        },
      ],
      cadence: {
        callbackCount: 35,
        freezeDurationMs: 3_000,
        freezeCount: 4,
        longestGapMs: 1_600,
      },
      rtc: {
        framesDecodedDelta: 35,
        framesDroppedDelta: 40,
        averageVideoBitrateBps: 2_500_000,
        packetLossRatio: 0.2,
        frameHeight: 180,
      },
      consoleErrorCount: 2,
      unexpectedRecoveryCount: 2,
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, false);
  assert.ok(result.failures.length >= 4);
  assert.ok(result.score < 50);
});

test("motion scoring prefers compositor-presented frames over JS callback count", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: healthySamples,
      cadence: {
        callbackCount: 180,
        presentedFrameCount: 200,
        freezeDurationMs: 0,
        longestGapMs: 50,
      },
      rtc: {
        framesDecodedDelta: 205,
        decodedFramesPerSecond: 20.5,
        framesDroppedDelta: 0,
        averageVideoBitrateBps: 1_000_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
      consoleErrorCount: 0,
      unexpectedRecoveryCount: 0,
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.motion.callbackFps, 18);
  assert.equal(result.motion.presentedFps, 20);
  assert.equal(result.motion.rtcDecodedFps, 20.5);
  assert.equal(result.motion.decodedFps, 20);
  assert.equal(result.motion.frameRateSource, "compositor-presented");
});

test("motion scoring cannot hide a decoder-reported freeze", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: healthySamples,
      cadence: {
        callbackCount: 298,
        presentedFrameCount: 298,
        freezeDurationMs: 0,
        freezeCount: 0,
        longestGapMs: 45,
      },
      rtc: {
        framesDecodedDelta: 298,
        framesDroppedDelta: 0,
        totalFreezesDurationMs: 240,
        freezeCountDelta: 1,
        averageVideoBitrateBps: 1_300_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.motion.freezeDurationMs, 240);
  assert.equal(result.motion.freezeRatio, 0.024);
  assert.equal(result.motion.freezeCount, 1);
  assert.equal(result.motion.freezeEvidenceSource, "rtc");
  assert.ok(result.reliability.score < 100);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.includes("freeze ratio")));
});

test("source-generator load invalidates the harness, not the product", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
      enforceSourceFixtureOverhead: true,
      sourceFixturePerformance: {
        renderedFrameCount: 300,
        renderDurationMs: { p95: 25 },
        renderDutyRatio: 0.12,
        missedRenderDeadlines: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.equal(result.passed, false);
  assert.equal(result.productFailures.length, 0);
  assert.ok(
    result.harnessFailures.some((failure) =>
      failure.includes("source fixture p95 render"),
    ),
  );
});

test("source-generator stalls invalidate the exact measurement window", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 12_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 358, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 358,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
      enforceSourceFixtureOverhead: true,
      sourceFixturePerformance: {
        elapsedMs: 12_000,
        renderedFrameCount: 354,
        renderDurationMs: { p95: 0.6, maximum: 35 },
        renderIntervalMs: { maximum: 216 },
        renderDutyRatio: 0.02,
        missedRenderDeadlines: 1,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.equal(result.productFailures.length, 0);
  assert.ok(
    result.harnessFailures.some((failure) =>
      failure.includes("source fixture maximum render"),
    ),
  );
  assert.ok(
    result.harnessFailures.some((failure) =>
      failure.includes("source fixture maximum interval"),
    ),
  );
});

test("healthy source-generator windows pass the stall and coverage gates", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 12_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 358, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 358,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
      enforceSourceFixtureOverhead: true,
      sourceFixturePerformance: {
        elapsedMs: 12_000,
        renderedFrameCount: 359,
        renderDurationMs: { p95: 0.6, maximum: 1.2 },
        renderIntervalMs: { maximum: 48 },
        renderDutyRatio: 0.02,
        missedRenderDeadlines: 1,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(
    result.harnessFailures.some((failure) =>
      failure.includes("source fixture"),
    ),
    false,
  );
});

test("fixed-cadence runs require ninety percent of scheduled visual samples", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 12_000,
      sampleIntervalMs: 450,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: Array.from({ length: 24 }, (_, index) => ({
        ...healthySamples[index % healthySamples.length],
        frameId: index * 14,
      })),
      cadence: { presentedFrameCount: 358, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 358,
        averageVideoBitrateBps: 1_350_000,
        packetLossRatio: 0,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.ok(
    result.harnessFailures.some((failure) => failure.includes("24/25 required")),
  );
});

test("matrix summary reports pass count and aggregate score", () => {
  const summary = summarizeMatrix([
    { scoring: { passed: true, score: 90 } },
    { scoring: { passed: false, score: 60 } },
  ]);
  assert.deepEqual(summary, {
    passed: 1,
    failed: 1,
    invalid: 0,
    total: 2,
    averageScore: 75,
    minimumScore: 60,
  });
});

test("matrix summary separates invalid harness profiles from product failures", () => {
  const summary = summarizeMatrix([
    { valid: false, scoring: { passed: true, score: 90 } },
    { valid: true, scoring: { passed: false, score: 60 } },
  ]);
  assert.deepEqual(summary, {
    passed: 0,
    failed: 1,
    invalid: 1,
    total: 2,
    averageScore: 60,
    minimumScore: 60,
  });
});

test("repeatability summary exposes run-to-run score and FPS spread", () => {
  const summary = summarizeRepeatability([
    {
      codecScenario: "all-modern",
      profile: { name: "pristine" },
      environment: { hardwareIdentityId: "hardware-a" },
      scoring: {
        score: 98,
        visual: { score: 99 },
        motion: { decodedFps: 29 },
        efficiency: { averageVideoBitrateBps: 1_600_000 },
      },
    },
    {
      codecScenario: "all-modern",
      profile: { name: "pristine" },
      environment: { hardwareIdentityId: "hardware-a" },
      scoring: {
        score: 96,
        visual: { score: 98 },
        motion: { decodedFps: 28 },
        efficiency: { averageVideoBitrateBps: 1_650_000 },
      },
    },
  ]);

  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].score, {
    minimum: 96,
    maximum: 98,
    mean: 97,
    spread: 2,
  });
  assert.equal(summary[0].deliveredFps.spread, 1);
});

test("repeatability excludes invalid runs from ranges and averages", () => {
  const summary = summarizeRepeatability([
    {
      valid: true,
      codecScenario: "all-modern",
      profile: { name: "pristine" },
      environment: { hardwareIdentityId: "hardware-a" },
      scoring: {
        score: 90,
        visual: { score: 91 },
        motion: { decodedFps: 29 },
        efficiency: { averageVideoBitrateBps: 1_500_000 },
      },
    },
    {
      valid: false,
      codecScenario: "all-modern",
      profile: { name: "pristine" },
      environment: { hardwareIdentityId: "hardware-b" },
      scoring: {
        score: 5,
        visual: { score: 5 },
        motion: { decodedFps: 2 },
        efficiency: { averageVideoBitrateBps: 100_000 },
      },
    },
  ]);

  assert.equal(summary.length, 1);
  assert.equal(summary[0].runs, 1);
  assert.equal(summary[0].score.mean, 90);
  assert.equal(summary[0].score.minimum, 90);
});

test("repeatability never mixes unlike or missing hardware", () => {
  const base = {
    valid: true,
    codecScenario: "all-modern",
    profile: { name: "pristine" },
    scoring: {
      score: 90,
      visual: { score: 91 },
      motion: { decodedFps: 29 },
      efficiency: { averageVideoBitrateBps: 1_500_000 },
    },
  };
  const summary = summarizeRepeatability([
    { ...base, environment: { hardwareIdentityId: "hardware-a" } },
    { ...base, environment: { hardwareIdentityId: "hardware-b" } },
  ]);

  assert.equal(summary[0].hardwareConsistent, false);
  assert.equal(summary[0].comparableRuns, 0);
  assert.equal(summary[0].score.mean, null);
  assert.deepEqual(summary[0].hardwareIdentityIds, [
    "hardware-a",
    "hardware-b",
  ]);
});

test("startup convergence is an explicit gate", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      visualSamples: healthySamples,
      cadence: { callbackCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_500,
        targetHeightReachedAtNavigationMs: 9_000,
        firstDecodeToTargetHeightMs: 7_500,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, false);
  assert.ok(
    result.failures.some((failure) => failure.includes("navigation-to-target")),
  );
  assert.ok(
    result.failures.some((failure) =>
      failure.includes("first-decode-to-target"),
    ),
  );
});

test("development runs report cold navigation but gate media convergence only", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforceNavigationStartup: false,
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 298, longestGapMs: 42 },
      rtc: {
        framesDecodedDelta: 298,
        averageVideoBitrateBps: 1_350_000,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 14_000,
        targetHeightReachedAtNavigationMs: 14_500,
        firstDecodeToTargetHeightMs: 500,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, true);
  assert.equal(result.startup.navigationGateEnforced, false);
});

test("full deterministic fixture phase coverage is an explicit harness gate", () => {
  const samples = Array.from({ length: 45 }, (_, index) => ({
    ...healthySamples[index % healthySamples.length],
    frameId: index * 8,
  }));
  const base = {
    durationMs: 12_000,
    targetFps: 30,
    connectionState: "joined",
    enforceFixturePhaseCoverage: true,
    cadence: { presentedFrameCount: 358, longestGapMs: 45 },
    rtc: {
      framesDecodedDelta: 358,
      averageVideoBitrateBps: 1_500_000,
      frameHeight: 720,
    },
  };

  const complete = scoreVideoQualityRun(
    { ...base, visualSamples: samples },
    getVideoQualityProfile("pristine"),
  );
  assert.equal(complete.visual.fixturePhaseCoverage >= 0.95, true);
  assert.equal(
    complete.failures.some((failure) => failure.includes("phase coverage")),
    false,
  );

  const incomplete = scoreVideoQualityRun(
    { ...base, visualSamples: samples.slice(0, 36) },
    getVideoQualityProfile("pristine"),
  );
  assert.equal(
    incomplete.failures.some((failure) => failure.includes("phase coverage")),
    true,
  );
});

test("frame-alignment canary rejects an adjacent-frame comparison race", () => {
  const visualSamples = Array.from({ length: 12 }, () => ({
    ...healthySamples[0],
    alignmentValid: true,
    alignmentCurrentWins: false,
    alignmentMargin: -1.2,
  }));
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforceAlignmentCanary: true,
      visualSamples,
      cadence: { presentedFrameCount: 300, longestGapMs: 40 },
      rtc: {
        framesDecodedDelta: 300,
        averageVideoBitrateBps: 1_600_000,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /alignment canary/);
});

test("native compatibility uses its separately calibrated full-phase floor", () => {
  assert.equal(getVideoQualityProfile("pristine").minimumVisualScore, 88.5);
  assert.equal(
    getVideoQualityProfile("pristine", "native-compat").minimumVisualScore,
    88,
  );
});

test("capture-to-display p95 and maximum are independent product gates", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforceCaptureToDisplayLatency: true,
      captureToDisplayLatency: {
        version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
        valid: true,
        harnessFailures: [],
        p95Ms: 300,
        maximumMs: 600,
      },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 300, longestGapMs: 40 },
      rtc: {
        framesDecodedDelta: 300,
        framesDroppedDelta: 0,
        averageVideoBitrateBps: 1_400_000,
        frameHeight: 720,
      },
      startup: {
        navigationToFirstDecodeMs: 1_000,
        targetHeightReachedAtNavigationMs: 1_000,
        firstDecodeToTargetHeightMs: 0,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /capture-to-display p95/);
  assert.match(result.productFailures.join("\n"), /capture-to-display maximum/);
});

test("invalid capture-to-display authority invalidates the harness", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforceCaptureToDisplayLatency: true,
      captureToDisplayLatency: {
        version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
        valid: false,
        harnessFailures: ["receiver expectedDisplayTime is unavailable"],
      },
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 300, longestGapMs: 40 },
      rtc: {
        framesDecodedDelta: 300,
        framesDroppedDelta: 0,
        averageVideoBitrateBps: 1_400_000,
        frameHeight: 720,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.match(result.harnessFailures.join("\n"), /expectedDisplayTime/);
});

test("p95 gap, maximum gap, and dropped ratio fail independently", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforceFrameCadenceGates: true,
      visualSamples: healthySamples,
      cadence: {
        callbackCount: 300,
        presentedFrameCount: 300,
        p95FrameGapMs: 60,
        longestGapMs: 200,
      },
      rtc: {
        framesDecodedDelta: 300,
        framesDroppedDelta: 10,
        averageVideoBitrateBps: 1_400_000,
        frameHeight: 720,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.match(result.productFailures.join("\n"), /p95 visible-frame gap/);
  assert.match(result.productFailures.join("\n"), /maximum visible-frame gap/);
  assert.match(result.productFailures.join("\n"), /dropped-frame ratio/);
});

test("frame-cadence gates fail closed when evidence is missing", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforceFrameCadenceGates: true,
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 300 },
      rtc: {
        framesDecodedDelta: 300,
        averageVideoBitrateBps: 1_400_000,
        frameHeight: 720,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.match(result.harnessFailures.join("\n"), /visible-frame gap evidence/);
  assert.match(result.harnessFailures.join("\n"), /dropped-frame evidence/);
});

test("frame-cadence gates reject empty or reset decoder counters", () => {
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforceFrameCadenceGates: true,
      visualSamples: healthySamples,
      cadence: {
        callbackCount: 300,
        presentedFrameCount: 300,
        p95FrameGapMs: 40,
        longestGapMs: 45,
      },
      rtc: {
        framesDecodedDelta: 0,
        framesDroppedDelta: 0,
        frameCounterResetDetected: true,
        averageVideoBitrateBps: 1_400_000,
        frameHeight: 720,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, false);
  assert.match(result.harnessFailures.join("\n"), /frame counters reset/);
});

test("all-receiver telemetry prefixes independent failures and requires full coverage", () => {
  const baseInput = {
    durationMs: 10_000,
    targetFps: 30,
    connectionState: "joined",
    enforceAllReceiverTelemetry: true,
    receiverCount: 2,
    visualSamples: healthySamples,
    cadence: { presentedFrameCount: 300, longestGapMs: 40 },
    rtc: {
      framesDecodedDelta: 300,
      averageVideoBitrateBps: 1_400_000,
      frameHeight: 720,
    },
  };
  const result = scoreVideoQualityRun(
    {
      ...baseInput,
      receivers: [
        {
          label: "viewer",
          assessment: {
            version: 1,
            valid: true,
            passed: true,
            harnessFailures: [],
            productFailures: [],
          },
        },
        {
          label: "viewer-2",
          assessment: {
            version: 1,
            valid: true,
            passed: false,
            harnessFailures: [],
            productFailures: ["received video bitrate exceeds profile"],
          },
        },
      ],
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.passed, false);
  assert.match(
    result.productFailures.join("\n"),
    /\[viewer-2\] received video bitrate/,
  );
  assert.deepEqual(result.receiverTelemetry, {
    expectedCount: 2,
    observedCount: 2,
    validCount: 2,
    passedCount: 1,
  });

  const missing = scoreVideoQualityRun(
    { ...baseInput, receivers: [] },
    getVideoQualityProfile("pristine"),
  );
  assert.equal(missing.harnessValid, false);
  assert.match(missing.harnessFailures.join("\n"), /covers 0\/2/);
});

test("meeting performance evidence is a fail-closed scored gate", () => {
  const baseInput = {
    durationMs: 10_000,
    targetFps: 30,
    connectionState: "joined",
    enforcePerformanceEvidence: true,
    visualSamples: healthySamples,
    cadence: { presentedFrameCount: 300, longestGapMs: 40 },
    rtc: {
      framesDecodedDelta: 300,
      averageVideoBitrateBps: 1_000_000,
      frameHeight: 720,
    },
  };
  const missing = scoreVideoQualityRun(
    baseInput,
    getVideoQualityProfile("pristine"),
  );
  assert.equal(missing.harnessValid, false);
  assert.match(missing.harnessFailures.join("\n"), /performance evidence/);

  const malformed = scoreVideoQualityRun(
    {
      ...baseInput,
      performance: {
        version: CODEC_PERFORMANCE_VERSION,
        valid: true,
        passed: true,
        harnessFailures: [],
        productFailures: [],
      },
    },
    getVideoQualityProfile("pristine"),
  );
  assert.equal(malformed.harnessValid, false);
  assert.match(malformed.harnessFailures.join("\n"), /authority|evidence/);

  const measurementWindow = {
    version: 1,
    id: "window-1",
    startedAtEpochMs: 10_000,
    endedAtEpochMs: 20_000,
    durationMs: 10_000,
  };
  const codecResult = (label = null, productFailures = []) => ({
    version: CODEC_PERFORMANCE_VERSION,
    ...(label ? { label } : {}),
    measurementWindow,
    valid: true,
    passed: productFailures.length === 0,
    harnessFailures: [],
    productFailures,
    failures: [...productFailures],
  });
  const processResult = (label, role, expectedBrowserPid) => ({
    version: PROCESS_PERFORMANCE_VERSION,
    label,
    role,
    expectedBrowserPid,
    hardwareIdentityId: "hardware-a",
    measurementWindow,
    measurementWindowId: measurementWindow.id,
    valid: true,
    passed: true,
    harnessFailures: [],
    productFailures: [],
    failures: [],
  });
  const publisher = codecResult(null, ["encode p95 exceeded"]);
  const receiver = codecResult("viewer");
  const publisherProcess = processResult("publisher", "publisher", 100);
  const receiverProcess = processResult(
    "viewer",
    "primary-visual-receiver",
    200,
  );
  const performance = {
    version: CODEC_PERFORMANCE_VERSION,
    measurementWindow,
    expectedReceiverCount: 1,
    valid: true,
    passed: false,
    harnessFailures: [],
    productFailures: ["[publisher] encode p95 exceeded"],
    failures: ["[publisher] encode p95 exceeded"],
    hardwareIdentityId: "hardware-a",
    publisher,
    receivers: [receiver],
    browserProcesses: [publisherProcess, receiverProcess],
    primaryVisualObserver: {
      process: receiverProcess,
      samplerOverhead: { mainThreadDutyRatio: 0.01 },
    },
  };

  const productFailure = scoreVideoQualityRun(
    {
      ...baseInput,
      performance,
    },
    getVideoQualityProfile("pristine"),
  );
  assert.equal(productFailure.harnessValid, true);
  assert.match(productFailure.productFailures.join("\n"), /encode p95/);
  assert.equal(productFailure.performance.version, CODEC_PERFORMANCE_VERSION);

  for (const [name, mutate, expectedFailure] of [
    [
      "duplicate process label and binding",
      (candidate) => {
        candidate.browserProcesses[1].label = "publisher";
      },
      /labels|binding|evidence/,
    ],
    [
      "missing receiver result",
      (candidate) => {
        candidate.receivers = [];
      },
      /coverage|evidence/,
    ],
    [
      "legacy nested receiver result",
      (candidate) => {
        candidate.receivers[0].version = CODEC_PERFORMANCE_VERSION - 1;
      },
      /receiver codec result|evidence/,
    ],
  ]) {
    const candidate = structuredClone(performance);
    mutate(candidate);
    const scored = scoreVideoQualityRun(
      { ...baseInput, performance: candidate },
      getVideoQualityProfile("pristine"),
    );
    assert.equal(scored.harnessValid, false, name);
    assert.match(scored.harnessFailures.join("\n"), expectedFailure, name);
  }
});

test("publisher topology bandwidth authority is enforced by scoring", () => {
  const configured = [
    {
      active: true,
      maxBitrate: 1_650_000,
      maxFramerate: 30,
      scalabilityMode: "L2T1",
    },
  ];
  const publisher = {
    senderBinding: {
      start: {
        matched: true,
        connectionId: "pc-1",
        senderId: "sender-1",
        trackId: "track-1",
        parameters: { encodings: configured },
      },
      end: {
        matched: true,
        connectionId: "pc-1",
        senderId: "sender-1",
        trackId: "track-1",
        parameters: { encodings: configured },
      },
    },
    rtc: {
      averageVideoBitrateBps: 1_760_000,
      counterAuthority: {
        valid: true,
        byteCounterResetDetected: false,
        frameCounterResetDetected: false,
        missingStartStatDetected: false,
      },
      encodings: [
        {
          active: true,
          bitrateBps: 1_700_000,
          codecMimeType: "video/VP9",
          scalabilityMode: "L2T1",
          counterAuthority: {
            valid: true,
            bytesSent: { reset: false },
            framesEncoded: { reset: false },
          },
        },
      ],
    },
  };
  const result = scoreVideoQualityRun(
    {
      durationMs: 10_000,
      targetFps: 30,
      connectionState: "joined",
      enforcePublisherBandwidthAuthority: true,
      codecScenario: "all-modern",
      receiverCount: 1,
      publisher,
      visualSamples: healthySamples,
      cadence: { presentedFrameCount: 300, longestGapMs: 40 },
      rtc: {
        framesDecodedDelta: 300,
        averageVideoBitrateBps: 1_000_000,
        publisherVideoBitrateBps: 1_760_000,
        frameHeight: 720,
      },
    },
    getVideoQualityProfile("pristine"),
  );

  assert.equal(result.harnessValid, true);
  assert.equal(result.publisherBandwidth.valid, true);
  assert.match(result.productFailures.join("\n"), /aggregate bitrate/);
});

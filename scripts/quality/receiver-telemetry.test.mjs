import assert from "node:assert/strict";
import test from "node:test";
import { CAPTURE_TO_DISPLAY_LATENCY_VERSION } from "./media-latency.mjs";
import { getVideoQualityProfile } from "./profiles.mjs";
import {
  assessReceiverTelemetry,
  RECEIVER_TELEMETRY_ASSESSMENT_VERSION,
} from "./receiver-telemetry.mjs";

const observations = Array.from({ length: 21 }, (_, index) => ({
  capturedAtEpochMs: 1_000_000 + index * 500,
  sampledAtMs: index * 500,
  matched: true,
  reasons: [],
  appConnectionState: "joined",
  peerConnectionState: "connected",
  iceConnectionState: "connected",
  signalingState: "stable",
  videoTrackReadyState: "live",
  videoTrackMuted: false,
  connectionId: "pc-viewer",
  statId: "inbound-video",
  ssrc: 1234,
  consumerId: "consumer-final",
  producerId: "producer-final",
  codecMimeType: "video/VP9",
  frameWidth: 1280,
  frameHeight: 720,
  framesDecoded: index * 15,
  framesDropped: 0,
  bytesReceived: index * 100_000,
  packetsReceived: index * 100,
  packetsLost: 0,
  jitter: 0.01,
  jitterBufferDelay: index * 0.3,
  jitterBufferTargetDelay: index * 0.3,
  jitterBufferMinimumDelay: index * 0.1,
  jitterBufferEmittedCount: index * 15,
  requestedJitterBufferTargetMs: 40,
  observedJitterBufferTargetMs: 40,
  jitterBufferTargetStatus: "unchanged",
  spatialLayer: 2,
  temporalLayer: 0,
}));

const healthyReceiver = (overrides = {}) => ({
  label: "viewer-2",
  profile: getVideoQualityProfile("pristine"),
  ok: true,
  mode: "telemetry",
  expectedSamplerMode: "telemetry",
  durationMs: 10_000,
  cadence: {
    callbackCount: 300,
    presentedFrameCount: 300,
    usesRequestVideoFrameCallback: true,
    freezeDurationMs: 0,
    p95FrameGapMs: 35,
    longestGapMs: 45,
  },
  rtc: {
    boundMediaPathMatched: true,
    framesDecodedDelta: 300,
    framesDroppedDelta: 0,
    frameCounterEvidenceValid: true,
    frameCounterResetDetected: false,
    decodedFramesPerSecond: 30,
    totalFreezesDurationMs: 0,
    freezeCountDelta: 0,
    packetsReceivedDelta: 2_000,
    packetsLostDelta: 0,
    packetLossRatio: 0,
    averageVideoBitrateBps: 1_600_000,
    bytesReceivedDelta: 2_000_000,
    jitterBufferDelayMsPerFrame: 20,
    jitterBufferCounterResetDetected: false,
    frameHeight: 720,
    frameWidth: 1280,
  },
  binding: {
    valid: true,
    observationIntervalMs: 500,
    expected: {
      producerId: "producer-final",
      consumerId: "consumer-final",
      connectionId: "pc-viewer",
      statId: "inbound-video",
      ssrc: "1234",
      codecMimeType: "video/vp9",
    },
    observations,
    violations: [],
  },
  peerConnectionStats: { start: { capturedAt: 1 }, end: { capturedAt: 2 } },
  samplerOverhead: {
    pathObservationMs: { p95: 4, maximum: 8 },
    pathObservationDutyRatio: 0.01,
    frameObserverMs: { p95: 0.4, maximum: 1 },
    frameObserverDutyRatio: 0.02,
  },
  captureToDisplayLatency: {
    version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
    valid: true,
    harnessFailures: [],
    p95Ms: 150,
    maximumMs: 200,
  },
  playout: {
    evidencePresent: true,
    expectedConsumerId: "consumer-final",
    expectedProducerId: "producer-final",
    consumerId: "consumer-final",
    producerId: "producer-final",
    kind: "video",
    requestedTargetMs: 40,
    observedTargetMs: 40,
    status: "unchanged",
  },
  network: { valid: true },
  captureAudit: { safe: true, nativeAudioCallCount: 0 },
  connection: { finalState: "joined", pathContinuous: true },
  sourceEvidenceReference:
    "measurement.publisher.fixture.captureToDisplaySource",
  renderedVideo: { width: 1280, height: 720 },
  consoleErrorCount: 0,
  unexpectedRecoveryCount: 0,
  ...overrides,
});

test("healthy passive receiver telemetry passes every independent gate", () => {
  const assessment = assessReceiverTelemetry({
    receiver: healthyReceiver(),
    profile: getVideoQualityProfile("pristine"),
    durationMs: 10_000,
    targetFps: 30,
  });

  assert.equal(assessment.version, RECEIVER_TELEMETRY_ASSESSMENT_VERSION);
  assert.equal(assessment.valid, true);
  assert.equal(assessment.passed, true);
  assert.equal(assessment.metrics.decodedFps, 30);
  assert.equal(assessment.jitterIntervals.sampleCount, 20);
});

test("receiver quality, loss, latency, and bitrate gates fail independently", () => {
  const receiver = healthyReceiver({
    cadence: {
      callbackCount: 200,
      presentedFrameCount: 200,
      usesRequestVideoFrameCallback: true,
      freezeDurationMs: 300,
      p95FrameGapMs: 60,
      longestGapMs: 200,
    },
    rtc: {
      ...healthyReceiver().rtc,
      framesDecodedDelta: 200,
      framesDroppedDelta: 10,
      decodedFramesPerSecond: 20,
      packetsLostDelta: 50,
      packetLossRatio: 0.02,
      averageVideoBitrateBps: 2_200_000,
      jitterBufferDelayMsPerFrame: 80,
    },
    captureToDisplayLatency: {
      version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
      valid: true,
      harnessFailures: [],
      p95Ms: 300,
      maximumMs: 600,
    },
  });
  const assessment = assessReceiverTelemetry({
    receiver,
    profile: getVideoQualityProfile("pristine"),
    durationMs: 10_000,
    targetFps: 30,
  });
  const failures = assessment.productFailures.join("\n");

  assert.equal(assessment.valid, true);
  assert.equal(assessment.passed, false);
  for (const pattern of [
    /decoded FPS/,
    /freeze ratio/,
    /p95 visible-frame gap/,
    /maximum visible-frame gap/,
    /dropped-frame ratio/,
    /packet-loss ratio/,
    /jitter-buffer delay/,
    /capture-to-display p95/,
    /capture-to-display maximum/,
    /received video bitrate/,
  ]) {
    assert.match(failures, pattern);
  }
});

test("missing path, stats, capture, and interval evidence invalidates telemetry", () => {
  const receiver = healthyReceiver({
    binding: null,
    peerConnectionStats: null,
    samplerOverhead: null,
    captureAudit: null,
    network: null,
  });
  const assessment = assessReceiverTelemetry({
    receiver,
    profile: getVideoQualityProfile("pristine"),
    durationMs: 10_000,
    targetFps: 30,
  });

  assert.equal(assessment.valid, false);
  assert.match(assessment.harnessFailures.join("\n"), /media-path binding/);
  assert.match(assessment.harnessFailures.join("\n"), /start\/end/);
  assert.match(assessment.harnessFailures.join("\n"), /capture-safety/);
  assert.match(assessment.harnessFailures.join("\n"), /network profile/);
});

test("the same constrained evidence is gated against its ordered receiver profile", () => {
  const poorReceiver = healthyReceiver({
    profile: getVideoQualityProfile("poor"),
    cadence: {
      callbackCount: 100,
      presentedFrameCount: 100,
      usesRequestVideoFrameCallback: true,
      freezeDurationMs: 800,
      p95FrameGapMs: 170,
      longestGapMs: 700,
    },
    rtc: {
      ...healthyReceiver().rtc,
      framesDecodedDelta: 100,
      framesDroppedDelta: 15,
      decodedFramesPerSecond: 10,
      packetsLostDelta: 200,
      packetLossRatio: 0.1,
      averageVideoBitrateBps: 300_000,
      jitterBufferDelayMsPerFrame: 200,
      frameHeight: 180,
      frameWidth: 320,
    },
    renderedVideo: { width: 320, height: 180 },
    captureToDisplayLatency: {
      version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
      valid: true,
      harnessFailures: [],
      p95Ms: 800,
      maximumMs: 1_600,
    },
  });

  assert.equal(
    assessReceiverTelemetry({
      receiver: poorReceiver,
      profile: getVideoQualityProfile("poor"),
      durationMs: 10_000,
      targetFps: 30,
    }).passed,
    true,
  );
  assert.equal(
    assessReceiverTelemetry({
      receiver: poorReceiver,
      profile: getVideoQualityProfile("pristine"),
      durationMs: 10_000,
      targetFps: 30,
    }).passed,
    false,
  );
});

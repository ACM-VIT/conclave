import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_TO_DISPLAY_LATENCY_VERSION,
  summarizeCaptureToDisplayLatency,
  VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS,
} from "./media-latency.mjs";

const clock = (epoch = 1_000_000) => ({
  performanceTimeOriginEpochMs: epoch - 100,
  performanceNowMs: 100,
  performanceEpochMs: epoch,
  wallClockEpochMs: epoch + 1,
});

const evidence = ({
  frameCount = 20,
  latencyFor = () => 120,
  sourceGeneration = 7,
} = {}) => {
  const sourceStart = 1_000_000;
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    sourceSequence: index,
    markerSequence: index % VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS,
    markerGeneration: Math.floor(
      index / VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS,
    ),
    frameId: index % 360,
    sourceGeneration,
    availableAtEpochMs: sourceStart + index * 33,
  }));
  const observations = frames.map((frame, index) => ({
    markerValid: true,
    markerSequence: frame.markerSequence,
    sourceSequence: frame.sourceSequence,
    markerGeneration: frame.markerGeneration,
    sequenceAmbiguous: false,
    frameId: frame.frameId,
    expectedDisplayTimeAvailable: true,
    presentedAtEpochMs: frame.availableAtEpochMs + latencyFor(index),
    callbackAtEpochMs: frame.availableAtEpochMs + latencyFor(index) - 2,
  }));
  return {
    sourceEvidence: {
      version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
      markerSequenceModulus: VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS,
      sourceGeneration,
      timestampMode: "performance-time-origin-before-request-frame",
      manualFrames: true,
      resetAtEpochMs: sourceStart - 1,
      requestFrameFailureCount: 0,
      clock: clock(sourceStart),
      frames,
    },
    presentationEvidence: {
      version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
      markerSequenceModulus: VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS,
      expectedSourceGeneration: sourceGeneration,
      timestampMode: "request-video-frame-callback-expected-display-time",
      clock: clock(sourceStart + 1_000),
      startedAtEpochMs: observations[0].presentedAtEpochMs - 1,
      stoppedAtEpochMs:
        observations[observations.length - 1].presentedAtEpochMs + 1,
      observations,
    },
    cadence: {
      callbackCount: frameCount,
      presentedFrameCount: frameCount,
    },
  };
};

test("summarizes exact source-to-compositor latency with nearest-rank p95", () => {
  const input = evidence({ latencyFor: (index) => 100 + index });
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, true);
  assert.equal(result.matchedSampleCount, 20);
  assert.equal(result.meanMs, 109.5);
  assert.equal(result.p50Ms, 109.5);
  assert.equal(result.p95Ms, 118);
  assert.equal(result.maximumMs, 119);
  assert.equal(result.sampleCoverageRatio, 1);
});

test("joins a rolling marker safely across source generations", () => {
  const input = evidence({
    frameCount: VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS + 4,
  });
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, true);
  assert.equal(result.sourceMarkerGenerationCount, 2);
  assert.equal(result.sourceMarkerWrapCount, 1);
  assert.equal(
    result.matchedSampleCount,
    VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS + 4,
  );
});

test("rejects generation mismatches and automatic capture timestamps", () => {
  const input = evidence();
  input.presentationEvidence.expectedSourceGeneration = 9;
  input.sourceEvidence.manualFrames = false;
  input.sourceEvidence.timestampMode = "automatic-canvas-capture";
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /generation/);
  assert.match(result.harnessFailures.join("\n"), /requestFrame/);
});

test("fails closed on missing expectedDisplayTime and sparse observations", () => {
  const input = evidence();
  input.presentationEvidence.observations =
    input.presentationEvidence.observations.slice(0, 4);
  input.presentationEvidence.observations[0].expectedDisplayTimeAvailable = false;
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /expectedDisplayTime/);
  assert.match(result.harnessFailures.join("\n"), /samples cover/);
  assert.match(result.harnessFailures.join("\n"), /temporal coverage/);
});

test("accepts callback-complete latency when rVFC coalesces presented frames", () => {
  const input = evidence();
  input.presentationEvidence.observations =
    input.presentationEvidence.observations.filter(
      (_observation, index) => index === 0 || index === 19 || index % 3 !== 0,
    );
  input.cadence.callbackCount =
    input.presentationEvidence.observations.length;
  input.cadence.presentedFrameCount = 20;

  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, true);
  assert.equal(result.sampleCoverageRatio, 1);
  assert.equal(result.presentedFrameSampleRatio, 0.7);
  assert.ok(result.windowCoverageRatio >= 0.9);
});

test("fails closed on negative latency and browser clock anomalies", () => {
  const input = evidence();
  input.presentationEvidence.observations[4].presentedAtEpochMs =
    input.sourceEvidence.frames[4].availableAtEpochMs - 1;
  input.presentationEvidence.clock.wallClockEpochMs += 500;
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, false);
  assert.equal(result.negativeLatencyCount, 1);
  assert.match(result.harnessFailures.join("\n"), /negative/);
  assert.match(result.harnessFailures.join("\n"), /clock skew/);
});

test("does not substitute a repeated visual phase for a missing source marker", () => {
  const input = evidence();
  for (const index of [3, 4, 5]) {
    input.presentationEvidence.observations[index].markerSequence += 360;
  }
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, false);
  assert.equal(result.unmatchedObservationCount, 3);
  assert.match(result.harnessFailures.join("\n"), /samples cover/);
});

test("fails closed when receiver and source rolling generations disagree", () => {
  const input = evidence({
    frameCount: VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS + 4,
  });
  const observation =
    input.presentationEvidence.observations[
      VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS
    ];
  observation.sourceSequence = 0;
  observation.markerGeneration = 0;
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /generation/);
});

test("fails closed when a rolling marker is ambiguous across generations", () => {
  const input = evidence({
    frameCount: VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS + 4,
  });
  input.presentationEvidence.observations = [
    input.presentationEvidence.observations[0],
    ...input.presentationEvidence.observations.slice(
      VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS,
    ),
  ];
  input.cadence.callbackCount = input.presentationEvidence.observations.length;
  input.cadence.presentedFrameCount =
    input.presentationEvidence.observations.length;
  const result = summarizeCaptureToDisplayLatency(input);

  assert.equal(result.valid, false);
  assert.ok(result.ambiguousObservationCount > 0);
  assert.match(result.harnessFailures.join("\n"), /multiple source generations/);
});

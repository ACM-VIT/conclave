export const CAPTURE_TO_DISPLAY_LATENCY_VERSION = 1;
export const VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS = 2_048;
export const MINIMUM_CAPTURE_TO_DISPLAY_SAMPLE_COVERAGE = 0.9;
export const MINIMUM_CAPTURE_TO_DISPLAY_WINDOW_COVERAGE = 0.9;
export const MAXIMUM_BROWSER_CLOCK_SKEW_MS = 50;
export const MAXIMUM_CALLBACK_TO_EXPECTED_DISPLAY_SKEW_MS = 1_000;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = Math.min(1, Math.max(0, fraction)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const remainder = position - lower;
  return sorted[lower] * (1 - remainder) + sorted[upper] * remainder;
};

const nearestRankPercentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, fraction)) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
};

const modulo = (value, modulus) => ((value % modulus) + modulus) % modulus;

const validateClock = (clock, label, failures) => {
  const performanceTimeOriginEpochMs = finite(
    clock?.performanceTimeOriginEpochMs,
  );
  const performanceNowMs = finite(clock?.performanceNowMs);
  const performanceEpochMs = finite(clock?.performanceEpochMs);
  const wallClockEpochMs = finite(clock?.wallClockEpochMs);
  if (
    performanceTimeOriginEpochMs === null ||
    performanceNowMs === null ||
    performanceEpochMs === null ||
    wallClockEpochMs === null
  ) {
    failures.push(`${label} clock evidence is incomplete`);
    return;
  }
  const reconstructedEpochMs =
    performanceTimeOriginEpochMs + performanceNowMs;
  if (Math.abs(reconstructedEpochMs - performanceEpochMs) > 1) {
    failures.push(`${label} performance clock is internally inconsistent`);
  }
  const skewMs = Math.abs(performanceEpochMs - wallClockEpochMs);
  if (skewMs > MAXIMUM_BROWSER_CLOCK_SKEW_MS) {
    failures.push(
      `${label} performance/wall clock skew ${round(skewMs)}ms exceeds ${MAXIMUM_BROWSER_CLOCK_SKEW_MS}ms`,
    );
  }
};

/**
 * Join source-frame availability to compositor presentation by the unique
 * rolling marker sequence. Any ambiguity or missing clock authority invalidates
 * the harness instead of turning a repeated fixture phase into false latency.
 */
export function summarizeCaptureToDisplayLatency({
  sourceEvidence,
  presentationEvidence,
  cadence,
  minimumSampleCoverage = MINIMUM_CAPTURE_TO_DISPLAY_SAMPLE_COVERAGE,
  minimumWindowCoverage = MINIMUM_CAPTURE_TO_DISPLAY_WINDOW_COVERAGE,
} = {}) {
  const harnessFailures = [];
  const modulus = Number.isInteger(sourceEvidence?.markerSequenceModulus)
    ? sourceEvidence.markerSequenceModulus
    : null;
  const expectedGeneration = Number.isInteger(
    presentationEvidence?.expectedSourceGeneration,
  )
    ? presentationEvidence.expectedSourceGeneration
    : null;

  if (sourceEvidence?.version !== CAPTURE_TO_DISPLAY_LATENCY_VERSION) {
    harnessFailures.push("source latency evidence is missing or legacy");
  }
  if (presentationEvidence?.version !== CAPTURE_TO_DISPLAY_LATENCY_VERSION) {
    harnessFailures.push("presentation latency evidence is missing or legacy");
  }
  if (
    modulus !== VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS ||
    presentationEvidence?.markerSequenceModulus !== modulus
  ) {
    harnessFailures.push("source and presentation marker sequence contracts differ");
  }
  if (
    !Number.isInteger(sourceEvidence?.sourceGeneration) ||
    expectedGeneration === null ||
    sourceEvidence?.sourceGeneration !== expectedGeneration
  ) {
    harnessFailures.push("source generation is missing or does not match the receiver");
  }
  if (
    sourceEvidence?.timestampMode !==
      "performance-time-origin-before-request-frame" ||
    sourceEvidence?.manualFrames !== true
  ) {
    harnessFailures.push(
      "source timestamps are not bound immediately before manual requestFrame",
    );
  }
  if (
    presentationEvidence?.timestampMode !==
    "request-video-frame-callback-expected-display-time"
  ) {
    harnessFailures.push(
      "receiver presentation timestamps are not authoritative expectedDisplayTime values",
    );
  }
  validateClock(sourceEvidence?.clock, "source", harnessFailures);
  validateClock(presentationEvidence?.clock, "receiver", harnessFailures);
  if (finite(sourceEvidence?.resetAtEpochMs) === null) {
    harnessFailures.push("source latency timeline was not reset at measurement start");
  }
  const requestFrameFailureCount = finite(
    sourceEvidence?.requestFrameFailureCount,
  );
  if (
    !Number.isInteger(requestFrameFailureCount) ||
    requestFrameFailureCount < 0
  ) {
    harnessFailures.push("source requestFrame failure evidence is incomplete");
  } else if (requestFrameFailureCount > 0) {
    harnessFailures.push(
      `source requestFrame failed ${sourceEvidence.requestFrameFailureCount} time(s)`,
    );
  }

  const frames = Array.isArray(sourceEvidence?.frames)
    ? sourceEvidence.frames
    : [];
  const sourceByMarker = new Map();
  const sourceBySequence = new Map();
  const sourceMarkerGenerations = new Set();
  let previousSourceSequence = null;
  let previousSourceEpochMs = null;
  for (const frame of frames) {
    const sourceSequence = finite(frame?.sourceSequence);
    const markerSequence = finite(frame?.markerSequence);
    const markerGeneration = finite(frame?.markerGeneration);
    const frameId = finite(frame?.frameId);
    const availableAtEpochMs = finite(frame?.availableAtEpochMs);
    if (
      !Number.isInteger(sourceSequence) ||
      !Number.isInteger(markerSequence) ||
      !Number.isInteger(markerGeneration) ||
      !Number.isInteger(frameId) ||
      availableAtEpochMs === null ||
      frame?.sourceGeneration !== expectedGeneration ||
      modulus === null ||
      modulo(sourceSequence, modulus) !== markerSequence ||
      Math.floor(sourceSequence / modulus) !== markerGeneration ||
      modulo(sourceSequence, 360) !== frameId
    ) {
      harnessFailures.push("source frame timeline contains malformed evidence");
      continue;
    }
    if (
      previousSourceSequence !== null &&
      sourceSequence !== previousSourceSequence + 1
    ) {
      harnessFailures.push("source frame sequence is not contiguous");
    }
    if (
      previousSourceEpochMs !== null &&
      availableAtEpochMs <= previousSourceEpochMs
    ) {
      harnessFailures.push("source frame timestamps are not strictly monotonic");
    }
    if (sourceBySequence.has(sourceSequence)) {
      harnessFailures.push(`source sequence ${sourceSequence} is duplicated`);
    } else {
      sourceBySequence.set(sourceSequence, frame);
      const markerFrames = sourceByMarker.get(markerSequence) ?? [];
      markerFrames.push(frame);
      sourceByMarker.set(markerSequence, markerFrames);
      sourceMarkerGenerations.add(markerGeneration);
    }
    previousSourceSequence = sourceSequence;
    previousSourceEpochMs = availableAtEpochMs;
  }
  if (frames.length < 2) {
    harnessFailures.push("source frame timeline is too sparse");
  } else if (frames[0]?.sourceSequence !== 0) {
    harnessFailures.push("source frame timeline does not begin at reset sequence zero");
  }
  const resetAtEpochMs = finite(sourceEvidence?.resetAtEpochMs);
  if (
    resetAtEpochMs !== null &&
    finite(frames[0]?.availableAtEpochMs) !== null &&
    frames[0].availableAtEpochMs < resetAtEpochMs
  ) {
    harnessFailures.push("source frame timeline begins before its measurement reset");
  }

  const observations = Array.isArray(presentationEvidence?.observations)
    ? presentationEvidence.observations
    : [];
  const latencies = [];
  let unmatchedObservationCount = 0;
  let ambiguousObservationCount = 0;
  let unavailableExpectedDisplayTimeCount = 0;
  let negativeLatencyCount = 0;
  let previousPresentationEpochMs = null;
  let previousMatchedSourceSequence = null;
  let firstMatchedPresentationEpochMs = null;
  let lastMatchedPresentationEpochMs = null;

  for (const observation of observations) {
    const presentedAtEpochMs = finite(observation?.presentedAtEpochMs);
    const callbackAtEpochMs = finite(observation?.callbackAtEpochMs);
    const markerSequence = finite(observation?.markerSequence);
    if (observation?.expectedDisplayTimeAvailable !== true) {
      unavailableExpectedDisplayTimeCount += 1;
      continue;
    }
    if (presentedAtEpochMs === null) {
      harnessFailures.push("receiver presentation timeline contains a non-finite timestamp");
      continue;
    }
    if (
      callbackAtEpochMs === null ||
      Math.abs(presentedAtEpochMs - callbackAtEpochMs) >
        MAXIMUM_CALLBACK_TO_EXPECTED_DISPLAY_SKEW_MS
    ) {
      harnessFailures.push(
        "receiver expectedDisplayTime is inconsistent with its callback clock",
      );
    }
    if (
      previousPresentationEpochMs !== null &&
      presentedAtEpochMs <= previousPresentationEpochMs
    ) {
      harnessFailures.push(
        "receiver presentation timestamps are not strictly monotonic",
      );
    }
    previousPresentationEpochMs = presentedAtEpochMs;
    if (
      observation?.markerValid !== true ||
      observation?.sequenceAmbiguous === true ||
      !Number.isInteger(markerSequence)
    ) {
      unmatchedObservationCount += 1;
      continue;
    }
    if (
      modulus === null ||
      markerSequence < 0 ||
      markerSequence >= modulus ||
      !Number.isInteger(observation?.sourceSequence) ||
      !Number.isInteger(observation?.markerGeneration)
    ) {
      harnessFailures.push("receiver marker sequence evidence is malformed");
      unmatchedObservationCount += 1;
      continue;
    }
    const candidates = (sourceByMarker.get(markerSequence) ?? []).filter(
      (source) =>
        (previousMatchedSourceSequence === null ||
          source.sourceSequence >= previousMatchedSourceSequence) &&
        (source.availableAtEpochMs <= presentedAtEpochMs ||
          source.sourceSequence === observation.sourceSequence),
    );
    if (candidates.length === 0) {
      unmatchedObservationCount += 1;
      continue;
    }
    if (candidates.length > 1) {
      ambiguousObservationCount += 1;
      unmatchedObservationCount += 1;
      harnessFailures.push(
        `receiver marker ${markerSequence} matches multiple source generations`,
      );
      continue;
    }
    const [source] = candidates;
    if (
      observation.sourceSequence !== source.sourceSequence ||
      observation.markerGeneration !== source.markerGeneration ||
      observation.frameId !== source.frameId
    ) {
      harnessFailures.push(
        "receiver rolling-marker generation does not match the source timeline",
      );
      unmatchedObservationCount += 1;
      continue;
    }
    const latencyMs = presentedAtEpochMs - source.availableAtEpochMs;
    if (latencyMs < 0) {
      negativeLatencyCount += 1;
      continue;
    }
    latencies.push(latencyMs);
    previousMatchedSourceSequence = source.sourceSequence;
    firstMatchedPresentationEpochMs ??= presentedAtEpochMs;
    lastMatchedPresentationEpochMs = presentedAtEpochMs;
  }

  if (unavailableExpectedDisplayTimeCount > 0) {
    harnessFailures.push(
      `${unavailableExpectedDisplayTimeCount} presentation observation(s) lacked expectedDisplayTime`,
    );
  }
  if (negativeLatencyCount > 0) {
    harnessFailures.push(
      `${negativeLatencyCount} capture-to-display sample(s) were negative`,
    );
  }

  const presentedFrameCount = finite(cadence?.presentedFrameCount);
  const callbackCount = finite(cadence?.callbackCount);
  if (
    !Number.isInteger(presentedFrameCount) ||
    presentedFrameCount <= 0 ||
    !Number.isInteger(callbackCount) ||
    callbackCount <= 0
  ) {
    harnessFailures.push("compositor presented-frame coverage is unavailable");
  } else {
    if (observations.length !== callbackCount) {
      harnessFailures.push(
        `presentation observations ${observations.length} do not match ${callbackCount} compositor callbacks`,
      );
    }
    if (presentedFrameCount < callbackCount) {
      harnessFailures.push(
        "compositor presented-frame count is smaller than its callback count",
      );
    }
  }
  // rVFC may coalesce notifications while `presentedFrames` proves that the
  // compositor continued presenting. Latency can only be joined for callbacks
  // that actually ran, so callback matches are the sample-coverage authority;
  // temporal window coverage independently prevents a sparse cluster from
  // masquerading as a full-window distribution.
  const requiredSampleCount = Number.isInteger(callbackCount)
    ? Math.max(4, Math.ceil(callbackCount * minimumSampleCoverage))
    : null;
  const sampleCoverageRatio =
    Number.isInteger(callbackCount) && callbackCount > 0
      ? latencies.length / callbackCount
      : null;
  const presentedFrameSampleRatio =
    Number.isInteger(presentedFrameCount) && presentedFrameCount > 0
      ? latencies.length / presentedFrameCount
      : null;
  if (
    requiredSampleCount === null ||
    latencies.length < requiredSampleCount ||
    sampleCoverageRatio === null ||
    sampleCoverageRatio < minimumSampleCoverage
  ) {
    harnessFailures.push(
      `capture-to-display samples cover ${latencies.length}/${callbackCount ?? "missing"} compositor callbacks; minimum ratio is ${minimumSampleCoverage}`,
    );
  }

  const startedAtEpochMs = finite(presentationEvidence?.startedAtEpochMs);
  const stoppedAtEpochMs = finite(presentationEvidence?.stoppedAtEpochMs);
  const evidenceWindowMs =
    startedAtEpochMs !== null &&
    stoppedAtEpochMs !== null &&
    stoppedAtEpochMs > startedAtEpochMs
      ? stoppedAtEpochMs - startedAtEpochMs
      : null;
  const coveredWindowMs =
    firstMatchedPresentationEpochMs !== null &&
    lastMatchedPresentationEpochMs !== null &&
    lastMatchedPresentationEpochMs >= firstMatchedPresentationEpochMs
      ? lastMatchedPresentationEpochMs - firstMatchedPresentationEpochMs
      : null;
  const windowCoverageRatio =
    evidenceWindowMs !== null && coveredWindowMs !== null
      ? coveredWindowMs / evidenceWindowMs
      : null;
  if (
    windowCoverageRatio === null ||
    windowCoverageRatio < minimumWindowCoverage
  ) {
    harnessFailures.push(
      `capture-to-display temporal coverage ${round(windowCoverageRatio, 4) ?? "missing"} is below ${minimumWindowCoverage}`,
    );
  }

  return {
    version: CAPTURE_TO_DISPLAY_LATENCY_VERSION,
    valid: harnessFailures.length === 0,
    harnessFailures: Array.from(new Set(harnessFailures)),
    sourceGeneration: expectedGeneration,
    markerSequenceModulus: modulus,
    sourceFrameCount: frames.length,
    sourceMarkerGenerationCount: sourceMarkerGenerations.size,
    sourceMarkerWrapCount: Math.max(0, sourceMarkerGenerations.size - 1),
    presentationObservationCount: observations.length,
    matchedSampleCount: latencies.length,
    unmatchedObservationCount,
    ambiguousObservationCount,
    unavailableExpectedDisplayTimeCount,
    negativeLatencyCount,
    requiredSampleCount,
    sampleCoverageRatio: round(sampleCoverageRatio, 4),
    presentedFrameSampleRatio: round(presentedFrameSampleRatio, 4),
    coveredWindowMs: round(coveredWindowMs),
    evidenceWindowMs: round(evidenceWindowMs),
    windowCoverageRatio: round(windowCoverageRatio, 4),
    meanMs: round(
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : null,
    ),
    p50Ms: round(percentile(latencies, 0.5)),
    p95Ms: round(nearestRankPercentile(latencies, 0.95)),
    maximumMs: round(latencies.length > 0 ? Math.max(...latencies) : null),
  };
}

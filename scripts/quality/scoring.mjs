import { CAPTURE_TO_DISPLAY_LATENCY_VERSION } from "./media-latency.mjs";
import {
  CODEC_PERFORMANCE_VERSION,
  validateMeetingPerformanceEvidence,
} from "./codec-performance.mjs";
import {
  assessPublisherBandwidth,
  PUBLISHER_BANDWIDTH_ASSESSMENT_VERSION,
} from "./publisher-bandwidth.mjs";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const VIDEO_QUALITY_SCORING_VERSION = 10;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export const mean = (values) => {
  const usable = values.filter((value) => finite(value) !== null);
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
};

export const percentile = (values, percentileValue) => {
  const usable = values
    .filter((value) => finite(value) !== null)
    .slice()
    .sort((left, right) => left - right);
  if (usable.length === 0) return null;
  const position = clamp(percentileValue, 0, 1) * (usable.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return usable[lower];
  const fraction = position - lower;
  return usable[lower] * (1 - fraction) + usable[upper] * fraction;
};

export const nearestRankPercentile = (values, percentileValue) => {
  const usable = values
    .filter((value) => finite(value) !== null)
    .slice()
    .sort((left, right) => left - right);
  if (usable.length === 0) return null;
  const rank = Math.max(
    1,
    Math.ceil(clamp(percentileValue, 0, 1) * usable.length),
  );
  return usable[Math.min(usable.length - 1, rank - 1)];
};

export const summarizeJitterBufferDelayObservations = (observations) => {
  if (!Array.isArray(observations) || observations.length < 2) {
    return {
      sampleCount: 0,
      p50MsPerFrame: null,
      p95MsPerFrame: null,
      maximumMsPerFrame: null,
      coveredDurationMs: null,
      maximumObservationIntervalMs: null,
      counterResetCount: 0,
    };
  }

  const samples = [];
  const evidenceObservationIntervals = [];
  let coveredDurationMs = 0;
  let lastEvidenceObservation = null;
  let counterResetCount = 0;
  const bindingFields = [
    "connectionId",
    "statId",
    "ssrc",
    "consumerId",
    "producerId",
  ];
  const hasSameBinding = (left, right) =>
    bindingFields.every(
      (field) =>
        left?.[field] != null &&
        right?.[field] != null &&
        String(left[field]) === String(right[field]),
    );

  // Track cadence between observations that can independently serve as
  // latency evidence. Keeping this separate from delta calculation makes a
  // missing middle counter visible as one larger observation gap instead of
  // silently reporting the nominal timer cadence on either side of it.
  for (const observation of observations) {
    const sampledAtMs = finite(observation?.sampledAtMs);
    const hasLatencyEvidence =
      observation?.matched !== false &&
      sampledAtMs !== null &&
      finite(observation?.jitterBufferDelay) !== null &&
      finite(observation?.jitterBufferEmittedCount) !== null &&
      bindingFields.every((field) => observation?.[field] != null);
    if (!hasLatencyEvidence) continue;
    if (
      lastEvidenceObservation &&
      hasSameBinding(lastEvidenceObservation, observation)
    ) {
      const previousSampledAtMs = finite(
        lastEvidenceObservation.sampledAtMs,
      );
      if (
        previousSampledAtMs !== null &&
        sampledAtMs > previousSampledAtMs
      ) {
        evidenceObservationIntervals.push(sampledAtMs - previousSampledAtMs);
      }
    }
    lastEvidenceObservation = observation;
  }

  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1];
    const current = observations[index];
    if (previous?.matched === false || current?.matched === false) continue;
    if (!hasSameBinding(previous, current)) continue;
    const previousDelay = finite(previous.jitterBufferDelay);
    const currentDelay = finite(current.jitterBufferDelay);
    const previousCount = finite(previous.jitterBufferEmittedCount);
    const currentCount = finite(current.jitterBufferEmittedCount);
    if (
      previousDelay === null ||
      currentDelay === null ||
      previousCount === null ||
      currentCount === null
    ) {
      continue;
    }
    const delayDelta = currentDelay - previousDelay;
    const emittedDelta = currentCount - previousCount;
    const previousTargetDelay = finite(previous.jitterBufferTargetDelay);
    const currentTargetDelay = finite(current.jitterBufferTargetDelay);
    const previousMinimumDelay = finite(previous.jitterBufferMinimumDelay);
    const currentMinimumDelay = finite(current.jitterBufferMinimumDelay);
    const targetDelayReset =
      previousTargetDelay !== null &&
      currentTargetDelay !== null &&
      currentTargetDelay < previousTargetDelay;
    const minimumDelayReset =
      previousMinimumDelay !== null &&
      currentMinimumDelay !== null &&
      currentMinimumDelay < previousMinimumDelay;
    if (
      delayDelta < 0 ||
      emittedDelta < 0 ||
      targetDelayReset ||
      minimumDelayReset
    ) {
      counterResetCount += 1;
      continue;
    }
    if (emittedDelta === 0) continue;
    const previousSampledAtMs = finite(previous.sampledAtMs);
    const currentSampledAtMs = finite(current.sampledAtMs);
    if (
      previousSampledAtMs !== null &&
      currentSampledAtMs !== null &&
      currentSampledAtMs > previousSampledAtMs
    ) {
      coveredDurationMs += currentSampledAtMs - previousSampledAtMs;
    }
    samples.push((delayDelta * 1000) / emittedDelta);
  }

  return {
    sampleCount: samples.length,
    p50MsPerFrame: round(percentile(samples, 0.5), 3),
    p95MsPerFrame: round(nearestRankPercentile(samples, 0.95), 3),
    maximumMsPerFrame: round(
      samples.length > 0 ? Math.max(...samples) : null,
      3,
    ),
    coveredDurationMs: round(
      samples.length > 0 ? coveredDurationMs : null,
      3,
    ),
    maximumObservationIntervalMs: round(
      evidenceObservationIntervals.length > 0
        ? Math.max(...evidenceObservationIntervals)
        : null,
      3,
    ),
    counterResetCount,
  };
};

export const summarizeReceiverPlayoutPolicyObservations = (observations) => {
  const usable = Array.isArray(observations)
    ? observations.filter((observation) => observation?.matched !== false)
    : [];
  let evidenceCount = 0;
  let authoritativeCount = 0;
  const requestedTargets = [];
  for (const observation of usable) {
    const hasEvidence =
      Object.hasOwn(observation, "requestedJitterBufferTargetMs") &&
      Object.hasOwn(observation, "observedJitterBufferTargetMs") &&
      typeof observation.jitterBufferTargetStatus === "string";
    if (!hasEvidence) continue;
    evidenceCount += 1;
    const requestedTargetMs = finite(
      observation.requestedJitterBufferTargetMs,
    );
    const observedTargetMs = finite(
      observation.observedJitterBufferTargetMs,
    );
    if (requestedTargetMs !== null) requestedTargets.push(requestedTargetMs);
    if (
      requestedTargetMs !== null &&
      requestedTargetMs > 0 &&
      observedTargetMs === requestedTargetMs &&
      ["applied", "unchanged"].includes(
        observation.jitterBufferTargetStatus,
      )
    ) {
      authoritativeCount += 1;
    }
  }
  return {
    observationCount: usable.length,
    evidenceCount,
    authoritativeCount,
    maximumRequestedTargetMs: round(
      requestedTargets.length > 0 ? Math.max(...requestedTargets) : null,
      3,
    ),
  };
};

const linearScore = (value, unacceptable, excellent) => {
  if (finite(value) === null) return 0;
  if (excellent === unacceptable) return value >= excellent ? 100 : 0;
  return clamp(
    ((value - unacceptable) / (excellent - unacceptable)) * 100,
    0,
    100,
  );
};

const inverseLinearScore = (value, excellent, unacceptable) => {
  if (finite(value) === null) return 0;
  return linearScore(unacceptable - value, 0, unacceptable - excellent);
};

export const scoreVisualMetrics = ({
  ssim,
  psnrDb,
  edgeRetention,
  lumaError,
  blockiness,
  chromaPsnrDb = null,
  chromaSsim = null,
  chromaError = null,
}) => {
  // These high-end bounds intentionally retain ranking headroom. The previous
  // .96 / 40 dB ceilings made visibly different VP8 and VP9 output both score
  // 100 after the atomic-frame sampler removed a one-frame comparison race.
  const ssimScore = linearScore(ssim, 0.75, 0.999);
  const psnrScore = linearScore(psnrDb, 20, 55);
  const edgeScore = linearScore(edgeRetention, 0.5, 0.999);
  const lumaScore = inverseLinearScore(lumaError, 0.25, 20);
  const blockinessPenalty = linearScore(blockiness, 0.005, 0.08);
  const chromaPsnrScore = linearScore(chromaPsnrDb, 20, 55);
  const chromaSsimScore = linearScore(chromaSsim, 0.75, 0.999);
  const chromaErrorScore = inverseLinearScore(
    chromaError,
    0.25,
    20,
  );
  return clamp(
    ssimScore * 0.4 +
      psnrScore * 0.13 +
      edgeScore * 0.18 +
      lumaScore * 0.1 +
      chromaPsnrScore * 0.06 +
      chromaSsimScore * 0.08 +
      chromaErrorScore * 0.05 -
      blockinessPenalty * 0.08,
    0,
    100,
  );
};

const summarizeVisual = (samples) => {
  const valid = samples.filter(
    (sample) =>
      sample?.valid === true &&
      sample.markerCopies >= 2 &&
      finite(sample.multiScaleSsim) !== null &&
      finite(sample.psnrDb) !== null &&
      finite(sample.edgeRetention) !== null &&
      finite(sample.meanAbsoluteLumaError) !== null &&
      finite(sample.blockiness) !== null &&
      finite(sample.chromaPsnrDb) !== null &&
      finite(sample.chromaSsim) !== null &&
      finite(sample.meanAbsoluteChromaError) !== null,
  );
  const fixturePhases = Array.from(
    new Set(
      valid
        .filter((sample) => Number.isInteger(sample.frameId))
        .map((sample) => ((sample.frameId % 360) + 360) % 360),
    ),
  ).sort((left, right) => left - right);
  let maximumFixturePhaseGap = 360;
  if (fixturePhases.length > 1) {
    maximumFixturePhaseGap = 0;
    for (let index = 0; index < fixturePhases.length; index += 1) {
      const current = fixturePhases[index];
      const next =
        index + 1 < fixturePhases.length
          ? fixturePhases[index + 1]
          : fixturePhases[0] + 360;
      maximumFixturePhaseGap = Math.max(
        maximumFixturePhaseGap,
        next - current,
      );
    }
  }
  const fixturePhaseCoverage =
    fixturePhases.length > 1
      ? clamp(1 - maximumFixturePhaseGap / 360, 0, 1)
      : 0;
  const ssim = mean(valid.map((sample) => sample.ssim));
  const multiScaleSsim = mean(
    valid.map((sample) => sample.multiScaleSsim ?? sample.ssim),
  );
  const psnrDb = mean(valid.map((sample) => sample.psnrDb));
  const edgeRetention = mean(valid.map((sample) => sample.edgeRetention));
  const lumaError = mean(valid.map((sample) => sample.meanAbsoluteLumaError));
  const blockiness = mean(valid.map((sample) => sample.blockiness));
  const chromaPsnrDb = mean(valid.map((sample) => sample.chromaPsnrDb));
  const chromaSsim = mean(valid.map((sample) => sample.chromaSsim));
  const chromaError = mean(
    valid.map((sample) => sample.meanAbsoluteChromaError),
  );
  const p10Ssim = percentile(valid.map((sample) => sample.ssim), 0.1);
  const p10MultiScaleSsim = percentile(
    valid.map((sample) => sample.multiScaleSsim ?? sample.ssim),
    0.1,
  );
  const p10PsnrDb = percentile(valid.map((sample) => sample.psnrDb), 0.1);
  const p10EdgeRetention = percentile(
    valid.map((sample) => sample.edgeRetention),
    0.1,
  );
  const p90LumaError = percentile(
    valid.map((sample) => sample.meanAbsoluteLumaError),
    0.9,
  );
  const p90Blockiness = percentile(
    valid.map((sample) => sample.blockiness),
    0.9,
  );
  const p10ChromaPsnrDb = percentile(
    valid.map((sample) => sample.chromaPsnrDb),
    0.1,
  );
  const p10ChromaSsim = percentile(
    valid.map((sample) => sample.chromaSsim),
    0.1,
  );
  const p90ChromaError = percentile(
    valid.map((sample) => sample.meanAbsoluteChromaError),
    0.9,
  );
  const alignmentSamples = valid.filter(
    (sample) =>
      sample.alignmentValid === true &&
      typeof sample.alignmentCurrentWins === "boolean",
  );
  const alignmentWinRate =
    alignmentSamples.length > 0
      ? mean(
          alignmentSamples.map((sample) =>
            sample.alignmentCurrentWins ? 1 : 0,
          ),
        )
      : null;
  const alignmentMargin = mean(
    alignmentSamples.map((sample) => sample.alignmentMargin),
  );
  const p10AlignmentMargin = percentile(
    alignmentSamples.map((sample) => sample.alignmentMargin),
    0.1,
  );
  const scoredFrames = valid.map((sample) => ({
    sceneId: Number.isInteger(sample.sceneId) ? sample.sceneId : null,
    score: scoreVisualMetrics({
      ssim: sample.multiScaleSsim ?? sample.ssim,
      psnrDb: sample.psnrDb,
      edgeRetention: sample.edgeRetention,
      lumaError: sample.meanAbsoluteLumaError,
      blockiness: sample.blockiness,
      chromaPsnrDb: sample.chromaPsnrDb,
      chromaSsim: sample.chromaSsim,
      chromaError: sample.meanAbsoluteChromaError,
    }),
  }));
  const sceneScoreDetails = [0, 1, 2].map((sceneId) => {
    const scores = scoredFrames
      .filter((frame) => frame.sceneId === sceneId)
      .map((frame) => frame.score);
    return {
      sceneId,
      sampleCount: scores.length,
      meanScore: mean(scores),
      tailScore: percentile(scores, 0.1),
    };
  });
  // Weight the three camera scenes equally. A callback stall can otherwise
  // under-sample the hardest scene and make the same damaged run look better.
  const populatedSceneScores = sceneScoreDetails.filter(
    (scene) => scene.sampleCount > 0,
  );
  const meanScore =
    populatedSceneScores.length > 0
      ? mean(populatedSceneScores.map((scene) => scene.meanScore))
      : mean(scoredFrames.map((frame) => frame.score));
  const tailScore =
    populatedSceneScores.length > 0
      ? mean(populatedSceneScores.map((scene) => scene.tailScore))
      : percentile(
          scoredFrames.map((frame) => frame.score),
          0.1,
        );
  const sceneScores = sceneScoreDetails.map((scene) => ({
    ...scene,
    meanScore: round(scene.meanScore),
    tailScore: round(scene.tailScore),
  }));
  const score = meanScore * 0.75 + tailScore * 0.25;

  return {
    score: round(score),
    sampleCount: samples.length,
    validSampleCount: valid.length,
    markerDecodeRate:
      samples.length === 0 ? 0 : round(valid.length / samples.length, 4),
    fixturePhaseCoverage: round(fixturePhaseCoverage, 4),
    maximumFixturePhaseGap,
    ssim: round(ssim, 4),
    multiScaleSsim: round(multiScaleSsim, 4),
    psnrDb: round(psnrDb),
    edgeRetention: round(edgeRetention, 4),
    meanAbsoluteLumaError: round(lumaError),
    blockiness: round(blockiness, 4),
    chromaPsnrDb: round(chromaPsnrDb),
    chromaSsim: round(chromaSsim, 4),
    meanAbsoluteChromaError: round(chromaError),
    meanScore: round(meanScore),
    tailScore: round(tailScore),
    sceneScores,
    p10Ssim: round(p10Ssim, 4),
    p10MultiScaleSsim: round(p10MultiScaleSsim, 4),
    p10PsnrDb: round(p10PsnrDb),
    p10EdgeRetention: round(p10EdgeRetention, 4),
    p90MeanAbsoluteLumaError: round(p90LumaError),
    p90Blockiness: round(p90Blockiness, 4),
    p10ChromaPsnrDb: round(p10ChromaPsnrDb),
    p10ChromaSsim: round(p10ChromaSsim, 4),
    p90MeanAbsoluteChromaError: round(p90ChromaError),
    alignmentSampleCount: alignmentSamples.length,
    alignmentWinRate: round(alignmentWinRate, 4),
    alignmentMeanMargin: round(alignmentMargin, 4),
    alignmentP10Margin: round(p10AlignmentMargin, 4),
  };
};

const summarizeMotion = (cadence, rtc, durationMs, targetFps) => {
  const durationSeconds = Math.max(0.001, durationMs / 1000);
  const callbackFps =
    finite(cadence?.callbackCount) === null
      ? null
      : cadence.callbackCount / durationSeconds;
  const presentedFps =
    finite(cadence?.presentedFrameCount) === null
      ? null
      : cadence.presentedFrameCount / durationSeconds;
  const rtcDecodedFps =
    finite(rtc?.decodedFramesPerSecond) !== null
      ? rtc.decodedFramesPerSecond
      : finite(rtc?.framesDecodedDelta) !== null
        ? rtc.framesDecodedDelta / durationSeconds
        : null;
  // rVFC's presentedFrames counter includes compositor frames whose callbacks
  // the JS sampler missed while calculating a visual sample. Prefer it over
  // callback count and decoder counters when it is available.
  const decodedFps = presentedFps ?? rtcDecodedFps ?? callbackFps;
  const compositorFreezeDurationMs = Math.max(
    0,
    finite(cadence?.freezeDurationMs) ?? 0,
  );
  const rtcFreezeDurationMs = Math.max(
    0,
    finite(rtc?.totalFreezesDurationMs) ?? 0,
  );
  // rVFC observes what the compositor presented, while inbound-rtp's
  // totalFreezesDuration is maintained by the decoder. Either can catch a
  // freeze that the other misses, so use the larger duration instead of
  // allowing one observer to erase corroborating evidence from the other.
  const freezeDurationMs = Math.max(
    compositorFreezeDurationMs,
    rtcFreezeDurationMs,
  );
  const freezeRatio = clamp(freezeDurationMs / Math.max(1, durationMs), 0, 1);
  const longestGapMs = Math.max(0, finite(cadence?.longestGapMs) ?? 0);
  const decodedFrames = Math.max(0, finite(rtc?.framesDecodedDelta) ?? 0);
  const droppedFrames = Math.max(0, finite(rtc?.framesDroppedDelta) ?? 0);
  const droppedRatio =
    decodedFrames + droppedFrames > 0
      ? droppedFrames / (decodedFrames + droppedFrames)
      : 0;

  const fpsScore = linearScore(decodedFps, targetFps * 0.45, targetFps * 0.97);
  const freezeScore = inverseLinearScore(freezeRatio, 0, 0.14);
  const gapScore = inverseLinearScore(longestGapMs, 70, 900);
  const droppedScore = inverseLinearScore(droppedRatio, 0.005, 0.2);
  const score =
    fpsScore * 0.5 +
    freezeScore * 0.25 +
    gapScore * 0.15 +
    droppedScore * 0.1;

  return {
    score: round(score),
    callbackFps: round(callbackFps),
    presentedFps: round(presentedFps),
    rtcDecodedFps: round(rtcDecodedFps),
    decodedFps: round(decodedFps),
    frameRateSource:
      presentedFps !== null
        ? "compositor-presented"
        : rtcDecodedFps !== null
          ? "rtc-decoded"
          : "video-frame-callback",
    freezeDurationMs: round(freezeDurationMs),
    freezeRatio: round(freezeRatio, 4),
    freezeCount: Math.max(
      0,
      finite(cadence?.freezeCount) ?? 0,
      finite(rtc?.freezeCountDelta) ?? 0,
    ),
    compositorFreezeDurationMs: round(compositorFreezeDurationMs),
    rtcFreezeDurationMs: round(rtcFreezeDurationMs),
    freezeEvidenceSource:
      compositorFreezeDurationMs > 0 && rtcFreezeDurationMs > 0
        ? "compositor+rtc"
        : rtcFreezeDurationMs > 0
          ? "rtc"
          : compositorFreezeDurationMs > 0
            ? "compositor"
            : "none",
    longestGapMs: round(longestGapMs),
    p95FrameGapMs: round(cadence?.p95FrameGapMs),
    droppedFrames: round(droppedFrames, 0),
    droppedRatio: round(droppedRatio, 4),
  };
};

const summarizeEfficiency = (visual, motion, rtc, profile) => {
  const bitrateBps = finite(
    rtc?.publisherVideoBitrateBps ?? rtc?.averageVideoBitrateBps,
  );
  const budgetBps = profile.targetVideoBitrateBps;
  const budgetScore =
    bitrateBps === null || bitrateBps <= 0
      ? 0
      : clamp((budgetBps / bitrateBps) * 100, 0, 100);
  const deliveredQuality = (visual.score / 100) * (motion.score / 100);
  const qualityDensity =
    bitrateBps === null || bitrateBps <= 0
      ? null
      : deliveredQuality / (bitrateBps / 1_000_000);
  // Leave room to rank high-quality encoders instead of treating every local
  // run above the old 0.48 threshold as equally efficient.
  const qualityDensityTarget = 0.62;
  const densityScore = linearScore(qualityDensity, 0.12, qualityDensityTarget);
  const score = densityScore * 0.6 + budgetScore * 0.4;

  return {
    score: round(score),
    averageVideoBitrateBps: round(bitrateBps, 0),
    receiverVideoBitrateBps: round(
      finite(rtc?.receiverVideoBitrateBps ?? rtc?.averageVideoBitrateBps),
      0,
    ),
    targetVideoBitrateBps: budgetBps,
    budgetRatio:
      bitrateBps === null || bitrateBps <= 0
        ? null
        : round(bitrateBps / budgetBps, 3),
    qualityPerMbps: round(qualityDensity, 4),
  };
};

const summarizeReliability = (input, motion, profile) => {
  const joined = input.connectionState === "joined";
  const consoleErrors = Math.max(0, input.consoleErrorCount ?? 0);
  const recoveries = Math.max(0, input.unexpectedRecoveryCount ?? 0);
  const packetLoss = clamp(finite(input.rtc?.packetLossRatio) ?? 0, 0, 1);
  const jitterBufferDelayMsPerFrame = finite(
    input.rtc?.jitterBufferDelayMsPerFrame,
  );
  const jitterBufferDelayIntervals = summarizeJitterBufferDelayObservations(
    input.mediaPathBinding?.observations,
  );
  const receiverPlayoutPolicyObservations =
    summarizeReceiverPlayoutPolicyObservations(
      input.mediaPathBinding?.observations,
    );
  const observationIntervalMs = finite(
    input.mediaPathBinding?.observationIntervalMs,
  );
  const durationMs = Math.max(1, finite(input.durationMs) ?? 1);
  const expectedIntervalSampleCount =
    observationIntervalMs !== null && observationIntervalMs > 0
      ? Math.floor(durationMs / observationIntervalMs)
      : null;
  const minimumIntervalSampleCount =
    expectedIntervalSampleCount === null
      ? null
      : Math.max(4, Math.ceil(expectedIntervalSampleCount * 0.8));
  const jitterBufferDelayIntervalCoverage = {
    observationIntervalMs: round(observationIntervalMs, 3),
    expectedSampleCount: expectedIntervalSampleCount,
    minimumSampleCount: minimumIntervalSampleCount,
    coverageRatio: round(
      jitterBufferDelayIntervals.coveredDurationMs === null
        ? null
        : jitterBufferDelayIntervals.coveredDurationMs / durationMs,
      4,
    ),
    maximumObservationIntervalMs:
      jitterBufferDelayIntervals.maximumObservationIntervalMs,
    maximumAllowedObservationIntervalMs: round(
      observationIntervalMs === null ? null : observationIntervalMs * 2.5,
      3,
    ),
  };
  let score = joined ? 100 : 0;
  score -= Math.min(35, consoleErrors * 8);
  score -= Math.min(30, recoveries * 10);
  score -= Math.min(30, packetLoss * 180);
  score -= Math.min(35, Math.max(0, motion.freezeRatio ?? 0) * 500);
  score -= Math.min(15, Math.max(0, motion.droppedRatio ?? 0) * 200);
  const latencyBudgetMs = finite(
    profile.maximumJitterBufferDelayMsPerFrame,
  );
  const latencyMeasurements = [
    jitterBufferDelayMsPerFrame,
    jitterBufferDelayIntervals.p95MsPerFrame,
  ].filter((value) => value !== null);
  const worstLatencyMs =
    latencyMeasurements.length > 0
      ? Math.max(...latencyMeasurements)
      : null;
  const latencyBudgetExcessRatio =
    latencyBudgetMs !== null &&
    latencyBudgetMs > 0 &&
    worstLatencyMs !== null &&
    worstLatencyMs > latencyBudgetMs
      ? (worstLatencyMs - latencyBudgetMs) / latencyBudgetMs
      : 0;
  // Crossing an explicit product gate must be reflected in the ranked score,
  // not only in pass/fail metadata. The fixed five-point penalty makes even a
  // narrow threshold miss visible after score rounding; severe misses remain
  // bounded so packet loss and freezes still retain independent headroom.
  const latencyScorePenalty =
    latencyBudgetExcessRatio > 0
      ? Math.min(35, 5 + latencyBudgetExcessRatio * 55)
      : 0;
  score -= latencyScorePenalty;

  return {
    score: round(clamp(score, 0, 100)),
    joined,
    consoleErrorCount: consoleErrors,
    unexpectedRecoveryCount: recoveries,
    packetLossRatio: round(packetLoss, 4),
    freezeRatio: motion.freezeRatio,
    droppedRatio: motion.droppedRatio,
    jitterBufferDelayMsPerFrame: round(jitterBufferDelayMsPerFrame, 3),
    jitterBufferTargetDelayMsPerFrame: round(
      finite(input.rtc?.jitterBufferTargetDelayMsPerFrame),
      3,
    ),
    jitterBufferMinimumDelayMsPerFrame: round(
      finite(input.rtc?.jitterBufferMinimumDelayMsPerFrame),
      3,
    ),
    jitterBufferDelayIntervals,
    jitterBufferDelayIntervalCoverage,
    receiverPlayoutPolicyObservations,
    worstJitterBufferLatencyMs: round(worstLatencyMs, 3),
    jitterBufferLatencyBudgetExcessRatio: round(
      latencyBudgetExcessRatio,
      4,
    ),
    jitterBufferLatencyScorePenalty: round(latencyScorePenalty, 3),
    maximumJitterBufferDelayMsPerFrame:
      profile.maximumJitterBufferDelayMsPerFrame,
  };
};

const summarizeStartup = (startup, profile, enforceNavigationStartup) => {
  const navigationToFirstDecodeMs = finite(startup?.navigationToFirstDecodeMs);
  const navigationToTargetMs = finite(
    startup?.targetHeightReachedAtNavigationMs,
  );
  const firstDecodeToTargetHeightMs = finite(
    startup?.firstDecodeToTargetHeightMs,
  );
  return {
    targetHeight: profile.minimumDecodedHeight,
    targetReached: navigationToTargetMs !== null,
    navigationToFirstDecodeMs: round(navigationToFirstDecodeMs),
    navigationToTargetMs: round(navigationToTargetMs),
    firstDecodeToTargetHeightMs: round(firstDecodeToTargetHeightMs),
    maximumNavigationToTargetMs: profile.maximumNavigationToTargetMs,
    maximumFirstDecodeToTargetMs: profile.maximumFirstDecodeToTargetMs,
    navigationGateEnforced: enforceNavigationStartup,
    transitions: Array.isArray(startup?.transitions)
      ? startup.transitions.map((transition) => ({ ...transition }))
      : [],
  };
};

export function scoreVideoQualityRun(input, profile) {
  const durationMs = Math.max(1, input.durationMs ?? 1);
  const targetFps = Math.max(1, input.targetFps ?? 30);
  const visual = summarizeVisual(input.visualSamples ?? []);
  const motion = summarizeMotion(
    input.cadence ?? {},
    input.rtc ?? {},
    durationMs,
    targetFps,
  );
  const efficiency = summarizeEfficiency(visual, motion, input.rtc ?? {}, profile);
  const publisherBandwidth =
    input.enforcePublisherBandwidthAuthority === true
      ? assessPublisherBandwidth({
          publisher: input.publisher,
          codecScenario: input.codecScenario,
          receiverCount: input.receiverCount,
          qualityPerMbps: efficiency.qualityPerMbps,
        })
      : null;
  const reliability = summarizeReliability(input, motion, profile);
  const startup = summarizeStartup(
    input.startup,
    profile,
    input.enforceNavigationStartup !== false,
  );
  const total =
    visual.score * 0.4 +
    motion.score * 0.25 +
    efficiency.score * 0.2 +
    reliability.score * 0.15;

  const harnessFailures = [];
  const productFailures = [];
  if (input.enforcePerformanceEvidence === true) {
    const performance = input.performance;
    const authorityFailures = validateMeetingPerformanceEvidence(performance);
    if (
      performance?.version !== CODEC_PERFORMANCE_VERSION ||
      authorityFailures.length > 0
    ) {
      harnessFailures.push(
        "meeting process/codec performance evidence is missing or legacy",
      );
      for (const failure of authorityFailures) {
        harnessFailures.push(`performance authority: ${failure}`);
      }
    } else {
      for (const failure of performance.harnessFailures ?? []) {
        harnessFailures.push(`performance: ${failure}`);
      }
      for (const failure of performance.productFailures ?? []) {
        productFailures.push(`performance: ${failure}`);
      }
    }
  }
  if (input.enforcePublisherBandwidthAuthority === true) {
    if (
      publisherBandwidth?.version !==
      PUBLISHER_BANDWIDTH_ASSESSMENT_VERSION
    ) {
      harnessFailures.push(
        "publisher bandwidth authority is missing or legacy",
      );
    } else {
      for (const failure of publisherBandwidth.harnessFailures ?? []) {
        harnessFailures.push(`publisher bandwidth: ${failure}`);
      }
      for (const failure of publisherBandwidth.productFailures ?? []) {
        productFailures.push(`publisher bandwidth: ${failure}`);
      }
    }
  }
  if (input.enforceAllReceiverTelemetry === true) {
    const expectedReceiverCount = finite(input.receiverCount);
    const receivers = Array.isArray(input.receivers) ? input.receivers : [];
    if (
      !Number.isInteger(expectedReceiverCount) ||
      expectedReceiverCount < 1 ||
      receivers.length !== expectedReceiverCount
    ) {
      harnessFailures.push(
        `all-receiver telemetry covers ${receivers.length}/${expectedReceiverCount ?? "missing"} receivers`,
      );
    }
    const labels = new Set();
    for (let index = 0; index < receivers.length; index += 1) {
      const receiver = receivers[index];
      const label =
        typeof receiver?.label === "string" && receiver.label.length > 0
          ? receiver.label
          : `receiver-${index + 1}`;
      if (labels.has(label)) {
        harnessFailures.push(`receiver telemetry label ${label} is duplicated`);
      }
      labels.add(label);
      const assessment = receiver?.assessment;
      if (assessment?.version !== 1) {
        harnessFailures.push(
          `[${label}] receiver telemetry assessment is missing or legacy`,
        );
        continue;
      }
      for (const failure of assessment.harnessFailures ?? []) {
        harnessFailures.push(`[${label}] ${failure}`);
      }
      for (const failure of assessment.productFailures ?? []) {
        productFailures.push(`[${label}] ${failure}`);
      }
    }
  }
  if (input.enforceConsumerGenerationReset === true) {
    const resetAssessment = input.consumerGenerationReset;
    if (resetAssessment?.version !== 1) {
      harnessFailures.push(
        "consumer-generation reset assessment is missing or uses a legacy schema",
      );
    } else {
      for (const failure of resetAssessment.harnessFailures ?? []) {
        harnessFailures.push(`consumer-generation reset: ${failure}`);
      }
      for (const failure of resetAssessment.productFailures ?? []) {
        productFailures.push(`consumer-generation reset: ${failure}`);
      }
    }
  }
  const sampleIntervalMs = finite(input.sampleIntervalMs);
  const expectedVisualSamples =
    sampleIntervalMs !== null && sampleIntervalMs > 0
      ? Math.ceil(durationMs / sampleIntervalMs)
      : 4;
  const minimumVisualSamples = Math.max(
    4,
    Math.ceil(expectedVisualSamples * 0.9),
  );
  if (visual.validSampleCount < minimumVisualSamples) {
    harnessFailures.push(
      `only ${visual.validSampleCount}/${minimumVisualSamples} required visually comparable decoded frames`,
    );
  }
  if (
    input.enforceFixturePhaseCoverage === true &&
    visual.markerDecodeRate < 0.98
  ) {
    harnessFailures.push(
      `marker decode rate ${visual.markerDecodeRate} is below 0.98`,
    );
  }
  if (
    input.enforceFixturePhaseCoverage === true &&
    visual.fixturePhaseCoverage < profile.minimumFixturePhaseCoverage
  ) {
    harnessFailures.push(
      `fixture phase coverage ${visual.fixturePhaseCoverage} is below ${profile.minimumFixturePhaseCoverage}`,
    );
  }
  if (input.enforceAlignmentCanary === true) {
    if (visual.alignmentSampleCount < 4) {
      harnessFailures.push("fewer than four frame-alignment canary samples");
    } else if ((visual.alignmentWinRate ?? 0) < 0.98) {
      harnessFailures.push(
        `frame-alignment canary win rate ${visual.alignmentWinRate ?? 0} is below 0.98`,
      );
    } else if ((visual.alignmentP10Margin ?? Number.NEGATIVE_INFINITY) <= 0) {
      harnessFailures.push(
        `frame-alignment canary p10 margin ${visual.alignmentP10Margin ?? "missing"} is not positive`,
      );
    }
  }
  if (input.enforceSamplerOverhead === true) {
    const p95MainThreadWorkMs = finite(
      input.samplerOverhead?.mainThreadWorkMs?.p95,
    );
    const mainThreadDutyRatio = finite(
      input.samplerOverhead?.mainThreadDutyRatio,
    );
    const maximumMetricBudgetMs = (1000 / targetFps) * 0.5;
    if (
      p95MainThreadWorkMs === null ||
      p95MainThreadWorkMs > maximumMetricBudgetMs
    ) {
      harnessFailures.push(
        `sampler p95 main-thread work ${p95MainThreadWorkMs ?? "missing"}ms exceeds ${round(maximumMetricBudgetMs)}ms`,
      );
    }
    if (mainThreadDutyRatio === null || mainThreadDutyRatio > 0.05) {
      harnessFailures.push(
        `sampler main-thread duty ${mainThreadDutyRatio ?? "missing"} exceeds 0.05`,
      );
    }
    if ((input.samplerOverhead?.skippedVisualSamples ?? 0) > 0) {
      harnessFailures.push("sampler skipped visual samples under its own load");
    }
    if ((input.samplerOverhead?.pendingJobDepthMaximum ?? 0) > 0) {
      harnessFailures.push("sampler queued metric jobs under its own load");
    }
    if (input.enforcePlayoutLatency === true) {
      const p95PathObservationMs = finite(
        input.samplerOverhead?.pathObservationMs?.p95,
      );
      const pathObservationDutyRatio = finite(
        input.samplerOverhead?.pathObservationDutyRatio,
      );
      if (p95PathObservationMs === null || p95PathObservationMs > 125) {
        harnessFailures.push(
          `path observer p95 work ${p95PathObservationMs ?? "missing"}ms exceeds 125ms`,
        );
      }
      if (
        pathObservationDutyRatio === null ||
        pathObservationDutyRatio > 0.15
      ) {
        harnessFailures.push(
          `path observer duty ${pathObservationDutyRatio ?? "missing"} exceeds 0.15`,
        );
      }
    }
  }
  if (input.enforceSourceFixtureOverhead === true) {
    const performance = input.sourceFixturePerformance;
    const p95RenderMs = finite(performance?.renderDurationMs?.p95);
    const maximumRenderMs = finite(performance?.renderDurationMs?.maximum);
    const maximumRenderIntervalMs = finite(
      performance?.renderIntervalMs?.maximum,
    );
    const renderDutyRatio = finite(performance?.renderDutyRatio);
    const renderElapsedMs = Math.max(
      0,
      finite(performance?.elapsedMs) ?? finite(input.durationMs) ?? 0,
    );
    const renderedFrameCount = Math.max(
      0,
      finite(performance?.renderedFrameCount) ?? 0,
    );
    const missedRenderDeadlines = Math.max(
      0,
      finite(performance?.missedRenderDeadlines) ?? 0,
    );
    const maximumRenderBudgetMs = (1000 / targetFps) * 0.5;
    const maximumSingleRenderMs = 1000 / targetFps;
    const maximumRenderIntervalBudgetMs = (1000 / targetFps) * 3;
    const maximumMissedDeadlines = Math.max(
      1,
      Math.floor(renderedFrameCount * 0.01),
    );
    const minimumRenderedFrameCount = Math.floor(
      (renderElapsedMs * targetFps * 0.97) / 1000,
    );
    if (p95RenderMs === null || p95RenderMs > maximumRenderBudgetMs) {
      harnessFailures.push(
        `source fixture p95 render ${p95RenderMs ?? "missing"}ms exceeds ${round(maximumRenderBudgetMs)}ms`,
      );
    }
    if (renderDutyRatio === null || renderDutyRatio > 0.35) {
      harnessFailures.push(
        `source fixture render duty ${renderDutyRatio ?? "missing"} exceeds 0.35`,
      );
    }
    if (
      maximumRenderMs === null ||
      maximumRenderMs > maximumSingleRenderMs
    ) {
      harnessFailures.push(
        `source fixture maximum render ${maximumRenderMs ?? "missing"}ms exceeds ${round(maximumSingleRenderMs)}ms`,
      );
    }
    if (
      maximumRenderIntervalMs === null ||
      maximumRenderIntervalMs > maximumRenderIntervalBudgetMs
    ) {
      harnessFailures.push(
        `source fixture maximum interval ${maximumRenderIntervalMs ?? "missing"}ms exceeds ${round(maximumRenderIntervalBudgetMs)}ms`,
      );
    }
    if (renderedFrameCount < minimumRenderedFrameCount) {
      harnessFailures.push(
        `source fixture rendered ${renderedFrameCount} frames; minimum is ${minimumRenderedFrameCount} for its ${round(renderElapsedMs)}ms measurement window`,
      );
    }
    if (missedRenderDeadlines > maximumMissedDeadlines) {
      harnessFailures.push(
        `source fixture missed ${missedRenderDeadlines} render deadlines; maximum is ${maximumMissedDeadlines}`,
      );
    }
  }
  if (input.enforceSceneCoverage === true) {
    for (const scene of visual.sceneScores) {
      if (scene.sampleCount < 4) {
        harnessFailures.push(
          `fixture scene ${scene.sceneId} has only ${scene.sampleCount} visual samples`,
        );
      }
    }
  }
  if (visual.score < profile.minimumVisualScore) {
    productFailures.push(
      `visual score ${visual.score} is below ${profile.minimumVisualScore}`,
    );
  }
  if ((motion.decodedFps ?? 0) < profile.minimumDecodedFps) {
    productFailures.push(
      `decoded fps ${motion.decodedFps ?? 0} is below ${profile.minimumDecodedFps}`,
    );
  }
  if ((motion.freezeRatio ?? 1) > profile.maximumFreezeRatio) {
    productFailures.push(
      `freeze ratio ${motion.freezeRatio} exceeds ${profile.maximumFreezeRatio}`,
    );
  }
  if (input.enforceFrameCadenceGates === true) {
    const p95FrameGapMs = finite(input.cadence?.p95FrameGapMs);
    const maximumFrameGapMs = finite(input.cadence?.longestGapMs);
    if (p95FrameGapMs === null || maximumFrameGapMs === null) {
      harnessFailures.push("visible-frame gap evidence is missing");
    } else {
      if (p95FrameGapMs > profile.maximumP95FrameGapMs) {
        productFailures.push(
          `p95 visible-frame gap ${round(p95FrameGapMs, 3)}ms exceeds ${profile.maximumP95FrameGapMs}ms`,
        );
      }
      if (maximumFrameGapMs > profile.maximumVisibleFrameGapMs) {
        productFailures.push(
          `maximum visible-frame gap ${round(maximumFrameGapMs, 3)}ms exceeds ${profile.maximumVisibleFrameGapMs}ms`,
        );
      }
    }
    const decodedFrameCount = finite(input.rtc?.framesDecodedDelta);
    const droppedFrameCount = finite(input.rtc?.framesDroppedDelta);
    if (input.rtc?.frameCounterResetDetected === true) {
      harnessFailures.push("decoder frame counters reset during measurement");
    } else if (
      decodedFrameCount === null ||
      droppedFrameCount === null ||
      decodedFrameCount < 0 ||
      droppedFrameCount < 0
    ) {
      harnessFailures.push("decoder dropped-frame evidence is missing");
    } else if (decodedFrameCount + droppedFrameCount <= 0) {
      harnessFailures.push("decoder frame counters contain no samples");
    } else if (motion.droppedRatio > profile.maximumDroppedFrameRatio) {
      productFailures.push(
        `dropped-frame ratio ${motion.droppedRatio} exceeds ${profile.maximumDroppedFrameRatio}`,
      );
    }
  }
  if (input.enforceCaptureToDisplayLatency === true) {
    const latency = input.captureToDisplayLatency;
    if (latency?.version !== CAPTURE_TO_DISPLAY_LATENCY_VERSION) {
      harnessFailures.push(
        "capture-to-display latency assessment is missing or legacy",
      );
    } else if (latency.valid !== true) {
      for (const failure of latency.harnessFailures ?? [
        "capture-to-display latency evidence is invalid",
      ]) {
        harnessFailures.push(`capture-to-display latency: ${failure}`);
      }
    } else {
      const p95Ms = finite(latency.p95Ms);
      const maximumMs = finite(latency.maximumMs);
      if (p95Ms === null || maximumMs === null) {
        harnessFailures.push(
          "capture-to-display latency summary is missing p95 or maximum evidence",
        );
      } else {
        if (p95Ms > profile.maximumCaptureToDisplayP95Ms) {
          productFailures.push(
            `capture-to-display p95 ${round(p95Ms, 3)}ms exceeds ${profile.maximumCaptureToDisplayP95Ms}ms`,
          );
        }
        if (maximumMs > profile.maximumCaptureToDisplayMs) {
          productFailures.push(
            `capture-to-display maximum ${round(maximumMs, 3)}ms exceeds ${profile.maximumCaptureToDisplayMs}ms`,
          );
        }
      }
    }
  }
  if (input.enforcePlayoutLatency === true) {
    const jitterBufferDelayMsPerFrame = finite(
      input.rtc?.jitterBufferDelayMsPerFrame,
    );
    if (input.rtc?.jitterBufferCounterResetDetected === true) {
      harnessFailures.push(
        "receiver jitter-buffer counters reset during the measurement window",
      );
    } else if (jitterBufferDelayMsPerFrame === null) {
      harnessFailures.push(
        "receiver jitter-buffer delay evidence is missing",
      );
    } else if (
      jitterBufferDelayMsPerFrame >
      profile.maximumJitterBufferDelayMsPerFrame
    ) {
      productFailures.push(
        `jitter-buffer delay ${round(jitterBufferDelayMsPerFrame, 3)}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
      );
    }
    const intervalCoverage = reliability.jitterBufferDelayIntervalCoverage;
    if (
      intervalCoverage.minimumSampleCount === null ||
      intervalCoverage.observationIntervalMs === null
    ) {
      harnessFailures.push(
        "receiver jitter-buffer observation cadence metadata is missing",
      );
    } else if (
      reliability.jitterBufferDelayIntervals.sampleCount <
      intervalCoverage.minimumSampleCount
    ) {
      harnessFailures.push(
        `only ${reliability.jitterBufferDelayIntervals.sampleCount}/${intervalCoverage.minimumSampleCount} required receiver jitter-buffer interval samples`,
      );
    }
    if (reliability.jitterBufferDelayIntervals.counterResetCount > 0) {
      harnessFailures.push(
        `receiver jitter-buffer interval counters reset ${reliability.jitterBufferDelayIntervals.counterResetCount} time(s)`,
      );
    }
    if (
      intervalCoverage.coverageRatio === null ||
      intervalCoverage.coverageRatio < 0.9
    ) {
      harnessFailures.push(
        `receiver jitter-buffer interval coverage ${intervalCoverage.coverageRatio ?? "missing"} is below 0.9`,
      );
    }
    if (
      intervalCoverage.maximumObservationIntervalMs === null ||
      intervalCoverage.maximumAllowedObservationIntervalMs === null ||
      intervalCoverage.maximumObservationIntervalMs >
        intervalCoverage.maximumAllowedObservationIntervalMs
    ) {
      harnessFailures.push(
        `receiver jitter-buffer observation gap ${intervalCoverage.maximumObservationIntervalMs ?? "missing"}ms exceeds ${intervalCoverage.maximumAllowedObservationIntervalMs ?? "missing"}ms`,
      );
    }
    if (
      reliability.jitterBufferDelayIntervals.sampleCount > 0 &&
      reliability.jitterBufferDelayIntervals.p95MsPerFrame >
      profile.maximumJitterBufferDelayMsPerFrame
    ) {
      productFailures.push(
        `nearest-rank p95 of ${intervalCoverage.observationIntervalMs}ms interval-average jitter-buffer delay ${reliability.jitterBufferDelayIntervals.p95MsPerFrame}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
      );
    }
    const playoutPolicy = input.receiverPlayoutPolicy;
    const policyObservations =
      reliability.receiverPlayoutPolicyObservations;
    if (
      policyObservations.observationCount === 0 ||
      policyObservations.evidenceCount !== policyObservations.observationCount
    ) {
      harnessFailures.push(
        `exact-bound receiver target policy evidence covers ${policyObservations.evidenceCount}/${policyObservations.observationCount} path observations`,
      );
    } else if (
      policyObservations.authoritativeCount !==
      policyObservations.observationCount
    ) {
      productFailures.push(
        `receiver jitter-buffer target was authoritative for only ${policyObservations.authoritativeCount}/${policyObservations.observationCount} path observations`,
      );
    }
    if (
      policyObservations.maximumRequestedTargetMs !== null &&
      policyObservations.maximumRequestedTargetMs >
        profile.maximumJitterBufferDelayMsPerFrame
    ) {
      productFailures.push(
        `observed requested receiver jitter-buffer target ${policyObservations.maximumRequestedTargetMs}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
      );
    }
    if (playoutPolicy?.evidencePresent !== true) {
      harnessFailures.push(
        "exact-bound receiver jitter-buffer target policy evidence is missing",
      );
    } else if (
      playoutPolicy.kind !== "video" ||
      !playoutPolicy.consumerId ||
      !playoutPolicy.producerId ||
      playoutPolicy.consumerId !== playoutPolicy.expectedConsumerId ||
      playoutPolicy.producerId !== playoutPolicy.expectedProducerId
    ) {
      harnessFailures.push(
        "receiver jitter-buffer target policy is not bound to the measured video consumer",
      );
    } else {
      const requestedTargetMs = finite(playoutPolicy.requestedTargetMs);
      const observedTargetMs = finite(playoutPolicy.observedTargetMs);
      if (
        requestedTargetMs === null ||
        requestedTargetMs <= 0 ||
        observedTargetMs === null ||
        observedTargetMs !== requestedTargetMs ||
        !["applied", "unchanged"].includes(playoutPolicy.status)
      ) {
        productFailures.push(
          `receiver jitter-buffer target was not authoritatively applied (${playoutPolicy.status ?? "missing"}, requested ${requestedTargetMs ?? "missing"}ms, observed ${observedTargetMs ?? "missing"}ms)`,
        );
      } else if (
        requestedTargetMs > profile.maximumJitterBufferDelayMsPerFrame
      ) {
        productFailures.push(
          `requested receiver jitter-buffer target ${requestedTargetMs}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
        );
      }
    }
  }
  if ((input.rtc?.frameHeight ?? 0) < profile.minimumDecodedHeight) {
    productFailures.push(
      `decoded height ${input.rtc?.frameHeight ?? 0} is below ${profile.minimumDecodedHeight}`,
    );
  }
  if (!reliability.joined) {
    productFailures.push("viewer was not joined at the end of the run");
  }
  if (!startup.targetReached) {
    productFailures.push(
      `decoded video never reached the ${profile.minimumDecodedHeight}px startup target`,
    );
  } else {
    if (
      startup.navigationGateEnforced &&
      (startup.navigationToTargetMs ?? Number.POSITIVE_INFINITY) >
      profile.maximumNavigationToTargetMs
    ) {
      productFailures.push(
        `navigation-to-target ${startup.navigationToTargetMs}ms exceeds ${profile.maximumNavigationToTargetMs}ms`,
      );
    }
    if (
      (startup.firstDecodeToTargetHeightMs ?? Number.POSITIVE_INFINITY) >
      profile.maximumFirstDecodeToTargetMs
    ) {
      productFailures.push(
        `first-decode-to-target ${startup.firstDecodeToTargetHeightMs}ms exceeds ${profile.maximumFirstDecodeToTargetMs}ms`,
      );
    }
  }
  const failures = [...harnessFailures, ...productFailures];

  return {
    version: VIDEO_QUALITY_SCORING_VERSION,
    harnessValid: harnessFailures.length === 0,
    passed: failures.length === 0,
    score: round(total),
    grade:
      total >= 92
        ? "A+"
        : total >= 85
          ? "A"
          : total >= 76
            ? "B"
            : total >= 65
              ? "C"
              : total >= 50
                ? "D"
                : "F",
    failures,
    harnessFailures,
    productFailures,
    visual,
    motion,
    efficiency,
    publisherBandwidth,
    reliability,
    startup,
    captureToDisplayLatency: input.captureToDisplayLatency ?? null,
    receiverTelemetry: {
      expectedCount: finite(input.receiverCount),
      observedCount: Array.isArray(input.receivers)
        ? input.receivers.length
        : 0,
      validCount: Array.isArray(input.receivers)
        ? input.receivers.filter(
            (receiver) => receiver?.assessment?.valid === true,
          ).length
        : 0,
      passedCount: Array.isArray(input.receivers)
        ? input.receivers.filter(
            (receiver) => receiver?.assessment?.passed === true,
          ).length
        : 0,
    },
    samplerOverhead: input.samplerOverhead ?? null,
    performance: input.performance ?? null,
  };
}

export function summarizeMatrix(results) {
  const validResults = results.filter(
    (result) =>
      result.valid !== false && result.scoring?.harnessValid !== false,
  );
  const invalid = results.length - validResults.length;
  const passed = validResults.filter((result) => result.scoring?.passed).length;
  const scores = validResults
    .map((result) => result.scoring?.score)
    .filter(Number.isFinite);
  return {
    passed,
    failed: validResults.length - passed,
    invalid,
    total: results.length,
    averageScore: round(mean(scores)),
    minimumScore: scores.length > 0 ? round(Math.min(...scores)) : null,
  };
}

export function summarizeRepeatability(results) {
  const groups = new Map();
  for (const result of results) {
    if (result.valid === false || result.scoring?.harnessValid === false) {
      continue;
    }
    const key = `${result.codecScenario ?? "unspecified"}:${result.profile?.name ?? "unknown"}`;
    const values = groups.get(key) ?? [];
    values.push(result);
    groups.set(key, values);
  }
  return Array.from(groups, ([key, values]) => {
    const hardwareIdentityIds = Array.from(
      new Set(
        values
          .map(
            (result) =>
              result.environment?.hardwareIdentityId ??
              result.measurement?.performance?.hardwareIdentityId ??
              result.scoring?.performance?.hardwareIdentityId ??
              null,
          )
          .filter(Boolean),
      ),
    );
    const hardwareEvidenceComplete = values.every(
      (result) =>
        Boolean(
          result.environment?.hardwareIdentityId ??
            result.measurement?.performance?.hardwareIdentityId ??
            result.scoring?.performance?.hardwareIdentityId,
        ),
    );
    const hardwareConsistent =
      hardwareEvidenceComplete && hardwareIdentityIds.length === 1;
    const field = (reader) =>
      hardwareConsistent ? values.map(reader).filter(Number.isFinite) : [];
    const describe = (numbers) => {
      if (numbers.length === 0) {
        return { minimum: null, maximum: null, mean: null, spread: null };
      }
      const minimum = Math.min(...numbers);
      const maximum = Math.max(...numbers);
      return {
        minimum: round(minimum),
        maximum: round(maximum),
        mean: round(mean(numbers)),
        spread: round(maximum - minimum),
      };
    };
    return {
      key,
      codecScenario: values[0]?.codecScenario ?? null,
      profile: values[0]?.profile?.name ?? null,
      runs: values.length,
      comparableRuns: hardwareConsistent ? values.length : 0,
      hardwareConsistent,
      hardwareIdentityId:
        hardwareConsistent ? hardwareIdentityIds[0] : null,
      hardwareIdentityIds,
      score: describe(field((result) => result.scoring?.score)),
      visual: describe(field((result) => result.scoring?.visual?.score)),
      deliveredFps: describe(
        field((result) => result.scoring?.motion?.decodedFps),
      ),
      jitterBufferAverageMs: describe(
        field(
          (result) =>
            result.scoring?.reliability?.jitterBufferDelayMsPerFrame,
        ),
      ),
      jitterBufferP95Ms: describe(
        field(
          (result) =>
            result.scoring?.reliability?.jitterBufferDelayIntervals
              ?.p95MsPerFrame,
        ),
      ),
      captureToDisplayP95Ms: describe(
        field(
          (result) => result.scoring?.captureToDisplayLatency?.p95Ms,
        ),
      ),
      captureToDisplayMaximumMs: describe(
        field(
          (result) => result.scoring?.captureToDisplayLatency?.maximumMs,
        ),
      ),
      publisherBitrateBps: describe(
        field(
          (result) =>
            result.scoring?.efficiency?.averageVideoBitrateBps,
        ),
      ),
      publisherEncodeP95MsPerFrame: describe(
        field(
          (result) =>
            result.scoring?.performance?.publisher?.timing
              ?.intervalP95MsPerFrame,
        ),
      ),
      receiverDecodeP95MsPerFrame: describe(
        field((result) => {
          const values = (
            result.scoring?.performance?.receivers ?? []
          )
            .map(
              (receiver) =>
                receiver?.timing?.intervalP95MsPerFrame,
            )
            .filter(Number.isFinite);
          return values.length > 0 ? Math.max(...values) : null;
        }),
      ),
      publisherProcessCoreEquivalents: describe(
        field(
          (result) =>
            result.scoring?.performance?.browserProcesses?.find(
              (process) => process?.role === "publisher",
            )?.coreEquivalents,
        ),
      ),
    };
  });
}

export type ConsumerScoreQuality = "good" | "fair" | "poor" | "unknown";

export type ConsumerScoreSample = {
  score: number | null;
  quality: ConsumerScoreQuality;
};

export type ConsumerScoreAdaptationState = {
  consumerId: string;
  quality: ConsumerScoreQuality;
  recoveryQuality: ConsumerScoreQuality | null;
  recoveryStartedAtMs: number | null;
  unknownStartedAtMs: number | null;
};

export const CONSUMER_SCORE_RECOVERY_HOLD_MS = 7_500;

const qualityRank: Record<ConsumerScoreQuality, number> = {
  unknown: 0,
  good: 1,
  fair: 2,
  poor: 3,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseScoreValue = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 10
    ? value
    : null;

export const classifyConsumerScoreQuality = (
  score: number | null,
): ConsumerScoreQuality => {
  if (score === null) return "unknown";
  if (score <= 3) return "poor";
  if (score <= 6) return "fair";
  return "good";
};

export const getConsumerScoreSample = (options: {
  score: unknown;
  currentSpatialLayer: number | null;
  receivedAtMs: number;
  nowMs: number;
}): ConsumerScoreSample => {
  const ageMs = options.nowMs - options.receivedAtMs;
  if (
    !Number.isFinite(options.receivedAtMs) ||
    ageMs < 0 ||
    !isRecord(options.score)
  ) {
    return { score: null, quality: "unknown" };
  }

  const consumerScore = parseScoreValue(options.score.score);
  const aggregateProducerScore = parseScoreValue(
    options.score.producerScore,
  );
  const producerScores = options.score.producerScores;
  let selectedProducerScore: number | null = null;
  let availableProducerScore: number | null = null;

  // mediasoup updates `score` and `currentLayers` from separate worker events.
  // During a layer transition, `producerScore` can therefore still describe
  // the previous "no selected stream" state even though currentLayers already
  // identifies a live stream. Prefer the score for that selected encoding when
  // it is available. Simulcast spatial layers map one-to-one to encodings; all
  // SVC spatial layers share the sole encoding at index zero.
  if (Array.isArray(producerScores) && producerScores.length > 0) {
    const validProducerScores = producerScores
      .map(parseScoreValue)
      .filter((score): score is number => score !== null);
    if (validProducerScores.length > 0) {
      availableProducerScore = Math.max(...validProducerScores);
    }

    if (
      options.currentSpatialLayer !== null &&
      Number.isInteger(options.currentSpatialLayer) &&
      options.currentSpatialLayer >= 0
    ) {
      const selectedEncodingIndex =
        producerScores.length === 1 ? 0 : options.currentSpatialLayer;
      selectedProducerScore = parseScoreValue(
        producerScores[selectedEncodingIndex],
      );
    }
  }

  // With no current layer, producerScore is zero by definition because there
  // is no selected stream. That is not evidence of upstream degradation. Use
  // the best available producer stream to let BWE make the initial selection;
  // an all-zero producerScores array still degrades immediately.
  const producerPathScore =
    options.currentSpatialLayer === null
      ? availableProducerScore ?? aggregateProducerScore
      : selectedProducerScore ?? aggregateProducerScore;
  const candidates = [
    consumerScore,
    producerPathScore,
  ].filter((score): score is number => score !== null);
  const score = candidates.length > 0 ? Math.min(...candidates) : null;
  return {
    score,
    quality: classifyConsumerScoreQuality(score),
  };
};

export const advanceConsumerScoreAdaptation = (options: {
  consumerId: string;
  sampleQuality: ConsumerScoreQuality;
  previousState?: ConsumerScoreAdaptationState;
  nowMs: number;
  recoveryHoldMs?: number;
}): ConsumerScoreAdaptationState => {
  const recoveryHoldMs =
    options.recoveryHoldMs ?? CONSUMER_SCORE_RECOVERY_HOLD_MS;
  const previous = options.previousState;
  if (!previous || previous.consumerId !== options.consumerId) {
    return {
      consumerId: options.consumerId,
      quality: options.sampleQuality,
      recoveryQuality: null,
      recoveryStartedAtMs: null,
      unknownStartedAtMs: null,
    };
  }

  if (options.sampleQuality === "unknown") {
    if (previous.quality !== "fair" && previous.quality !== "poor") {
      return {
        consumerId: options.consumerId,
        quality: "unknown",
        recoveryQuality: null,
        recoveryStartedAtMs: null,
        unknownStartedAtMs: null,
      };
    }

    // mediasoup emits `consumer.on("score")` when the score changes, not as a
    // heartbeat. Therefore an old score for the same live consumer generation
    // remains the latest authoritative score. Only a better score event may
    // start recovery; missing telemetry is never recovery evidence.
    return {
      consumerId: options.consumerId,
      quality: previous.quality,
      recoveryQuality: null,
      recoveryStartedAtMs: null,
      unknownStartedAtMs: previous.unknownStartedAtMs ?? options.nowMs,
    };
  }

  if (previous.quality === "unknown") {
    return {
      consumerId: options.consumerId,
      quality: options.sampleQuality,
      recoveryQuality: null,
      recoveryStartedAtMs: null,
      unknownStartedAtMs: null,
    };
  }

  const currentRank = qualityRank[previous.quality];
  const sampleRank = qualityRank[options.sampleQuality];
  if (sampleRank >= currentRank) {
    return {
      consumerId: options.consumerId,
      quality: options.sampleQuality,
      recoveryQuality: null,
      recoveryStartedAtMs: null,
      unknownStartedAtMs: null,
    };
  }

  if (
    previous.recoveryQuality !== options.sampleQuality ||
    previous.recoveryStartedAtMs === null
  ) {
    return {
      consumerId: options.consumerId,
      quality: previous.quality,
      recoveryQuality: options.sampleQuality,
      recoveryStartedAtMs: options.nowMs,
      unknownStartedAtMs: null,
    };
  }

  if (options.nowMs - previous.recoveryStartedAtMs < recoveryHoldMs) {
    return previous;
  }

  return {
    consumerId: options.consumerId,
    quality: options.sampleQuality,
    recoveryQuality: null,
    recoveryStartedAtMs: null,
    unknownStartedAtMs: null,
  };
};

export const getEffectiveConsumerReceiveQuality = (
  connectionQuality: ConsumerScoreQuality,
  consumerScoreQuality: ConsumerScoreQuality,
): Exclude<ConsumerScoreQuality, "unknown"> => {
  const effectiveQuality =
    connectionQuality === "unknown"
      ? consumerScoreQuality
      : consumerScoreQuality === "unknown" ||
          qualityRank[connectionQuality] >= qualityRank[consumerScoreQuality]
        ? connectionQuality
        : consumerScoreQuality;
  return effectiveQuality === "unknown" ? "good" : effectiveQuality;
};

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

/**
 * How well the sender of a consumed stream reaches the server: the best
 * score among its encodings, or the aggregate when no per-encoding scores
 * came. Zero means the server gets nothing from that sender.
 */
export const readProducerScore = (score: unknown): number | null => {
  if (!isRecord(score)) return null;
  const perEncoding = Array.isArray(score.producerScores)
    ? score.producerScores
        .map(parseScoreValue)
        .filter((value): value is number => value !== null)
    : [];
  return perEncoding.length > 0
    ? Math.max(...perEncoding)
    : parseScoreValue(score.producerScore);
};

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

import { PROCESS_PERFORMANCE_VERSION } from "./process-performance.mjs";

export const CODEC_PERFORMANCE_VERSION = 2;
export const CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS = 500;
export const MEASUREMENT_WINDOW_VERSION = 1;

const MINIMUM_OBSERVATION_INTERVAL_MS = 400;
const MAXIMUM_OBSERVATION_INTERVAL_MS = 600;
const MAXIMUM_BOUNDARY_SKEW_MS = 250;
const MINIMUM_WINDOW_COVERAGE_RATIO = 0.95;
const MAXIMUM_WINDOW_COVERAGE_RATIO = 1.05;
const MINIMUM_QUALITY_DURATION_COVERAGE_RATIO = 0.8;
const MAXIMUM_QUALITY_DURATION_COVERAGE_RATIO = 1.2;
const REQUIRED_QUALITY_LIMITATION_REASONS = [
  "bandwidth",
  "cpu",
  "none",
  "other",
];

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const stableJson = (value) => JSON.stringify(canonicalize(value));

const nonEmptyString = (value) =>
  typeof value === "string" && value.length > 0 ? value : null;

const validMeasurementWindow = (value) => {
  const startedAtEpochMs = finite(value?.startedAtEpochMs);
  const endedAtEpochMs = finite(value?.endedAtEpochMs);
  const durationMs = finite(value?.durationMs);
  return (
    value?.version === MEASUREMENT_WINDOW_VERSION &&
    nonEmptyString(value?.id) !== null &&
    startedAtEpochMs !== null &&
    endedAtEpochMs !== null &&
    endedAtEpochMs > startedAtEpochMs &&
    durationMs !== null &&
    Number.isInteger(durationMs) &&
    durationMs > 0 &&
    durationMs % CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS === 0 &&
    Math.abs(endedAtEpochMs - startedAtEpochMs - durationMs) <=
      Math.max(5, durationMs * 0.001)
  );
};

const measurementWindowSignature = (value) =>
  validMeasurementWindow(value)
    ? stableJson({
        version: value.version,
        id: value.id,
        startedAtEpochMs: value.startedAtEpochMs,
        endedAtEpochMs: value.endedAtEpochMs,
        durationMs: value.durationMs,
      })
    : null;

const resultAuthorityIsConsistent = (result, version) => {
  if (
    result?.version !== version ||
    !Array.isArray(result?.harnessFailures) ||
    !Array.isArray(result?.productFailures) ||
    !Array.isArray(result?.failures) ||
    typeof result?.valid !== "boolean" ||
    typeof result?.passed !== "boolean"
  ) {
    return false;
  }
  const declaredFailures = [
    ...result.harnessFailures,
    ...result.productFailures,
  ];
  if (
    declaredFailures.some((failure) => nonEmptyString(failure) === null) ||
    new Set(result.harnessFailures).size !== result.harnessFailures.length ||
    new Set(result.productFailures).size !== result.productFailures.length ||
    stableJson(result.failures) !== stableJson(declaredFailures)
  ) {
    return false;
  }
  const expectedValid = result.harnessFailures.length === 0;
  const expectedPassed = expectedValid && result.productFailures.length === 0;
  return result.valid === expectedValid && result.passed === expectedPassed;
};

const nearestRank = (values, percentile) => {
  const usable = values
    .map(finite)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (usable.length === 0) return null;
  const rank = Math.max(1, Math.ceil(percentile * usable.length));
  return usable[Math.min(usable.length - 1, rank - 1)];
};

const mean = (values) => {
  const usable = values.map(finite).filter((value) => value !== null);
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
};

const videoKind = (stat) =>
  String(stat?.kind ?? stat?.mediaType ?? "").toLowerCase() === "video";

const codecIndex = (stats) =>
  new Map(
    (stats ?? [])
      .filter((stat) => stat?.type === "codec")
      .map((stat) => [stat.id, stat]),
  );

export const publisherSenderEncodingSignature = (parameters) =>
  stableJson(
    (parameters?.encodings ?? []).map((encoding) => ({
      rid: encoding?.rid ?? null,
      active: encoding?.active ?? null,
      maxBitrate: finite(encoding?.maxBitrate),
      maxFramerate: finite(encoding?.maxFramerate),
      scaleResolutionDownBy: finite(encoding?.scaleResolutionDownBy),
      scalabilityMode:
        typeof encoding?.scalabilityMode === "string"
          ? encoding.scalabilityMode
          : null,
    })),
  );

const codecIdentity = (value) =>
  stableJson({
    codecId: value?.codecId ?? null,
    payloadType: finite(value?.codecPayloadType),
    mimeType:
      typeof value?.codecMimeType === "string"
        ? value.codecMimeType.toLowerCase()
        : null,
    fmtp:
      typeof value?.codecFmtpLine === "string"
        ? value.codecFmtpLine
        : null,
    scalabilityMode:
      typeof value?.scalabilityMode === "string"
        ? value.scalabilityMode
        : null,
    implementation:
      value?.encoderImplementation ?? value?.decoderImplementation ?? null,
    powerEfficient:
      value?.powerEfficientEncoder ?? value?.powerEfficientDecoder ?? null,
  });

const encodingIdentity = (encoding) =>
  `${encoding?.id ?? "missing"}:${encoding?.ssrc ?? "missing"}:${encoding?.rid ?? ""}:${codecIdentity(encoding)}`;

const normalizeLimitationDurations = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  for (const [reason, duration] of Object.entries(value)) {
    const number = finite(duration);
    if (!reason || number === null || number < 0) return null;
    normalized[reason] = number;
  }
  return normalized;
};

export function extractPublisherCodecObservation(
  payload,
  {
    producerId,
    connectionId,
    senderId,
    trackId,
    codecMimeType,
    expectedEncodingCount,
    senderEncodingSignature,
    observerStartedAtEpochMs,
    measurementWindowId,
    allowTrackReplacement = false,
    allowEncodingParameterChanges = false,
  } = {},
) {
  const reasons = [];
  const snapshot = payload?.snapshot ?? null;
  const capturedAtEpochMs = finite(snapshot?.capturedAt);
  if (capturedAtEpochMs === null) reasons.push("stats capture timestamp is missing");
  if (
    !measurementWindowId ||
    payload?.measurementWindowId !== measurementWindowId
  ) {
    reasons.push("stats observation is bound to another measurement window");
  }
  if (!producerId || payload?.producerId !== producerId) {
    reasons.push("current producer changed");
  }
  const connections = (snapshot?.peerConnections ?? []).filter(
    (connection) => connection?.id === connectionId,
  );
  if (connections.length !== 1) {
    reasons.push(`expected one bound peer connection, observed ${connections.length}`);
  }
  const connection = connections[0] ?? null;
  if (connection?.connectionState !== "connected") {
    reasons.push("bound peer connection is not connected");
  }
  if (!['connected', 'completed'].includes(connection?.iceConnectionState)) {
    reasons.push("bound ICE connection is not connected");
  }
  if (connection?.signalingState !== "stable") {
    reasons.push("bound peer connection signaling is not stable");
  }
  const senders = (connection?.senders ?? []).filter(
    (sender) =>
      sender?.id === senderId &&
      (allowTrackReplacement || sender?.track?.id === trackId),
  );
  if (senders.length !== 1) {
    reasons.push(`expected one bound video sender, observed ${senders.length}`);
  }
  const sender = senders[0] ?? null;
  if (sender?.track?.kind !== "video" || sender?.track?.readyState !== "live") {
    reasons.push("bound video sender track is not live");
  }
  if (
    allowTrackReplacement &&
    (nonEmptyString(payload?.currentTrackId) === null ||
      sender?.track?.id !== payload.currentTrackId)
  ) {
    reasons.push("product-current publisher track is detached from the bound sender");
  }
  if (sender?.statsError) reasons.push("bound sender stats failed");
  const observedSignature = publisherSenderEncodingSignature(sender?.parameters);
  if (
    !allowEncodingParameterChanges &&
    (!senderEncodingSignature || observedSignature !== senderEncodingSignature)
  ) {
    reasons.push("bound sender encoding parameters changed");
  }
  const stats = sender?.stats ?? [];
  const codecs = codecIndex(stats);
  const configuredEncodings = Array.isArray(sender?.parameters?.encodings)
    ? sender.parameters.encodings
    : [];
  const configuredByRid = new Map(
    configuredEncodings
      .filter((encoding) => typeof encoding?.rid === "string")
      .map((encoding) => [encoding.rid, encoding]),
  );
  const outbound = stats.filter(
    (stat) =>
      stat?.type === "outbound-rtp" &&
      videoKind(stat) &&
      stat?.isRemote !== true &&
      stat?.mid !== "probator" &&
      stat?.trackIdentifier !== "probator",
  );
  if (
    !Number.isInteger(expectedEncodingCount) ||
    expectedEncodingCount < 1 ||
    outbound.length !== expectedEncodingCount
  ) {
    reasons.push(
      `bound sender encoding stats ${outbound.length}/${expectedEncodingCount ?? "missing"} expected`,
    );
  }
  const encodings = outbound
    .map((stat, index) => {
      const codec = stat.codecId ? codecs.get(stat.codecId) : null;
      const configuredEncoding =
        (typeof stat.rid === "string" ? configuredByRid.get(stat.rid) : null) ??
        (configuredEncodings.length === 1 ? configuredEncodings[0] : null) ??
        configuredEncodings[index] ??
        null;
      return {
        id: stat.id ?? null,
        ssrc: stat.ssrc ?? null,
        rid: stat.rid ?? null,
        active: typeof stat.active === "boolean" ? stat.active : null,
        framesEncoded: finite(stat.framesEncoded),
        keyFramesEncoded: finite(stat.keyFramesEncoded),
        totalEncodeTime: finite(stat.totalEncodeTime),
        qpSum: finite(stat.qpSum),
        bytesSent: finite(stat.bytesSent),
        qualityLimitationReason:
          typeof stat.qualityLimitationReason === "string"
            ? stat.qualityLimitationReason
            : null,
        qualityLimitationDurations: normalizeLimitationDurations(
          stat.qualityLimitationDurations,
        ),
        encoderImplementation:
          typeof stat.encoderImplementation === "string"
            ? stat.encoderImplementation
            : null,
        powerEfficientEncoder:
          typeof stat.powerEfficientEncoder === "boolean"
            ? stat.powerEfficientEncoder
            : null,
        codecId: typeof stat.codecId === "string" ? stat.codecId : null,
        codecPayloadType: finite(codec?.payloadType),
        codecMimeType:
          typeof codec?.mimeType === "string"
            ? codec.mimeType.toLowerCase()
            : null,
        codecFmtpLine:
          typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : null,
        scalabilityMode:
          typeof stat.scalabilityMode === "string" ? stat.scalabilityMode : null,
        expectedScalabilityMode:
          typeof configuredEncoding?.scalabilityMode === "string"
            ? configuredEncoding.scalabilityMode
            : null,
        frameWidth: finite(stat.frameWidth),
        frameHeight: finite(stat.frameHeight),
      };
    })
    .sort((left, right) =>
      encodingIdentity(left).localeCompare(encodingIdentity(right)),
    );
  const expectedCodec = String(codecMimeType ?? "").toLowerCase();
  for (const encoding of encodings) {
    if (
      !encoding.id ||
      encoding.ssrc == null ||
      encoding.active !== true ||
      encoding.framesEncoded === null ||
      encoding.totalEncodeTime === null ||
      encoding.bytesSent === null
    ) {
      reasons.push("outbound encode counters are incomplete");
    }
    if (!expectedCodec || encoding.codecMimeType !== expectedCodec) {
      reasons.push("bound outbound codec changed");
    }
    if (!encoding.codecId || encoding.codecPayloadType === null) {
      reasons.push("bound outbound codec identity is incomplete");
    }
    if (
      !encoding.scalabilityMode ||
      !encoding.expectedScalabilityMode ||
      encoding.scalabilityMode !== encoding.expectedScalabilityMode
    ) {
      reasons.push("bound outbound scalability mode changed");
    }
    if (!encoding.qualityLimitationReason) {
      reasons.push("quality-limitation reason is missing");
    }
    if (!encoding.qualityLimitationDurations) {
      reasons.push("quality-limitation durations are missing");
    }
  }
  return {
    capturedAtEpochMs,
    sampledAtMs:
      capturedAtEpochMs !== null && finite(observerStartedAtEpochMs) !== null
        ? round(capturedAtEpochMs - observerStartedAtEpochMs, 3)
        : null,
    matched: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
    producerId: payload?.producerId ?? null,
    measurementWindowId: payload?.measurementWindowId ?? null,
    connectionId: connection?.id ?? null,
    senderId: sender?.id ?? null,
    trackId: sender?.track?.id ?? null,
    productCurrentTrackId: payload?.currentTrackId ?? null,
    senderEncodingSignature: observedSignature,
    encodings,
  };
}

const validateObservationTimeline = ({
  observations,
  measurementWindow,
  durationMs,
  harnessFailures,
  label,
}) => {
  const list = Array.isArray(observations) ? observations : [];
  const windowSignature = measurementWindowSignature(measurementWindow);
  if (!windowSignature) {
    harnessFailures.push(`${label} measurement window is missing or malformed`);
  }
  if (
    finite(durationMs) !== null &&
    windowSignature &&
    Math.abs(durationMs - measurementWindow.durationMs) > 5
  ) {
    harnessFailures.push(`${label} duration differs from the measurement window`);
  }
  const windowDurationMs = finite(measurementWindow?.durationMs) ?? 1;
  const expectedIntervalCount = Math.floor(
    windowDurationMs / CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS,
  );
  const minimumIntervalCount = Math.max(4, expectedIntervalCount - 1);
  if (list.length < minimumIntervalCount + 1) {
    harnessFailures.push(
      `${label} 500ms observations ${list.length}/${minimumIntervalCount + 1} required are sparse`,
    );
  }

  let minimumObservationIntervalMs = null;
  let maximumObservationIntervalMs = null;
  let invalidIntervalCount = 0;
  for (let index = 0; index < list.length; index += 1) {
    const observation = list[index];
    const capturedAt = finite(observation?.capturedAtEpochMs);
    const sampledAt = finite(observation?.sampledAtMs);
    if (
      !windowSignature ||
      observation?.measurementWindowId !== measurementWindow.id ||
      capturedAt === null ||
      sampledAt === null ||
      capturedAt < measurementWindow.startedAtEpochMs ||
      capturedAt > measurementWindow.endedAtEpochMs
    ) {
      harnessFailures.push(`${label} observation is stale or outside its exact window`);
    }
    if (index === 0) continue;
    const previous = list[index - 1];
    const previousCapturedAt = finite(previous?.capturedAtEpochMs);
    const previousSampledAt = finite(previous?.sampledAtMs);
    const epochIntervalMs =
      capturedAt !== null && previousCapturedAt !== null
        ? capturedAt - previousCapturedAt
        : null;
    const sampledIntervalMs =
      sampledAt !== null && previousSampledAt !== null
        ? sampledAt - previousSampledAt
        : null;
    if (
      epochIntervalMs === null ||
      sampledIntervalMs === null ||
      epochIntervalMs < MINIMUM_OBSERVATION_INTERVAL_MS ||
      epochIntervalMs > MAXIMUM_OBSERVATION_INTERVAL_MS ||
      sampledIntervalMs < MINIMUM_OBSERVATION_INTERVAL_MS ||
      sampledIntervalMs > MAXIMUM_OBSERVATION_INTERVAL_MS ||
      Math.abs(epochIntervalMs - sampledIntervalMs) > 25
    ) {
      invalidIntervalCount += 1;
      harnessFailures.push(`${label} observation cadence is not exact 500ms`);
    }
    if (epochIntervalMs !== null) {
      minimumObservationIntervalMs = Math.min(
        minimumObservationIntervalMs ?? epochIntervalMs,
        epochIntervalMs,
      );
      maximumObservationIntervalMs = Math.max(
        maximumObservationIntervalMs ?? epochIntervalMs,
        epochIntervalMs,
      );
    }
  }

  const firstCapturedAt = finite(list[0]?.capturedAtEpochMs);
  const lastCapturedAt = finite(list[list.length - 1]?.capturedAtEpochMs);
  const coveredDurationMs =
    firstCapturedAt !== null && lastCapturedAt !== null
      ? lastCapturedAt - firstCapturedAt
      : null;
  const coverageRatio =
    coveredDurationMs !== null && windowDurationMs > 0
      ? coveredDurationMs / windowDurationMs
      : null;
  if (
    !windowSignature ||
    firstCapturedAt === null ||
    lastCapturedAt === null ||
    firstCapturedAt - measurementWindow.startedAtEpochMs >
      MAXIMUM_BOUNDARY_SKEW_MS ||
    measurementWindow.endedAtEpochMs - lastCapturedAt >
      MAXIMUM_BOUNDARY_SKEW_MS ||
    coverageRatio === null ||
    coverageRatio < MINIMUM_WINDOW_COVERAGE_RATIO ||
    coverageRatio > MAXIMUM_WINDOW_COVERAGE_RATIO
  ) {
    harnessFailures.push(`${label} observations do not cover the exact window boundaries`);
  }
  return {
    list,
    expectedIntervalCount,
    minimumIntervalCount,
    coveredDurationMs,
    coverageRatio,
    minimumObservationIntervalMs,
    maximumObservationIntervalMs,
    invalidIntervalCount,
  };
};

const summarizeCounterIntervals = ({
  observations,
  measurementWindow,
  durationMs,
  timeField,
  frameField,
  qpField,
  itemReader,
  identityReader,
  harnessFailures,
  label,
}) => {
  const timeline = validateObservationTimeline({
    observations,
    measurementWindow,
    durationMs,
    harnessFailures,
    label,
  });
  const list = timeline.list;
  const firstItems = itemReader(list[0] ?? {});
  const firstKeys = firstItems.map(identityReader).sort();
  if (new Set(firstKeys).size !== firstKeys.length || firstKeys.length === 0) {
    harnessFailures.push(`${label} exact codec identities are missing or duplicated`);
  }
  const states = new Map(
    firstItems.map((item) => [
      identityReader(item),
      {
        identity: identityReader(item),
        rid: item?.rid ?? null,
        intervalCosts: [],
        intervalQps: [],
        intervals: [],
        totalTimeSeconds: 0,
        totalFrames: 0,
        totalQp: 0,
        qpMode: null,
        coveredDurationMs: 0,
        counterResetCount: 0,
        emptyFrameIntervalCount: 0,
      },
    ]),
  );
  const aggregateServiceIntervals = [];

  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1];
    const current = list[index];
    const previousAt = finite(previous?.sampledAtMs);
    const currentAt = finite(current?.sampledAtMs);
    const intervalMs =
      previousAt !== null && currentAt !== null ? currentAt - previousAt : null;
    const previousItems = itemReader(previous);
    const currentItems = itemReader(current);
    const previousIndex = new Map(
      previousItems.map((item) => [identityReader(item), item]),
    );
    const currentIndex = new Map(
      currentItems.map((item) => [identityReader(item), item]),
    );
    const previousKeys = Array.from(previousIndex.keys()).sort();
    const currentKeys = Array.from(currentIndex.keys()).sort();
    if (
      previous?.matched !== true ||
      current?.matched !== true ||
      new Set(previousKeys).size !== previousKeys.length ||
      new Set(currentKeys).size !== currentKeys.length ||
      stableJson(previousKeys) !== stableJson(firstKeys) ||
      stableJson(currentKeys) !== stableJson(firstKeys) ||
      intervalMs === null ||
      intervalMs < MINIMUM_OBSERVATION_INTERVAL_MS ||
      intervalMs > MAXIMUM_OBSERVATION_INTERVAL_MS
    ) {
      harnessFailures.push(`${label} exact codec path changed between observations`);
      continue;
    }

    let aggregateTimeSeconds = 0;
    let completeInterval = true;
    for (const key of currentKeys) {
      const state = states.get(key);
      const before = previousIndex.get(key);
      const after = currentIndex.get(key);
      const beforeTime = finite(before?.[timeField]);
      const afterTime = finite(after?.[timeField]);
      const beforeFrames = finite(before?.[frameField]);
      const afterFrames = finite(after?.[frameField]);
      if (
        !state ||
        beforeTime === null ||
        afterTime === null ||
        beforeFrames === null ||
        afterFrames === null
      ) {
        harnessFailures.push(`${label} codec counters are missing for ${key}`);
        if (state) state.counterResetCount += 1;
        completeInterval = false;
        continue;
      }
      const timeDelta = afterTime - beforeTime;
      const frameDelta = afterFrames - beforeFrames;
      if (timeDelta < 0 || frameDelta < 0) {
        state.counterResetCount += 1;
        harnessFailures.push(`${label} codec counters reset for ${key}`);
        completeInterval = false;
        continue;
      }
      if (frameDelta <= 0) {
        state.emptyFrameIntervalCount += 1;
        harnessFailures.push(`${label} encoding ${key} made no frame progress`);
        completeInterval = false;
        continue;
      }
      const beforeQp = finite(before?.[qpField]);
      const afterQp = finite(after?.[qpField]);
      const qpState =
        beforeQp === null && afterQp === null
          ? "unavailable"
          : beforeQp !== null && afterQp !== null && afterQp >= beforeQp
            ? "authoritative"
            : "partial";
      if (state.qpMode === null) state.qpMode = qpState;
      if (qpState === "partial" || state.qpMode !== qpState) {
        harnessFailures.push(`${label} QP authority changed for ${key}`);
        completeInterval = false;
        continue;
      }
      const qpDelta = qpState === "authoritative" ? afterQp - beforeQp : null;
      const timePerFrameMs = (timeDelta * 1_000) / frameDelta;
      const averageQp = qpDelta === null ? null : qpDelta / frameDelta;
      state.intervalCosts.push(timePerFrameMs);
      if (averageQp !== null) state.intervalQps.push(averageQp);
      state.totalTimeSeconds += timeDelta;
      state.totalFrames += frameDelta;
      if (qpDelta !== null) state.totalQp += qpDelta;
      state.coveredDurationMs += intervalMs;
      state.intervals.push({
        startedAtMs: round(previousAt, 3),
        endedAtMs: round(currentAt, 3),
        durationMs: round(intervalMs, 3),
        frames: frameDelta,
        totalTimeSeconds: round(timeDelta, 6),
        timeMsPerFrame: round(timePerFrameMs, 3),
        averageQp: round(averageQp, 3),
      });
      aggregateTimeSeconds += timeDelta;
    }
    if (completeInterval && currentKeys.length > 0) {
      aggregateServiceIntervals.push({
        startedAtMs: round(previousAt, 3),
        endedAtMs: round(currentAt, 3),
        durationMs: round(intervalMs, 3),
        totalTimeSeconds: round(aggregateTimeSeconds, 6),
        serviceCoreEquivalents: round(
          aggregateTimeSeconds / (intervalMs / 1_000),
          6,
        ),
      });
    }
  }

  const encodingSummaries = Array.from(states.values()).map((state) => {
    const coverageRatio =
      finite(measurementWindow?.durationMs) !== null &&
      measurementWindow.durationMs > 0
        ? state.coveredDurationMs / measurementWindow.durationMs
        : null;
    if (
      state.intervalCosts.length < timeline.minimumIntervalCount ||
      coverageRatio === null ||
      coverageRatio < MINIMUM_WINDOW_COVERAGE_RATIO ||
      coverageRatio > MAXIMUM_WINDOW_COVERAGE_RATIO ||
      state.counterResetCount > 0 ||
      state.emptyFrameIntervalCount > 0
    ) {
      harnessFailures.push(
        `${label} encoding ${state.identity} evidence is sparse, reset, stalled, or discontinuous`,
      );
    }
    return {
      identity: state.identity,
      rid: state.rid,
      intervalCount: state.intervalCosts.length,
      coveredDurationMs: round(state.coveredDurationMs, 3),
      coverageRatio: round(coverageRatio, 6),
      emptyFrameIntervalCount: state.emptyFrameIntervalCount,
      counterResetCount: state.counterResetCount,
      totalFrames: state.totalFrames,
      totalTimeSeconds: round(state.totalTimeSeconds, 6),
      fullWindowMsPerFrame:
        state.totalFrames > 0
          ? round((state.totalTimeSeconds * 1_000) / state.totalFrames, 3)
          : null,
      intervalMeanMsPerFrame: round(mean(state.intervalCosts), 3),
      intervalP95MsPerFrame: round(nearestRank(state.intervalCosts, 0.95), 3),
      intervalMaximumMsPerFrame: round(
        state.intervalCosts.length > 0 ? Math.max(...state.intervalCosts) : null,
        3,
      ),
      qp: {
        authority: state.qpMode ?? "missing",
        fullWindowAverage:
          state.qpMode === "authoritative" && state.totalFrames > 0
            ? round(state.totalQp / state.totalFrames, 3)
            : null,
        intervalMean: round(mean(state.intervalQps), 3),
        intervalP95: round(nearestRank(state.intervalQps, 0.95), 3),
        intervalMaximum: round(
          state.intervalQps.length > 0
            ? Math.max(...state.intervalQps)
            : null,
          3,
        ),
      },
      intervals: state.intervals,
    };
  });
  const worstMetric = (field) => {
    const values = encodingSummaries
      .map((entry) => finite(entry[field]))
      .filter((value) => value !== null);
    return values.length > 0 ? Math.max(...values) : null;
  };
  const totalServiceSeconds = aggregateServiceIntervals.reduce(
    (sum, interval) => sum + interval.totalTimeSeconds,
    0,
  );
  const serviceCoreValues = aggregateServiceIntervals.map(
    (interval) => interval.serviceCoreEquivalents,
  );
  const worstQp = (field) => {
    const values = encodingSummaries
      .map((entry) => finite(entry.qp?.[field]))
      .filter((value) => value !== null);
    return values.length > 0 ? Math.max(...values) : null;
  };
  return {
    observationIntervalMs: CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS,
    observationCount: list.length,
    intervalCount:
      encodingSummaries.length > 0
        ? Math.min(...encodingSummaries.map((entry) => entry.intervalCount))
        : 0,
    expectedIntervalCount: timeline.expectedIntervalCount,
    minimumIntervalCount: timeline.minimumIntervalCount,
    emptyFrameIntervalCount: encodingSummaries.reduce(
      (sum, entry) => sum + entry.emptyFrameIntervalCount,
      0,
    ),
    counterResetCount: encodingSummaries.reduce(
      (sum, entry) => sum + entry.counterResetCount,
      0,
    ),
    coveredDurationMs: round(timeline.coveredDurationMs, 3),
    coverageRatio: round(timeline.coverageRatio, 6),
    minimumObservationIntervalMs: round(
      timeline.minimumObservationIntervalMs,
      3,
    ),
    maximumObservationIntervalMs: round(
      timeline.maximumObservationIntervalMs,
      3,
    ),
    invalidIntervalCount: timeline.invalidIntervalCount,
    totalFrames: encodingSummaries.reduce(
      (sum, entry) => sum + entry.totalFrames,
      0,
    ),
    totalTimeSeconds: round(totalServiceSeconds, 6),
    fullWindowMsPerFrame: worstMetric("fullWindowMsPerFrame"),
    intervalMeanMsPerFrame: worstMetric("intervalMeanMsPerFrame"),
    intervalP95MsPerFrame: worstMetric("intervalP95MsPerFrame"),
    intervalMaximumMsPerFrame: worstMetric("intervalMaximumMsPerFrame"),
    qp: {
      authority:
        encodingSummaries.length > 0 &&
        encodingSummaries.every(
          (entry) => entry.qp.authority === encodingSummaries[0].qp.authority,
        )
          ? encodingSummaries[0].qp.authority
          : "mixed",
      fullWindowAverage: worstQp("fullWindowAverage"),
      intervalMean: worstQp("intervalMean"),
      intervalP95: worstQp("intervalP95"),
      intervalMaximum: worstQp("intervalMaximum"),
    },
    encodings: encodingSummaries,
    aggregateService: {
      intervalCount: aggregateServiceIntervals.length,
      totalTimeSeconds: round(totalServiceSeconds, 6),
      fullWindowCoreEquivalents:
        finite(measurementWindow?.durationMs) !== null &&
        measurementWindow.durationMs > 0
          ? round(totalServiceSeconds / (measurementWindow.durationMs / 1_000), 6)
          : null,
      intervalMeanCoreEquivalents: round(mean(serviceCoreValues), 6),
      intervalP95CoreEquivalents: round(
        nearestRank(serviceCoreValues, 0.95),
        6,
      ),
      intervalMaximumCoreEquivalents: round(
        serviceCoreValues.length > 0 ? Math.max(...serviceCoreValues) : null,
        6,
      ),
      intervals: aggregateServiceIntervals,
    },
    intervals:
      encodingSummaries.length === 1 ? encodingSummaries[0].intervals : [],
  };
};

const summarizeQualityLimitations = (observations, harnessFailures) => {
  const list = Array.isArray(observations) ? observations : [];
  const reasonObservationCounts = {};
  const firstEncodings = list[0]?.encodings ?? [];
  const states = new Map(
    firstEncodings.map((encoding) => [
      encodingIdentity(encoding),
      {
        identity: encodingIdentity(encoding),
        rid: encoding?.rid ?? null,
        durations: {},
        coveredWallDurationSeconds: 0,
        intervalCount: 0,
        counterResetCount: 0,
        coverageFailureCount: 0,
        reasonKeys: null,
      },
    ]),
  );
  for (const observation of list) {
    for (const encoding of observation?.encodings ?? []) {
      if (encoding.qualityLimitationReason) {
        reasonObservationCounts[encoding.qualityLimitationReason] =
          (reasonObservationCounts[encoding.qualityLimitationReason] ?? 0) + 1;
      }
    }
  }
  for (let index = 1; index < list.length; index += 1) {
    const beforeObservation = list[index - 1];
    const afterObservation = list[index];
    const intervalMs =
      finite(afterObservation?.capturedAtEpochMs) !== null &&
      finite(beforeObservation?.capturedAtEpochMs) !== null
        ? afterObservation.capturedAtEpochMs - beforeObservation.capturedAtEpochMs
        : null;
    const previous = new Map(
      (beforeObservation?.encodings ?? []).map((encoding) => [
        encodingIdentity(encoding),
        encoding,
      ]),
    );
    const current = new Map(
      (afterObservation?.encodings ?? []).map((encoding) => [
        encodingIdentity(encoding),
        encoding,
      ]),
    );
    if (
      intervalMs === null ||
      intervalMs < MINIMUM_OBSERVATION_INTERVAL_MS ||
      intervalMs > MAXIMUM_OBSERVATION_INTERVAL_MS ||
      stableJson(Array.from(previous.keys()).sort()) !==
        stableJson(Array.from(current.keys()).sort())
    ) {
      harnessFailures.push(
        "publisher quality-limitation path or cadence changed",
      );
      continue;
    }
    for (const [key, after] of current) {
      const state = states.get(key);
      const before = previous.get(key);
      const beforeDurations = before?.qualityLimitationDurations;
      const afterDurations = after?.qualityLimitationDurations;
      if (!state || !beforeDurations || !afterDurations) {
        harnessFailures.push(
          "publisher quality-limitation durations are missing",
        );
        continue;
      }
      const beforeKeys = Object.keys(beforeDurations).sort();
      const afterKeys = Object.keys(afterDurations).sort();
      if (
        stableJson(beforeKeys) !== stableJson(afterKeys) ||
        REQUIRED_QUALITY_LIMITATION_REASONS.some(
          (reason) => !afterKeys.includes(reason),
        ) ||
        (state.reasonKeys && stableJson(state.reasonKeys) !== stableJson(afterKeys))
      ) {
        harnessFailures.push(
          `publisher quality-limitation reason-key authority changed for ${key}`,
        );
        continue;
      }
      state.reasonKeys = afterKeys;
      let totalIntervalDurationSeconds = 0;
      let reset = false;
      for (const reason of afterKeys) {
        const beforeValue = finite(beforeDurations[reason]);
        const afterValue = finite(afterDurations[reason]);
        if (
          beforeValue === null ||
          afterValue === null ||
          afterValue < beforeValue
        ) {
          reset = true;
          continue;
        }
        const durationDelta = afterValue - beforeValue;
        state.durations[reason] =
          (state.durations[reason] ?? 0) + durationDelta;
        totalIntervalDurationSeconds += durationDelta;
      }
      if (reset) {
        state.counterResetCount += 1;
        harnessFailures.push(
          `publisher quality-limitation duration counters reset for ${key}`,
        );
        continue;
      }
      const expectedDurationSeconds = intervalMs / 1_000;
      const intervalCoverageRatio =
        totalIntervalDurationSeconds / expectedDurationSeconds;
      if (
        intervalCoverageRatio < MINIMUM_QUALITY_DURATION_COVERAGE_RATIO ||
        intervalCoverageRatio > MAXIMUM_QUALITY_DURATION_COVERAGE_RATIO
      ) {
        state.coverageFailureCount += 1;
        harnessFailures.push(
          `publisher quality-limitation duration coverage ${round(intervalCoverageRatio, 3)} is invalid for ${key}`,
        );
        continue;
      }
      state.coveredWallDurationSeconds += expectedDurationSeconds;
      state.intervalCount += 1;
    }
  }
  const perEncoding = Array.from(states.values()).map((state) => {
    const totalDurationSeconds = Object.values(state.durations).reduce(
      (sum, value) => sum + value,
      0,
    );
    const coverageRatio =
      state.coveredWallDurationSeconds > 0
        ? totalDurationSeconds / state.coveredWallDurationSeconds
        : null;
    if (
      state.intervalCount !== Math.max(0, list.length - 1) ||
      coverageRatio === null ||
      coverageRatio < MINIMUM_QUALITY_DURATION_COVERAGE_RATIO ||
      coverageRatio > MAXIMUM_QUALITY_DURATION_COVERAGE_RATIO ||
      state.counterResetCount > 0 ||
      state.coverageFailureCount > 0
    ) {
      harnessFailures.push(
        `publisher quality-limitation duration window is incomplete for ${state.identity}`,
      );
    }
    return {
      identity: state.identity,
      rid: state.rid,
      reasonKeys: state.reasonKeys ?? [],
      durationsSeconds: Object.fromEntries(
        Object.entries(state.durations).map(([reason, value]) => [
          reason,
          round(value, 6),
        ]),
      ),
      totalDurationSeconds: round(totalDurationSeconds, 6),
      coveredWallDurationSeconds: round(
        state.coveredWallDurationSeconds,
        6,
      ),
      coverageRatio: round(coverageRatio, 6),
      cpuDurationSeconds: round(state.durations.cpu ?? 0, 6),
      cpuRatio:
        totalDurationSeconds > 0
          ? round((state.durations.cpu ?? 0) / totalDurationSeconds, 6)
          : null,
      intervalCount: state.intervalCount,
      counterResetCount: state.counterResetCount,
      coverageFailureCount: state.coverageFailureCount,
    };
  });
  const durations = {};
  for (const encoding of perEncoding) {
    for (const [reason, duration] of Object.entries(
      encoding.durationsSeconds,
    )) {
      durations[reason] = (durations[reason] ?? 0) + duration;
    }
  }
  const totalDurationSeconds = Object.values(durations).reduce(
    (sum, value) => sum + value,
    0,
  );
  const cpuDurationSeconds = durations.cpu ?? 0;
  if (perEncoding.length === 0 || totalDurationSeconds <= 0) {
    harnessFailures.push("publisher quality-limitation duration window is empty");
  }
  return {
    durationsSeconds: Object.fromEntries(
      Object.entries(durations).map(([reason, value]) => [reason, round(value, 6)]),
    ),
    reasonObservationCounts,
    totalDurationSeconds: round(totalDurationSeconds, 6),
    cpuDurationSeconds: round(cpuDurationSeconds, 6),
    cpuRatio:
      totalDurationSeconds > 0
        ? round(cpuDurationSeconds / totalDurationSeconds, 6)
        : null,
    counterResetCount: perEncoding.reduce(
      (sum, encoding) => sum + encoding.counterResetCount,
      0,
    ),
    perEncoding,
  };
};

const metadataSets = (items, implementationField, powerField) => {
  const implementations = items
    .map((item) => item?.[implementationField])
    .filter((value) => typeof value === "string" && value.length > 0);
  const powerEfficient = items
    .map((item) => item?.[powerField])
    .filter((value) => typeof value === "boolean");
  const uniqueImplementations = Array.from(new Set(implementations)).sort();
  const uniquePowerEfficient = Array.from(new Set(powerEfficient)).sort();
  const authority = (reportedCount, uniqueCount) =>
    reportedCount === 0
      ? "not-exposed"
      : reportedCount === items.length && uniqueCount === 1
        ? "reported"
        : "inconsistent";
  return {
    implementations: uniqueImplementations,
    powerEfficient: uniquePowerEfficient,
    implementationAuthority: authority(
      implementations.length,
      uniqueImplementations.length,
    ),
    powerEfficientAuthority: authority(
      powerEfficient.length,
      uniquePowerEfficient.length,
    ),
  };
};

const applyTimingGates = ({ summary, limits, label, productFailures, harnessFailures }) => {
  for (const field of [
    "intervalMeanMsPerFrame",
    "intervalP95MsPerFrame",
    "intervalMaximumMsPerFrame",
  ]) {
    if (finite(summary?.[field]) === null) {
      harnessFailures.push(`${label} ${field} is missing`);
    }
  }
  const gates = [
    ["intervalMeanMsPerFrame", "maximumMeanMsPerFrame", "mean"],
    ["intervalP95MsPerFrame", "maximumP95MsPerFrame", "p95"],
    ["intervalMaximumMsPerFrame", "maximumMsPerFrame", "maximum"],
  ];
  for (const [metricField, limitField, display] of gates) {
    const observed = finite(summary?.[metricField]);
    const limit = finite(limits?.[limitField]);
    if (limit === null || limit <= 0) {
      harnessFailures.push(`${label} ${display} performance gate is missing`);
    } else if (observed !== null && observed > limit) {
      productFailures.push(
        `${label} ${display} ${observed}ms/frame exceeds ${limit}ms/frame`,
      );
    }
  }
};

export function assessPublisherCodecPerformance({
  observations,
  measurementWindow,
  observerMetadata,
  durationMs,
  limits,
  observationIntervalMs = CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS,
  skippedTickCount = 0,
} = {}) {
  const harnessFailures = [];
  const productFailures = [];
  const list = Array.isArray(observations) ? observations : [];
  const observer = observerMetadata ?? {
    measurementWindowId: measurementWindow?.id ?? null,
    observerStartedAtEpochMs: null,
    observerStoppedAtEpochMs: null,
    observationIntervalMs,
    skippedTickCount,
  };
  if (
    !validMeasurementWindow(measurementWindow) ||
    observer?.measurementWindowId !== measurementWindow?.id ||
    observer?.observationIntervalMs !==
      CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS ||
    !Number.isInteger(observer?.skippedTickCount) ||
    observer.skippedTickCount < 0 ||
    finite(observer?.observerStartedAtEpochMs) === null ||
    finite(observer?.observerStoppedAtEpochMs) === null ||
    Math.abs(
      observer.observerStartedAtEpochMs -
        measurementWindow.startedAtEpochMs,
    ) >
      MAXIMUM_BOUNDARY_SKEW_MS ||
    Math.abs(
      observer.observerStoppedAtEpochMs - measurementWindow.endedAtEpochMs,
    ) >
      MAXIMUM_BOUNDARY_SKEW_MS
  ) {
    harnessFailures.push("publisher codec observer cadence authority is missing");
  } else if (observer.skippedTickCount > 0) {
    harnessFailures.push(
      `publisher codec observer skipped ${observer.skippedTickCount} exact 500ms tick(s)`,
    );
  }
  const firstEncodingKeys = (list[0]?.encodings ?? [])
    .map(encodingIdentity)
    .sort();
  for (const observation of list) {
    if (observation?.matched !== true) {
      harnessFailures.push(
        `publisher codec observation changed path: ${(observation?.reasons ?? []).join(", ") || "unknown"}`,
      );
    }
    if (
      stableJson((observation?.encodings ?? []).map(encodingIdentity).sort()) !==
      stableJson(firstEncodingKeys)
    ) {
      harnessFailures.push("publisher encoding identity set changed");
    }
  }
  const timing = summarizeCounterIntervals({
    observations: list,
    measurementWindow,
    durationMs,
    timeField: "totalEncodeTime",
    frameField: "framesEncoded",
    qpField: "qpSum",
    itemReader: (observation) => observation?.encodings ?? [],
    identityReader: encodingIdentity,
    harnessFailures,
    label: "publisher encode",
  });
  const allEncodings = list.flatMap((observation) => observation.encodings ?? []);
  const metadata = metadataSets(
    allEncodings,
    "encoderImplementation",
    "powerEfficientEncoder",
  );
  if (metadata.implementationAuthority === "inconsistent") {
    harnessFailures.push("publisher encoder implementation changed or is partial");
  }
  if (metadata.powerEfficientAuthority === "inconsistent") {
    harnessFailures.push(
      "publisher power-efficient encoder flag changed or is partial",
    );
  }
  const qualityLimitations = summarizeQualityLimitations(list, harnessFailures);
  const maximumCpuRatio = finite(limits?.maximumCpuQualityLimitationRatio);
  if (maximumCpuRatio === null || maximumCpuRatio < 0) {
    harnessFailures.push("publisher CPU quality-limitation ratio gate is missing");
  } else if (
    qualityLimitations.cpuRatio !== null &&
    qualityLimitations.cpuRatio > maximumCpuRatio
  ) {
    productFailures.push(
      `publisher CPU quality-limitation ratio ${qualityLimitations.cpuRatio} exceeds ${maximumCpuRatio}`,
    );
  }
  for (const encoding of timing.encodings ?? []) {
    applyTimingGates({
      summary: encoding,
      limits,
      label: `publisher encode ${encoding.rid ?? encoding.identity}`,
      productFailures,
      harnessFailures,
    });
  }
  if ((timing.encodings ?? []).length === 0) {
    applyTimingGates({
      summary: timing,
      limits,
      label: "publisher encode",
      productFailures,
      harnessFailures,
    });
  }
  for (const encoding of qualityLimitations.perEncoding ?? []) {
    if (encoding.cpuRatio === null) {
      harnessFailures.push(
        `publisher CPU quality-limitation ratio is missing for ${encoding.identity}`,
      );
    } else if (
      maximumCpuRatio !== null &&
      encoding.cpuRatio > maximumCpuRatio
    ) {
      productFailures.push(
        `publisher encoding ${encoding.rid ?? encoding.identity} CPU quality-limitation ratio ${encoding.cpuRatio} exceeds ${maximumCpuRatio}`,
      );
    }
  }
  const uniqueHarnessFailures = Array.from(new Set(harnessFailures));
  const uniqueProductFailures = Array.from(new Set(productFailures));
  return {
    version: CODEC_PERFORMANCE_VERSION,
    measurementWindow: measurementWindow ?? null,
    observerMetadata: observer,
    valid: uniqueHarnessFailures.length === 0,
    passed:
      uniqueHarnessFailures.length === 0 && uniqueProductFailures.length === 0,
    harnessFailures: uniqueHarnessFailures,
    productFailures: uniqueProductFailures,
    failures: [...uniqueHarnessFailures, ...uniqueProductFailures],
    timing,
    metadata,
    qualityLimitations: {
      ...qualityLimitations,
      maximumCpuRatio,
    },
    observationCount: list.length,
    observations: list,
  };
}

const findBoundInboundStat = (snapshot, binding) => {
  const connection = (snapshot?.peerConnections ?? []).find(
    (candidate) => candidate?.id === binding?.connectionId,
  );
  const stat = (connection?.stats ?? []).find(
    (candidate) =>
      candidate?.id === binding?.statId &&
      candidate?.type === "inbound-rtp" &&
      videoKind(candidate) &&
      String(candidate?.ssrc ?? "") === String(binding?.ssrc ?? "") &&
      candidate?.trackIdentifier === binding?.consumerId,
  );
  const codecs = codecIndex(connection?.stats ?? []);
  const codec = stat?.codecId ? codecs.get(stat.codecId) : null;
  return {
    connection,
    stat,
    codecId: typeof stat?.codecId === "string" ? stat.codecId : null,
    codecPayloadType: finite(codec?.payloadType),
    codecMimeType:
      typeof codec?.mimeType === "string" ? codec.mimeType.toLowerCase() : null,
    codecFmtpLine:
      typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : null,
    scalabilityMode:
      typeof stat?.scalabilityMode === "string" ? stat.scalabilityMode : null,
    decoderImplementation:
      typeof stat?.decoderImplementation === "string"
        ? stat.decoderImplementation
        : null,
    powerEfficientDecoder:
      typeof stat?.powerEfficientDecoder === "boolean"
        ? stat.powerEfficientDecoder
        : null,
  };
};

const receiverObservationIdentity = (observation) =>
  `${observation?.connectionId ?? "missing"}:${observation?.statId ?? "missing"}:${observation?.ssrc ?? "missing"}:${observation?.consumerId ?? "missing"}:${codecIdentity(observation)}`;

export function assessReceiverCodecPerformance({
  label,
  observations,
  binding,
  measurementWindow,
  startSnapshot,
  endSnapshot,
  durationMs,
  limits,
} = {}) {
  const harnessFailures = [];
  const productFailures = [];
  const list = Array.isArray(observations) ? observations : [];
  const expectedBinding = binding?.expected ?? binding;
  const observer = binding?.observerMetadata;
  const expectedObservationCount = validMeasurementWindow(measurementWindow)
    ? measurementWindow.durationMs /
        CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS +
      1
    : null;
  const observerStartedAtEpochMs = finite(observer?.observerStartedAtEpochMs);
  const observerStoppedAtEpochMs = finite(observer?.observerStoppedAtEpochMs);
  if (
    binding?.valid !== true ||
    binding?.observationIntervalMs !==
      CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS ||
    binding?.measurementWindowId !== measurementWindow?.id ||
    !validMeasurementWindow(measurementWindow) ||
    observer?.valid !== true ||
    observer?.observationIntervalMs !==
      CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS ||
    observer?.scheduledObservationCount !== expectedObservationCount ||
    observer?.completedObservationCount !== expectedObservationCount ||
    binding?.observationCount !== expectedObservationCount ||
    list.length !== expectedObservationCount ||
    observer?.skippedTickCount !== 0 ||
    observer?.lateTickCount !== 0 ||
    observer?.overlapTickCount !== 0 ||
    !Array.isArray(observer?.captureErrors) ||
    observer.captureErrors.length !== 0 ||
    observerStartedAtEpochMs === null ||
    Math.abs(
      observerStartedAtEpochMs - measurementWindow?.startedAtEpochMs,
    ) > MAXIMUM_BOUNDARY_SKEW_MS ||
    observerStoppedAtEpochMs === null ||
    Math.abs(
      observerStoppedAtEpochMs - measurementWindow?.endedAtEpochMs,
    ) > MAXIMUM_BOUNDARY_SKEW_MS
  ) {
    harnessFailures.push(
      `${label} decoder observations are not bound to the exact 500ms window`,
    );
  }
  const expectedIdentity = receiverObservationIdentity(expectedBinding);
  for (const observation of list) {
    if (
      observation?.matched !== true ||
      observation?.measurementWindowId !== measurementWindow?.id ||
      receiverObservationIdentity(observation) !== expectedIdentity ||
      observation?.producerId !== expectedBinding?.producerId ||
      String(observation?.codecMimeType ?? "").toLowerCase() !==
        String(expectedBinding?.codecMimeType ?? "").toLowerCase()
    ) {
      harnessFailures.push(`${label} exact decoder path changed`);
    }
  }
  const timing = summarizeCounterIntervals({
    observations: list,
    measurementWindow,
    durationMs,
    timeField: "totalDecodeTime",
    frameField: "framesDecoded",
    qpField: "qpSum",
    itemReader: (observation) => [observation],
    identityReader: receiverObservationIdentity,
    harnessFailures,
    label: `${label} decode`,
  });
  const startMetadata = findBoundInboundStat(startSnapshot, expectedBinding);
  const endMetadata = findBoundInboundStat(endSnapshot, expectedBinding);
  if (!startMetadata.stat || !endMetadata.stat) {
    harnessFailures.push(`${label} exact inbound endpoint stats are missing`);
  }
  const decoderImplementationAuthority =
    startMetadata.decoderImplementation === null &&
    endMetadata.decoderImplementation === null
      ? "not-exposed"
      : startMetadata.decoderImplementation !== null &&
          startMetadata.decoderImplementation ===
            endMetadata.decoderImplementation
        ? "reported"
        : "inconsistent";
  const powerEfficientDecoderAuthority =
    startMetadata.powerEfficientDecoder === null &&
    endMetadata.powerEfficientDecoder === null
      ? "not-exposed"
      : typeof startMetadata.powerEfficientDecoder === "boolean" &&
          startMetadata.powerEfficientDecoder ===
            endMetadata.powerEfficientDecoder
        ? "reported"
        : "inconsistent";
  if (decoderImplementationAuthority === "inconsistent") {
    harnessFailures.push(`${label} decoder implementation changed or is partial`);
  }
  if (powerEfficientDecoderAuthority === "inconsistent") {
    harnessFailures.push(
      `${label} power-efficient decoder flag changed or is partial`,
    );
  }
  const expectedCodec = String(expectedBinding?.codecMimeType ?? "").toLowerCase();
  if (
    !expectedCodec ||
    codecIdentity(startMetadata) !== codecIdentity(expectedBinding) ||
    codecIdentity(endMetadata) !== codecIdentity(expectedBinding)
  ) {
    harnessFailures.push(`${label} decoder codec metadata is missing or changed`);
  }
  applyTimingGates({
    summary: timing,
    limits,
    label: `${label} decode`,
    productFailures,
    harnessFailures,
  });
  const uniqueHarnessFailures = Array.from(new Set(harnessFailures));
  const uniqueProductFailures = Array.from(new Set(productFailures));
  return {
    version: CODEC_PERFORMANCE_VERSION,
    label,
    measurementWindow: measurementWindow ?? null,
    valid: uniqueHarnessFailures.length === 0,
    passed:
      uniqueHarnessFailures.length === 0 && uniqueProductFailures.length === 0,
    harnessFailures: uniqueHarnessFailures,
    productFailures: uniqueProductFailures,
    failures: [...uniqueHarnessFailures, ...uniqueProductFailures],
    timing,
    metadata: {
      codecId: startMetadata.codecId,
      codecPayloadType: startMetadata.codecPayloadType,
      codecFmtpLine: startMetadata.codecFmtpLine,
      scalabilityMode: startMetadata.scalabilityMode,
      decoderImplementation: startMetadata.decoderImplementation,
      powerEfficientDecoder: startMetadata.powerEfficientDecoder,
      decoderImplementationAuthority,
      powerEfficientDecoderAuthority,
      codecMimeType: startMetadata.codecMimeType,
    },
  };
}

const processWindowId = (process) =>
  process?.measurementWindow?.id ?? process?.measurementWindowId ?? null;

const processRoleCounts = (processes) =>
  processes.reduce((counts, process) => {
    const role = process?.role ?? "missing";
    counts[role] = (counts[role] ?? 0) + 1;
    return counts;
  }, {});

export function validateMeetingPerformanceEvidence(performance) {
  const failures = [];
  if (!resultAuthorityIsConsistent(performance, CODEC_PERFORMANCE_VERSION)) {
    failures.push("meeting performance result authority is inconsistent");
  }
  if (!validMeasurementWindow(performance?.measurementWindow)) {
    failures.push("meeting performance measurement window is missing");
  }
  const expectedReceiverCount = performance?.expectedReceiverCount;
  const receivers = Array.isArray(performance?.receivers)
    ? performance.receivers
    : [];
  const processes = Array.isArray(performance?.browserProcesses)
    ? performance.browserProcesses
    : [];
  if (
    !Number.isInteger(expectedReceiverCount) ||
    expectedReceiverCount < 1 ||
    receivers.length !== expectedReceiverCount ||
    processes.length !== expectedReceiverCount + 1
  ) {
    failures.push("meeting performance receiver/process coverage is incomplete");
  }
  if (
    !resultAuthorityIsConsistent(
      performance?.publisher,
      CODEC_PERFORMANCE_VERSION,
    )
  ) {
    failures.push("publisher codec result authority is inconsistent");
  }
  const receiverLabels = receivers.map((receiver) => receiver?.label);
  if (
    receiverLabels.some((label) => nonEmptyString(label) === null) ||
    new Set(receiverLabels).size !== receiverLabels.length ||
    receivers.some(
      (receiver) =>
        !resultAuthorityIsConsistent(receiver, CODEC_PERFORMANCE_VERSION),
    )
  ) {
    failures.push("receiver codec result labels or authority are inconsistent");
  }
  if (
    processes.some(
      (process) =>
        !resultAuthorityIsConsistent(process, PROCESS_PERFORMANCE_VERSION),
    )
  ) {
    failures.push("browser process result authority is inconsistent");
  }
  const processLabels = processes.map((process) => process?.label);
  const processPids = processes.map((process) => process?.expectedBrowserPid);
  if (
    processLabels.some((label) => nonEmptyString(label) === null) ||
    new Set(processLabels).size !== processLabels.length ||
    processPids.some(
      (pid) => !Number.isInteger(pid) || pid <= 0,
    ) ||
    new Set(processPids).size !== processPids.length
  ) {
    failures.push("browser process labels or exact PIDs are missing or duplicated");
  }
  const roleCounts = processRoleCounts(processes);
  if (
    roleCounts.publisher !== 1 ||
    roleCounts["primary-visual-receiver"] !== 1 ||
    (roleCounts["passive-telemetry-receiver"] ?? 0) !==
      Math.max(0, expectedReceiverCount - 1) ||
    Object.values(roleCounts).reduce((sum, count) => sum + count, 0) !==
      processes.length
  ) {
    failures.push("browser process roles do not match the receiver topology");
  }
  const primaryProcess = processes.find(
    (process) => process?.role === "primary-visual-receiver",
  );
  const passiveLabels = new Set(
    processes
      .filter((process) => process?.role === "passive-telemetry-receiver")
      .map((process) => process.label),
  );
  if (
    !processLabels.includes("publisher") ||
    primaryProcess?.label !== receiverLabels[0] ||
    receiverLabels.slice(1).some((label) => !passiveLabels.has(label)) ||
    processLabels.some(
      (label) => label !== "publisher" && !receiverLabels.includes(label),
    )
  ) {
    failures.push("codec and process labels are not cross-bound");
  }
  const windowId = performance?.measurementWindow?.id;
  if (
    performance?.publisher?.measurementWindow?.id !== windowId ||
    receivers.some(
      (receiver) => receiver?.measurementWindow?.id !== windowId,
    ) ||
    processes.some((process) => processWindowId(process) !== windowId)
  ) {
    failures.push("performance evidence spans different measurement windows");
  }
  if (
    nonEmptyString(performance?.hardwareIdentityId) === null ||
    processes.some(
      (process) =>
        process?.hardwareIdentityId !== performance.hardwareIdentityId,
    )
  ) {
    failures.push("performance hardware identity binding is inconsistent");
  }
  if (
    performance?.primaryVisualObserver?.process?.label !==
      primaryProcess?.label ||
    !performance?.primaryVisualObserver?.samplerOverhead ||
    typeof performance.primaryVisualObserver.samplerOverhead !== "object"
  ) {
    failures.push("primary visual observer authority is inconsistent");
  }
  return Array.from(new Set(failures));
}

export function assessMeetingPerformance({
  publisherCodec,
  receiverCodecs,
  browserProcesses,
  hardwareIdentities,
  primarySamplerOverhead,
  measurementWindow,
  expectedReceiverCount,
} = {}) {
  const harnessFailures = [];
  const productFailures = [];
  if (!validMeasurementWindow(measurementWindow)) {
    harnessFailures.push("meeting performance measurement window is missing");
  }
  if (
    !Number.isInteger(expectedReceiverCount) ||
    expectedReceiverCount < 1
  ) {
    harnessFailures.push("expected receiver count is missing");
  }
  if (
    !resultAuthorityIsConsistent(
      publisherCodec,
      CODEC_PERFORMANCE_VERSION,
    ) ||
    publisherCodec?.measurementWindow?.id !== measurementWindow?.id
  ) {
    harnessFailures.push("publisher codec performance evidence is malformed");
  }
  for (const failure of publisherCodec?.harnessFailures ?? []) {
    harnessFailures.push(`[publisher] ${failure}`);
  }
  for (const failure of publisherCodec?.productFailures ?? []) {
    productFailures.push(`[publisher] ${failure}`);
  }
  const receivers = Array.isArray(receiverCodecs) ? receiverCodecs : [];
  const receiverLabels = receivers.map((receiver) => receiver?.label);
  if (
    receivers.length !== expectedReceiverCount ||
    receiverLabels.some((label) => nonEmptyString(label) === null) ||
    new Set(receiverLabels).size !== receiverLabels.length
  ) {
    harnessFailures.push(
      `receiver codec performance covers ${receivers.length}/${expectedReceiverCount ?? "missing"} uniquely labeled receivers`,
    );
  }
  for (const receiver of receivers) {
    const label = receiver?.label ?? "receiver";
    if (
      !resultAuthorityIsConsistent(receiver, CODEC_PERFORMANCE_VERSION) ||
      receiver?.measurementWindow?.id !== measurementWindow?.id
    ) {
      harnessFailures.push(`[${label}] codec performance evidence is malformed`);
    }
    for (const failure of receiver?.harnessFailures ?? []) {
      harnessFailures.push(`[${label}] ${failure}`);
    }
    for (const failure of receiver?.productFailures ?? []) {
      productFailures.push(`[${label}] ${failure}`);
    }
  }
  const processes = Array.isArray(browserProcesses) ? browserProcesses : [];
  if (processes.length !== expectedReceiverCount + 1) {
    harnessFailures.push(
      `browser process evidence covers ${processes.length}/${(expectedReceiverCount ?? 0) + 1} Chrome instances`,
    );
  }
  const processLabels = processes.map((process) => process?.label);
  const processPids = processes.map((process) => process?.expectedBrowserPid);
  for (const process of processes) {
    const label = process?.label ?? "browser";
    if (
      !resultAuthorityIsConsistent(process, PROCESS_PERFORMANCE_VERSION) ||
      processWindowId(process) !== measurementWindow?.id
    ) {
      harnessFailures.push(`[${label}] process performance evidence is malformed`);
    }
    for (const failure of process?.harnessFailures ?? []) {
      harnessFailures.push(`[${label}] ${failure}`);
    }
    for (const failure of process?.productFailures ?? []) {
      productFailures.push(`[${label}] ${failure}`);
    }
  }
  if (
    processLabels.some((label) => nonEmptyString(label) === null) ||
    new Set(processLabels).size !== processLabels.length ||
    processPids.some((pid) => !Number.isInteger(pid) || pid <= 0) ||
    new Set(processPids).size !== processPids.length
  ) {
    harnessFailures.push("browser process labels or exact PIDs are duplicated");
  }
  const roleCounts = processRoleCounts(processes);
  const primaryProcess = processes.find(
    (process) => process?.role === "primary-visual-receiver",
  );
  const passiveLabels = new Set(
    processes
      .filter((process) => process?.role === "passive-telemetry-receiver")
      .map((process) => process.label),
  );
  if (
    roleCounts.publisher !== 1 ||
    roleCounts["primary-visual-receiver"] !== 1 ||
    (roleCounts["passive-telemetry-receiver"] ?? 0) !==
      Math.max(0, (expectedReceiverCount ?? 0) - 1) ||
    !processLabels.includes("publisher") ||
    primaryProcess?.label !== receiverLabels[0] ||
    receiverLabels.slice(1).some((label) => !passiveLabels.has(label))
  ) {
    harnessFailures.push("browser process roles/labels do not match receivers");
  }
  const identities = Array.isArray(hardwareIdentities)
    ? hardwareIdentities
    : [];
  const identityIds = Array.from(
    new Set(
      identities
        .map((identity) => identity?.hardwareIdentityId)
        .filter(Boolean),
    ),
  );
  if (
    identities.length !== processes.length ||
    identities.some(
      (identity, index) =>
        identity?.complete !== true ||
        identity?.hardwareIdentityId !== processes[index]?.hardwareIdentityId ||
        (identity?.label && identity.label !== processes[index]?.label),
    ) ||
    identityIds.length !== 1
  ) {
    harnessFailures.push(
      "hardware identity is missing, misbound, or differs between Chrome instances",
    );
  }
  if (!primarySamplerOverhead || typeof primarySamplerOverhead !== "object") {
    harnessFailures.push("primary visual observer overhead is missing");
  }
  const uniqueHarnessFailures = Array.from(new Set(harnessFailures));
  const uniqueProductFailures = Array.from(new Set(productFailures));
  const result = {
    version: CODEC_PERFORMANCE_VERSION,
    measurementWindow: measurementWindow ?? null,
    expectedReceiverCount: Number.isInteger(expectedReceiverCount)
      ? expectedReceiverCount
      : null,
    valid: uniqueHarnessFailures.length === 0,
    passed:
      uniqueHarnessFailures.length === 0 && uniqueProductFailures.length === 0,
    harnessFailures: uniqueHarnessFailures,
    productFailures: uniqueProductFailures,
    failures: [...uniqueHarnessFailures, ...uniqueProductFailures],
    hardwareIdentityId: identityIds.length === 1 ? identityIds[0] : null,
    publisher: publisherCodec ?? null,
    receivers,
    browserProcesses: processes,
    primaryVisualObserver: {
      process: primaryProcess ?? null,
      samplerOverhead: primarySamplerOverhead ?? null,
    },
  };
  const envelopeFailures = validateMeetingPerformanceEvidence(result).filter(
    (failure) =>
      failure !== "meeting performance result authority is inconsistent",
  );
  if (envelopeFailures.length === 0) return result;
  const finalHarnessFailures = Array.from(
    new Set([...result.harnessFailures, ...envelopeFailures]),
  );
  return {
    ...result,
    valid: false,
    passed: false,
    harnessFailures: finalHarnessFailures,
    failures: [...finalHarnessFailures, ...result.productFailures],
  };
}

import { parseVideoQualityReceiverCount } from "./receiver-count.mjs";

export const CONSUMER_GENERATION_RESET_DEBUG_VERSION = 1;
export const STARTUP_FRAME_CONTINUITY_VERSION = 2;
export const STARTUP_SIMULCAST_JITTER_RESET_REASON =
  "startup-simulcast-jitter-reset";
export const MAXIMUM_RESET_COMPLETION_MS = 15_000;
export const MAXIMUM_RESET_ATTEMPTS = 2;

const RESET_STATUSES = new Set([
  "waiting-for-high-layer",
  "queued",
  "replacing",
  "verifying",
  "retry-wait",
  "completed",
  "failed",
  "cancelled",
]);

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

const isNullableFinite = (value) => value === null || finite(value) !== null;

const isNullableInteger = (value) =>
  value === null || Number.isInteger(value);

const isNullableString = (value) =>
  value === null || typeof value === "string";

const isPassiveHighLayerWait = (entry) =>
  entry?.attempt === 0 &&
  entry?.replacementStartedAt === null &&
  entry?.replacementConsumerId === null &&
  (entry?.status === "waiting-for-high-layer" ||
    (entry?.status === "failed" &&
      entry?.failureReason === "high-layer-convergence-timeout"));

const isResetEntrySchemaValid = (entry) =>
  entry &&
  nonEmptyString(entry.producerId) &&
  nonEmptyString(entry.previousConsumerId) &&
  (entry.replacementConsumerId === null ||
    nonEmptyString(entry.replacementConsumerId)) &&
  entry.reason === STARTUP_SIMULCAST_JITTER_RESET_REASON &&
  RESET_STATUSES.has(entry.status) &&
  finite(entry.startedAt) !== null &&
  entry.startedAt >= 0 &&
  isNullableFinite(entry.replacementStartedAt) &&
  (entry.replacementStartedAt === null || entry.replacementStartedAt >= 0) &&
  isNullableFinite(entry.completedAt) &&
  (entry.completedAt === null || entry.completedAt >= 0) &&
  Number.isInteger(entry.attempt) &&
  entry.attempt >= 0 &&
  Number.isInteger(entry.maximumSpatialLayer) &&
  entry.maximumSpatialLayer >= 1 &&
  isNullableInteger(entry.observedSpatialLayer) &&
  isNullableString(entry.failureReason);

const isResetEntryTimelineValid = (entry) => {
  if (!isResetEntrySchemaValid(entry)) return false;
  if (
    entry.replacementStartedAt !== null &&
    entry.replacementStartedAt < entry.startedAt
  ) {
    return false;
  }
  if (entry.completedAt !== null && entry.completedAt < entry.startedAt) {
    return false;
  }
  if (entry.status !== "completed") return true;
  return (
    entry.replacementStartedAt !== null &&
    entry.completedAt !== null &&
    entry.completedAt >= entry.replacementStartedAt &&
    entry.failureReason === null
  );
};

export function shouldExpectStartupConsumerGenerationReset({
  codecScenario,
  receiverCount,
  receiverConsumer,
  publisherTopologyMode,
}) {
  return (
    codecScenario === "native-compat" &&
    parseVideoQualityReceiverCount(receiverCount) > 1 &&
    publisherTopologyMode === "adaptive-layers" &&
    receiverConsumer?.currentLayers?.spatialLayer === 2 &&
    receiverConsumer?.preferredLayers?.spatialLayer === 2
  );
}

/**
 * Assess the one-time overlapping consumer replacement used to discard
 * startup simulcast jitter history. Debug records prove product intent and
 * completion; requestVideoFrameCallback track transitions independently prove
 * the user-visible interruption that ordinary warmup would otherwise hide.
 */
export function assessConsumerGenerationReset({
  codecScenario,
  receiverCount,
  expectedProducerId,
  receiverConsumer,
  publisherTopologyMode,
  producerTopologyTransition,
  debugVersion,
  resetEntries,
  startup,
  maximumVisibleInterruptionMs,
}) {
  const expected = shouldExpectStartupConsumerGenerationReset({
    codecScenario,
    receiverCount,
    receiverConsumer,
    publisherTopologyMode,
  });
  const harnessFailures = [];
  const productFailures = [];
  const entries = Array.isArray(resetEntries) ? resetEntries : [];
  const transitions = Array.isArray(
    startup?.frameContinuity?.consumerGenerationTransitions,
  )
    ? startup.frameContinuity.consumerGenerationTransitions
    : [];

  if (debugVersion !== CONSUMER_GENERATION_RESET_DEBUG_VERSION) {
    harnessFailures.push(
      `consumer-generation reset debug schema is ${debugVersion ?? "missing"}; expected ${CONSUMER_GENERATION_RESET_DEBUG_VERSION}`,
    );
  }
  if (!Array.isArray(resetEntries)) {
    harnessFailures.push("consumer-generation reset audit entries are missing");
  } else if (!entries.every(isResetEntryTimelineValid)) {
    harnessFailures.push(
      "consumer-generation reset audit contains an invalid or legacy entry",
    );
  }
  if (
    codecScenario === "native-compat" &&
    parseVideoQualityReceiverCount(receiverCount) > 1 &&
    publisherTopologyMode !== "adaptive-layers"
  ) {
    harnessFailures.push(
      `native VP8 consumer-reset evidence is not bound to the proven adaptive-layers topology (${publisherTopologyMode ?? "missing"})`,
    );
  }
  if (startup?.version !== STARTUP_FRAME_CONTINUITY_VERSION) {
    harnessFailures.push(
      `startup frame-continuity schema is ${startup?.version ?? "missing"}; expected ${STARTUP_FRAME_CONTINUITY_VERSION}`,
    );
  }

  const producerEntries = entries.filter(
    (entry) =>
      entry?.producerId === expectedProducerId &&
      entry?.reason === STARTUP_SIMULCAST_JITTER_RESET_REASON,
  );
  const completedEntries = producerEntries.filter(
    (entry) => entry?.status === "completed",
  );
  const unexpectedResetActivity = producerEntries.filter(
    (entry) => !isPassiveHighLayerWait(entry),
  );
  const finalConsumerId = receiverConsumer?.consumerId ?? null;
  const completed = completedEntries.length === 1 ? completedEntries[0] : null;

  if (expected) {
    if (producerEntries.length !== 1) {
      productFailures.push(
        `expected exactly one planned consumer-generation reset audit for producer ${expectedProducerId ?? "missing"}; observed ${producerEntries.length}`,
      );
    }
    if (completedEntries.length !== 1) {
      productFailures.push(
        `expected exactly one completed consumer-generation reset; observed ${completedEntries.length}`,
      );
    }
    if (completed) {
      const completionDurationMs =
        finite(completed.completedAt) !== null &&
        finite(completed.startedAt) !== null
          ? completed.completedAt - completed.startedAt
          : null;
      if (
        !nonEmptyString(completed.replacementConsumerId) ||
        completed.replacementConsumerId === completed.previousConsumerId
      ) {
        productFailures.push(
          "completed consumer-generation reset does not identify a distinct replacement consumer",
        );
      }
      if (completed.replacementConsumerId !== finalConsumerId) {
        productFailures.push(
          `consumer-generation reset replacement ${completed.replacementConsumerId ?? "missing"} is not the final bound consumer ${finalConsumerId ?? "missing"}`,
        );
      }
      if (
        completed.maximumSpatialLayer !== 2 ||
        completed.observedSpatialLayer !== 2
      ) {
        productFailures.push(
          `consumer-generation reset was not authorized by top-layer convergence (${completed.observedSpatialLayer ?? "missing"}/${completed.maximumSpatialLayer ?? "missing"})`,
        );
      }
      if (
        completionDurationMs === null ||
        completionDurationMs < 0 ||
        completionDurationMs > MAXIMUM_RESET_COMPLETION_MS
      ) {
        productFailures.push(
          `consumer-generation reset completion took ${completionDurationMs ?? "missing"}ms; expected 0-${MAXIMUM_RESET_COMPLETION_MS}ms`,
        );
      }
      if (completed.attempt > MAXIMUM_RESET_ATTEMPTS) {
        productFailures.push(
          `consumer-generation reset required ${completed.attempt} attempts; maximum is ${MAXIMUM_RESET_ATTEMPTS}`,
        );
      }
      if (completed.attempt < 1) {
        productFailures.push(
          "completed consumer-generation reset has no replacement attempt",
        );
      }
    }

    if (startup?.frameContinuity?.supported !== true) {
      harnessFailures.push(
        "requestVideoFrameCallback continuity evidence is unavailable for the planned reset",
      );
    }
    if ((startup?.frameContinuity?.presentedFrameCount ?? 0) < 2) {
      harnessFailures.push(
        "fewer than two presented frames were observed across startup",
      );
    }
    if (
      finalConsumerId &&
      startup?.frameContinuity?.lastPresentedConsumerId !== finalConsumerId
    ) {
      productFailures.push(
        `last presented startup frame belongs to ${startup?.frameContinuity?.lastPresentedConsumerId ?? "missing"}; expected final consumer ${finalConsumerId}`,
      );
    }
    if (transitions.length !== 1) {
      productFailures.push(
        `expected exactly one visible consumer-generation transition; observed ${transitions.length}`,
      );
    }

    const matchingTransitions = completed
      ? transitions.filter(
          (transition) =>
            transition?.fromConsumerId === completed.previousConsumerId &&
            transition?.toConsumerId === completed.replacementConsumerId,
        )
      : [];
    if (completed && matchingTransitions.length !== 1) {
      harnessFailures.push(
        "presented-frame transition is not bound to the audited consumer replacement",
      );
    }
    const matchingTransition =
      matchingTransitions.length === 1 ? matchingTransitions[0] : null;
    if (
      matchingTransition &&
      (matchingTransition.fromProducerId !== expectedProducerId ||
        matchingTransition.toProducerId !== expectedProducerId)
    ) {
      harnessFailures.push(
        "presented-frame transition is not bound to the audited producer generation",
      );
    }
    const visibleInterruptionMs = finite(
      matchingTransition?.visibleInterruptionMs,
    );
    const firstDecodeThroughResetMaximumGapMs = finite(
      startup?.frameContinuity
        ?.firstDecodeThroughFirstConsumerTransitionMaximumGapMs,
    );
    if (
      !Number.isFinite(maximumVisibleInterruptionMs) ||
      maximumVisibleInterruptionMs <= 0
    ) {
      harnessFailures.push(
        "consumer-generation reset interruption budget is missing",
      );
    } else if (
      matchingTransition &&
      (visibleInterruptionMs === null ||
        visibleInterruptionMs > maximumVisibleInterruptionMs)
    ) {
      productFailures.push(
        `consumer-generation reset caused ${visibleInterruptionMs ?? "missing"}ms of visible interruption; maximum is ${maximumVisibleInterruptionMs}ms`,
      );
    }
    if (matchingTransition && firstDecodeThroughResetMaximumGapMs === null) {
      harnessFailures.push(
        "first-decode-through-reset frame-gap evidence is missing",
      );
    } else if (
      matchingTransition &&
      Number.isFinite(maximumVisibleInterruptionMs) &&
      firstDecodeThroughResetMaximumGapMs > maximumVisibleInterruptionMs
    ) {
      productFailures.push(
        `first-decode-through-reset maximum visible gap was ${firstDecodeThroughResetMaximumGapMs}ms; maximum is ${maximumVisibleInterruptionMs}ms`,
      );
    }
  } else {
    if (unexpectedResetActivity.length > 0) {
      productFailures.push(
        `consumer-generation reset recorded ${unexpectedResetActivity.length} unexpected churn entr${unexpectedResetActivity.length === 1 ? "y" : "ies"} when no top-layer simulcast reset was expected`,
      );
    }

    if (transitions.length > 0) {
      const topologyInitialProducerId =
        producerTopologyTransition?.initialProducerId ?? null;
      const topologyFinalProducerId =
        producerTopologyTransition?.finalProducerId ?? null;
      const visibleHandoff = transitions.length === 1 ? transitions[0] : null;
      const isBoundTrueSingleProducerHandoff =
        publisherTopologyMode === "single-receiver" &&
        producerEntries.length === 0 &&
        producerTopologyTransition?.required === true &&
        producerTopologyTransition?.observed === true &&
        producerTopologyTransition?.finalProducerTopology ===
          "vp8-single-layer" &&
        producerTopologyTransition?.finalTransitionPhase === "single" &&
        producerTopologyTransition?.finalProofBasis === "single-layer" &&
        nonEmptyString(topologyInitialProducerId) &&
        nonEmptyString(topologyFinalProducerId) &&
        topologyInitialProducerId !== topologyFinalProducerId &&
        topologyFinalProducerId === expectedProducerId &&
        receiverConsumer?.producerId === topologyFinalProducerId &&
        nonEmptyString(visibleHandoff?.fromConsumerId) &&
        nonEmptyString(visibleHandoff?.toConsumerId) &&
        visibleHandoff.fromConsumerId !== visibleHandoff.toConsumerId &&
        visibleHandoff?.fromProducerId === topologyInitialProducerId &&
        visibleHandoff?.toProducerId === topologyFinalProducerId &&
        visibleHandoff?.toConsumerId === finalConsumerId &&
        startup?.frameContinuity?.lastPresentedConsumerId === finalConsumerId &&
        startup?.frameContinuity?.lastPresentedProducerId ===
          topologyFinalProducerId;

      if (!isBoundTrueSingleProducerHandoff) {
        productFailures.push(
          `observed ${transitions.length} visible consumer-generation transition(s) when no reset was expected and no authoritative true-single producer handoff was bound`,
        );
      }
    }
  }

  const matchingTransition = completed
    ? transitions.find(
        (transition) =>
          transition?.fromConsumerId === completed.previousConsumerId &&
          transition?.toConsumerId === completed.replacementConsumerId,
      ) ?? null
    : null;

  return {
    version: 1,
    expected,
    valid: harnessFailures.length === 0,
    passed: harnessFailures.length === 0 && productFailures.length === 0,
    expectedProducerId: expectedProducerId ?? null,
    finalConsumerId,
    publisherTopologyMode: publisherTopologyMode ?? null,
    producerTopologyTransition: producerTopologyTransition
      ? { ...producerTopologyTransition }
      : null,
    debugVersion: debugVersion ?? null,
    auditEntryCount: producerEntries.length,
    auditEntries: producerEntries.map((entry) => ({ ...entry })),
    completedEntryCount: completedEntries.length,
    completedEntry: completed,
    frameContinuityVersion: startup?.version ?? null,
    frameCallbackSupported:
      startup?.frameContinuity?.supported ?? null,
    visibleTransitionCount: transitions.length,
    visibleTransition: matchingTransition,
    visibleInterruptionMs:
      finite(matchingTransition?.visibleInterruptionMs),
    firstDecodeThroughResetMaximumGapMs: finite(
      startup?.frameContinuity
        ?.firstDecodeThroughFirstConsumerTransitionMaximumGapMs,
    ),
    maximumVisibleInterruptionMs:
      finite(maximumVisibleInterruptionMs),
    harnessFailures,
    productFailures,
  };
}

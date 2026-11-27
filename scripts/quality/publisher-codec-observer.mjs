import {
  CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS,
  extractPublisherCodecObservation,
  publisherSenderEncodingSignature,
} from "./codec-performance.mjs";
import { startEpochAlignedObserver } from "./epoch-aligned-observer.mjs";

export function startPublisherCodecObserver({
  collectPayload,
  binding,
  producerId,
  codecMimeType,
  expectedEncodingCount,
  measurementWindow,
  allowTrackReplacement = false,
  allowEncodingParameterChanges = false,
  buildAdditionalObservation = null,
  schedulerOptions = {},
} = {}) {
  if (typeof collectPayload !== "function") {
    throw new TypeError("publisher codec observer requires collectPayload");
  }
  const expected = {
    producerId,
    connectionId: binding?.connectionId,
    senderId: binding?.senderId,
    trackId: binding?.trackId,
    codecMimeType,
    expectedEncodingCount,
    senderEncodingSignature: publisherSenderEncodingSignature(
      binding?.parameters,
    ),
    observerStartedAtEpochMs: measurementWindow?.startedAtEpochMs,
    measurementWindowId: measurementWindow?.id,
    allowTrackReplacement,
    allowEncodingParameterChanges,
  };
  return startEpochAlignedObserver({
    measurementWindow,
    observationIntervalMs: CODEC_PERFORMANCE_OBSERVATION_INTERVAL_MS,
    ...schedulerOptions,
    observe: async (tick) => {
      const payload = await collectPayload(tick);
      const observation = extractPublisherCodecObservation(
        {
          ...payload,
          measurementWindowId: measurementWindow.id,
        },
        expected,
      );
      const additionalObservation =
        typeof buildAdditionalObservation === "function"
          ? buildAdditionalObservation(payload, tick, observation)
          : null;
      return {
        ...observation,
        ...(additionalObservation ?? {}),
        measurementWindowId: measurementWindow.id,
        captureCompletedAtEpochMs: observation.capturedAtEpochMs,
      };
    },
  });
}

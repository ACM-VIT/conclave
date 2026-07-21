import { summarizeCaptureToDisplayLatency } from "./media-latency.mjs";
import {
  summarizeJitterBufferDelayObservations,
  summarizeReceiverPlayoutPolicyObservations,
} from "./scoring.mjs";

export const RECEIVER_TELEMETRY_ASSESSMENT_VERSION = 1;
export const RECEIVER_TELEMETRY_OBSERVATION_INTERVAL_MS = 500;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const unique = (values) => Array.from(new Set(values));

const hasCompleteBinding = (binding) =>
  [
    "producerId",
    "consumerId",
    "connectionId",
    "statId",
    "ssrc",
    "codecMimeType",
  ].every((field) => String(binding?.[field] ?? "").length > 0);

const observationMatchesBinding = (observation, expected) =>
  ["producerId", "consumerId", "connectionId", "statId", "ssrc"].every(
    (field) =>
      String(observation?.[field] ?? "") === String(expected?.[field] ?? ""),
  ) &&
  String(observation?.codecMimeType ?? "").toLowerCase() ===
    String(expected?.codecMimeType ?? "").toLowerCase();

const hasExactRtpObservation = (observation) =>
  [
    "capturedAtEpochMs",
    "sampledAtMs",
    "frameWidth",
    "frameHeight",
    "framesDecoded",
    "framesDropped",
    "bytesReceived",
    "packetsReceived",
    "packetsLost",
    "jitter",
    "jitterBufferDelay",
    "jitterBufferTargetDelay",
    "jitterBufferMinimumDelay",
    "jitterBufferEmittedCount",
  ].every((field) => finite(observation?.[field]) !== null);

const assessFinalPlayoutPolicy = (policy, profile, harnessFailures, productFailures) => {
  if (policy?.evidencePresent !== true) {
    harnessFailures.push("exact-bound receiver playout policy is missing");
    return;
  }
  if (
    policy.kind !== "video" ||
    !policy.consumerId ||
    !policy.producerId ||
    policy.consumerId !== policy.expectedConsumerId ||
    policy.producerId !== policy.expectedProducerId
  ) {
    harnessFailures.push(
      "receiver playout policy is not bound to the measured video consumer",
    );
    return;
  }
  const requestedTargetMs = finite(policy.requestedTargetMs);
  const observedTargetMs = finite(policy.observedTargetMs);
  if (
    requestedTargetMs === null ||
    requestedTargetMs <= 0 ||
    observedTargetMs === null ||
    observedTargetMs !== requestedTargetMs ||
    !["applied", "unchanged"].includes(policy.status)
  ) {
    productFailures.push(
      `receiver playout target was not authoritatively applied (${policy.status ?? "missing"}, requested ${requestedTargetMs ?? "missing"}ms, observed ${observedTargetMs ?? "missing"}ms)`,
    );
  } else if (
    requestedTargetMs > profile.maximumJitterBufferDelayMsPerFrame
  ) {
    productFailures.push(
      `requested receiver playout target ${requestedTargetMs}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
    );
  }
};

export function assessReceiverTelemetry({
  receiver,
  sourceEvidence,
  profile,
  durationMs,
  targetFps,
} = {}) {
  const harnessFailures = [];
  const productFailures = [];
  if (!profile || typeof profile !== "object" || !profile.name) {
    harnessFailures.push("receiver quality profile is missing");
    profile = {};
  }
  const requiredProfileThresholds = [
    "minimumDecodedFps",
    "minimumDecodedHeight",
    "maximumFreezeRatio",
    "maximumP95FrameGapMs",
    "maximumVisibleFrameGapMs",
    "maximumDroppedFrameRatio",
    "maximumReceiverPacketLossRatio",
    "maximumJitterBufferDelayMsPerFrame",
    "maximumCaptureToDisplayP95Ms",
    "maximumCaptureToDisplayMs",
    "maximumReceiverVideoBitrateBps",
  ];
  if (
    requiredProfileThresholds.some(
      (field) => finite(profile?.[field]) === null,
    )
  ) {
    harnessFailures.push("receiver quality profile thresholds are incomplete");
  }
  const cadence = receiver?.cadence ?? null;
  const rtc = receiver?.rtc ?? null;
  const binding = receiver?.binding ?? receiver?.mediaPathBinding ?? null;
  const observations = Array.isArray(binding?.observations)
    ? binding.observations
    : [];
  const measurementDurationMs = Math.max(
    1,
    finite(receiver?.durationMs) ?? finite(durationMs) ?? 1,
  );
  const expectedTargetFps = Math.max(1, finite(targetFps) ?? 30);
  const callbackCount = finite(cadence?.callbackCount);
  const presentedFrameCount = finite(cadence?.presentedFrameCount);
  const presentedFps =
    presentedFrameCount === null
      ? null
      : presentedFrameCount / (measurementDurationMs / 1_000);
  const rtcDecodedFps =
    finite(rtc?.decodedFramesPerSecond) ??
    (finite(rtc?.framesDecodedDelta) === null
      ? null
      : rtc.framesDecodedDelta / (measurementDurationMs / 1_000));
  const decodedFps = presentedFps ?? rtcDecodedFps;
  const cadenceFreezeDurationMs = finite(cadence?.freezeDurationMs);
  const rtcFreezeDurationMs = finite(rtc?.totalFreezesDurationMs);
  const freezeDurationMs = Math.max(
    0,
    cadenceFreezeDurationMs ?? 0,
    rtcFreezeDurationMs ?? 0,
  );
  const freezeRatio = freezeDurationMs / measurementDurationMs;
  const decodedFrames = finite(rtc?.framesDecodedDelta);
  const droppedFrames = finite(rtc?.framesDroppedDelta);
  const droppedRatio =
    decodedFrames !== null &&
    droppedFrames !== null &&
    decodedFrames + droppedFrames > 0
      ? droppedFrames / (decodedFrames + droppedFrames)
      : null;
  const p95FrameGapMs = finite(cadence?.p95FrameGapMs);
  const maximumFrameGapMs = finite(cadence?.longestGapMs);
  const packetLossRatio = finite(rtc?.packetLossRatio);
  const bitrateBps = finite(rtc?.averageVideoBitrateBps);
  const jitterBufferDelayMsPerFrame = finite(
    rtc?.jitterBufferDelayMsPerFrame,
  );
  const jitterIntervals = summarizeJitterBufferDelayObservations(observations);
  const playoutObservations =
    summarizeReceiverPlayoutPolicyObservations(observations);
  const latency =
    receiver?.captureToDisplayLatency ??
    summarizeCaptureToDisplayLatency({
      sourceEvidence,
      presentationEvidence: receiver?.captureToDisplayPresentation,
      cadence,
    });

  if (typeof receiver?.label !== "string" || receiver.label.length === 0) {
    harnessFailures.push("receiver telemetry label is missing");
  }
  if (
    typeof receiver?.profile?.name !== "string" ||
    receiver.profile.name !== profile.name
  ) {
    harnessFailures.push("receiver telemetry profile assignment is missing or mismatched");
  }
  if (!receiver || receiver.ok !== true) {
    harnessFailures.push("receiver sampler result is missing or unsuccessful");
  }
  if (receiver?.mode !== receiver?.expectedSamplerMode) {
    harnessFailures.push(
      `sampler mode ${receiver?.mode ?? "missing"} does not match expected ${receiver?.expectedSamplerMode ?? "missing"}`,
    );
  }
  if (!["visual", "telemetry"].includes(receiver?.mode)) {
    harnessFailures.push("receiver sampler mode is missing or unsupported");
  }
  if (cadence?.usesRequestVideoFrameCallback !== true) {
    harnessFailures.push("requestVideoFrameCallback authority is unavailable");
  }
  if (
    !Number.isInteger(callbackCount) ||
    callbackCount <= 0 ||
    !Number.isInteger(presentedFrameCount) ||
    presentedFrameCount <= 0
  ) {
    harnessFailures.push("compositor cadence evidence is unavailable");
  }
  if (!hasCompleteBinding(binding?.expected)) {
    harnessFailures.push("exact receiver media-path binding is incomplete");
  }
  if (binding?.valid !== true || rtc?.boundMediaPathMatched !== true) {
    harnessFailures.push(
      "producer/consumer/PC/stat/SSRC/codec/layer path was not continuous",
    );
  }
  if (receiver?.connection?.pathContinuous !== true) {
    harnessFailures.push(
      "receiver connection did not remain on the exact bound media path",
    );
  }
  if (
    binding?.observationIntervalMs !==
    RECEIVER_TELEMETRY_OBSERVATION_INTERVAL_MS
  ) {
    harnessFailures.push(
      `receiver path observations are not bound to ${RECEIVER_TELEMETRY_OBSERVATION_INTERVAL_MS}ms cadence`,
    );
  }
  if (
    !receiver?.peerConnectionStats?.start ||
    !receiver?.peerConnectionStats?.end
  ) {
    harnessFailures.push("receiver start/end peer-connection stats are missing");
  }
  const expectedObservationCount = Math.floor(
    measurementDurationMs / RECEIVER_TELEMETRY_OBSERVATION_INTERVAL_MS,
  );
  const minimumObservationCount = Math.max(
    4,
    Math.ceil(expectedObservationCount * 0.8),
  );
  if (observations.length < minimumObservationCount) {
    harnessFailures.push(
      `receiver path observations ${observations.length}/${minimumObservationCount} required are sparse`,
    );
  }
  if (
    observations.some(
      (observation) =>
        observation?.matched !== true ||
        !observationMatchesBinding(observation, binding?.expected) ||
        !hasExactRtpObservation(observation) ||
        observation?.appConnectionState !== "joined" ||
        observation?.peerConnectionState !== "connected" ||
        !["connected", "completed"].includes(
          observation?.iceConnectionState,
        ) ||
        observation?.signalingState !== "stable" ||
        observation?.videoTrackReadyState !== "live" ||
        observation?.videoTrackMuted !== false,
    )
  ) {
    harnessFailures.push(
      "receiver exact RTP, connection, or bound rendered-track continuity was interrupted",
    );
  }
  const pathObserverP95Ms = finite(
    receiver?.samplerOverhead?.pathObservationMs?.p95,
  );
  const pathObserverDutyRatio = finite(
    receiver?.samplerOverhead?.pathObservationDutyRatio,
  );
  if (
    pathObserverP95Ms === null ||
    pathObserverP95Ms > 125 ||
    pathObserverDutyRatio === null ||
    pathObserverDutyRatio > 0.15
  ) {
    harnessFailures.push("receiver path observer overhead exceeded its bound");
  }
  if (receiver?.mode === "telemetry") {
    const frameObserverP95Ms = finite(
      receiver?.samplerOverhead?.frameObserverMs?.p95,
    );
    const frameObserverDutyRatio = finite(
      receiver?.samplerOverhead?.frameObserverDutyRatio,
    );
    const maximumFrameObserverP95Ms = (1_000 / expectedTargetFps) * 0.25;
    if (
      frameObserverP95Ms === null ||
      frameObserverP95Ms > maximumFrameObserverP95Ms ||
      frameObserverDutyRatio === null ||
      frameObserverDutyRatio > 0.1
    ) {
      harnessFailures.push(
        "passive receiver frame observer overhead exceeded its bound",
      );
    }
  }
  if (rtc?.frameCounterResetDetected === true) {
    harnessFailures.push("receiver decoder frame counters reset");
  }
  if (
    decodedFrames === null ||
    droppedFrames === null ||
    decodedFrames < 0 ||
    droppedFrames < 0 ||
    decodedFrames + droppedFrames <= 0
  ) {
    harnessFailures.push("receiver decoder/drop counters are unavailable");
  }
  if (
    finite(rtc?.packetsReceivedDelta) === null ||
    finite(rtc?.packetsLostDelta) === null ||
    (rtc?.packetsReceivedDelta ?? 0) + (rtc?.packetsLostDelta ?? 0) <= 0 ||
    packetLossRatio === null
  ) {
    harnessFailures.push("receiver packet-loss evidence is unavailable");
  }
  if (bitrateBps === null || bitrateBps <= 0) {
    harnessFailures.push("receiver bitrate evidence is unavailable");
  }
  if (rtc?.jitterBufferCounterResetDetected === true) {
    harnessFailures.push("receiver jitter-buffer counters reset");
  }
  if (jitterBufferDelayMsPerFrame === null) {
    harnessFailures.push("receiver jitter-buffer delay is unavailable");
  }
  const intervalCoverageRatio =
    jitterIntervals.coveredDurationMs === null
      ? null
      : jitterIntervals.coveredDurationMs / measurementDurationMs;
  if (
    jitterIntervals.sampleCount < minimumObservationCount ||
    intervalCoverageRatio === null ||
    intervalCoverageRatio < 0.9 ||
    jitterIntervals.maximumObservationIntervalMs === null ||
    jitterIntervals.maximumObservationIntervalMs >
      RECEIVER_TELEMETRY_OBSERVATION_INTERVAL_MS * 2.5 ||
    jitterIntervals.counterResetCount > 0
  ) {
    harnessFailures.push(
      "receiver 500ms jitter-buffer interval evidence is sparse, reset, or discontinuous",
    );
  }
  if (
    playoutObservations.observationCount === 0 ||
    playoutObservations.evidenceCount !==
      playoutObservations.observationCount
  ) {
    harnessFailures.push(
      "exact-bound receiver playout evidence does not cover every path observation",
    );
  } else if (
    playoutObservations.authoritativeCount !==
    playoutObservations.observationCount
  ) {
    productFailures.push(
      `receiver playout target was authoritative for only ${playoutObservations.authoritativeCount}/${playoutObservations.observationCount} observations`,
    );
  }
  if (
    playoutObservations.maximumRequestedTargetMs !== null &&
    playoutObservations.maximumRequestedTargetMs >
      profile.maximumJitterBufferDelayMsPerFrame
  ) {
    productFailures.push(
      `receiver playout target ${playoutObservations.maximumRequestedTargetMs}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
    );
  }
  assessFinalPlayoutPolicy(
    receiver?.playout,
    profile,
    harnessFailures,
    productFailures,
  );
  if (latency?.valid !== true) {
    for (const failure of latency?.harnessFailures ?? [
      "capture-to-display latency evidence is missing",
    ]) {
      harnessFailures.push(`capture-to-display latency: ${failure}`);
    }
  } else if (
    finite(latency?.p95Ms) === null ||
    finite(latency?.maximumMs) === null
  ) {
    harnessFailures.push(
      "capture-to-display latency p95/maximum evidence is missing",
    );
  }
  if (
    receiver?.sourceEvidenceReference !==
    "measurement.publisher.fixture.captureToDisplaySource"
  ) {
    harnessFailures.push("shared publisher source evidence is not referenced");
  }
  if (receiver?.network?.valid !== true) {
    harnessFailures.push("configured receiver network profile was not realized");
  }
  if (
    receiver?.captureAudit?.safe !== true ||
    receiver?.captureAudit?.nativeAudioCallCount !== 0
  ) {
    harnessFailures.push("receiver capture-safety evidence is missing or unsafe");
  }

  if (receiver?.connection?.finalState !== "joined") {
    productFailures.push("receiver was not joined at measurement end");
  }
  const decodedHeight = finite(
    receiver?.renderedVideo?.height ?? rtc?.frameHeight,
  );
  if (decodedHeight === null) {
    harnessFailures.push("receiver decoded resolution evidence is missing");
  } else if (decodedHeight < profile.minimumDecodedHeight) {
    productFailures.push(
      `decoded height ${decodedHeight} is below ${profile.minimumDecodedHeight}`,
    );
  }
  if (decodedFps === null) {
    harnessFailures.push("receiver decoded FPS evidence is missing");
  } else if (decodedFps < profile.minimumDecodedFps) {
    productFailures.push(
      `decoded FPS ${round(decodedFps)} is below ${profile.minimumDecodedFps}`,
    );
  }
  if (cadenceFreezeDurationMs === null && rtcFreezeDurationMs === null) {
    harnessFailures.push("receiver freeze-duration evidence is missing");
  }
  if (freezeRatio > profile.maximumFreezeRatio) {
    productFailures.push(
      `freeze ratio ${round(freezeRatio, 4)} exceeds ${profile.maximumFreezeRatio}`,
    );
  }
  if (p95FrameGapMs === null || maximumFrameGapMs === null) {
    harnessFailures.push("receiver visible-frame gap evidence is missing");
  } else {
    if (p95FrameGapMs > profile.maximumP95FrameGapMs) {
      productFailures.push(
        `p95 visible-frame gap ${p95FrameGapMs}ms exceeds ${profile.maximumP95FrameGapMs}ms`,
      );
    }
    if (maximumFrameGapMs > profile.maximumVisibleFrameGapMs) {
      productFailures.push(
        `maximum visible-frame gap ${maximumFrameGapMs}ms exceeds ${profile.maximumVisibleFrameGapMs}ms`,
      );
    }
  }
  if (droppedRatio !== null && droppedRatio > profile.maximumDroppedFrameRatio) {
    productFailures.push(
      `dropped-frame ratio ${round(droppedRatio, 4)} exceeds ${profile.maximumDroppedFrameRatio}`,
    );
  }
  if (
    packetLossRatio !== null &&
    packetLossRatio > profile.maximumReceiverPacketLossRatio
  ) {
    productFailures.push(
      `packet-loss ratio ${round(packetLossRatio, 4)} exceeds ${profile.maximumReceiverPacketLossRatio}`,
    );
  }
  if (
    jitterBufferDelayMsPerFrame !== null &&
    jitterBufferDelayMsPerFrame > profile.maximumJitterBufferDelayMsPerFrame
  ) {
    productFailures.push(
      `jitter-buffer delay ${jitterBufferDelayMsPerFrame}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
    );
  }
  if (
    jitterIntervals.p95MsPerFrame !== null &&
    jitterIntervals.p95MsPerFrame > profile.maximumJitterBufferDelayMsPerFrame
  ) {
    productFailures.push(
      `500ms jitter-buffer p95 ${jitterIntervals.p95MsPerFrame}ms exceeds ${profile.maximumJitterBufferDelayMsPerFrame}ms`,
    );
  }
  if (latency?.valid === true) {
    if (latency.p95Ms > profile.maximumCaptureToDisplayP95Ms) {
      productFailures.push(
        `capture-to-display p95 ${latency.p95Ms}ms exceeds ${profile.maximumCaptureToDisplayP95Ms}ms`,
      );
    }
    if (latency.maximumMs > profile.maximumCaptureToDisplayMs) {
      productFailures.push(
        `capture-to-display maximum ${latency.maximumMs}ms exceeds ${profile.maximumCaptureToDisplayMs}ms`,
      );
    }
  }
  if (
    bitrateBps !== null &&
    bitrateBps > profile.maximumReceiverVideoBitrateBps
  ) {
    productFailures.push(
      `received video bitrate ${round(bitrateBps, 0)}bps exceeds ${profile.maximumReceiverVideoBitrateBps}bps`,
    );
  }
  if ((receiver?.consoleErrorCount ?? 0) > 0) {
    productFailures.push(
      `receiver emitted ${receiver.consoleErrorCount} console error(s)`,
    );
  }
  if ((receiver?.unexpectedRecoveryCount ?? 0) > 0) {
    productFailures.push(
      `receiver reported ${receiver.unexpectedRecoveryCount} unexpected recovery event(s)`,
    );
  }

  const uniqueHarnessFailures = unique(harnessFailures);
  const uniqueProductFailures = unique(productFailures);
  return {
    version: RECEIVER_TELEMETRY_ASSESSMENT_VERSION,
    valid: uniqueHarnessFailures.length === 0,
    passed:
      uniqueHarnessFailures.length === 0 &&
      uniqueProductFailures.length === 0,
    harnessFailures: uniqueHarnessFailures,
    productFailures: uniqueProductFailures,
    failures: [...uniqueHarnessFailures, ...uniqueProductFailures],
    metrics: {
      targetFps: expectedTargetFps,
      callbackCount,
      presentedFrameCount,
      presentedFps: round(presentedFps),
      rtcDecodedFps: round(rtcDecodedFps),
      decodedFps: round(decodedFps),
      freezeDurationMs: round(freezeDurationMs),
      freezeRatio: round(freezeRatio, 4),
      p95FrameGapMs: round(p95FrameGapMs),
      maximumFrameGapMs: round(maximumFrameGapMs),
      droppedRatio: round(droppedRatio, 4),
      packetLossRatio: round(packetLossRatio, 4),
      jitterBufferDelayMsPerFrame: round(jitterBufferDelayMsPerFrame),
      jitterBufferP95MsPerFrame: jitterIntervals.p95MsPerFrame,
      bitrateBps: round(bitrateBps, 0),
      decodedHeight,
      captureToDisplayP95Ms: latency?.p95Ms ?? null,
      captureToDisplayMaximumMs: latency?.maximumMs ?? null,
      frameObserverP95Ms:
        receiver?.samplerOverhead?.frameObserverMs?.p95 ?? null,
      frameObserverDutyRatio:
        receiver?.samplerOverhead?.frameObserverDutyRatio ?? null,
      pathObserverP95Ms:
        pathObserverP95Ms,
      pathObserverDutyRatio:
        pathObserverDutyRatio,
    },
    jitterIntervals,
    playoutObservations,
    captureToDisplayLatency: latency,
  };
}

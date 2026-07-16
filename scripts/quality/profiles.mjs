export const VIDEO_QUALITY_PROFILES = Object.freeze({
  pristine: Object.freeze({
    name: "pristine",
    description: "Local, unthrottled reference path",
    network: null,
    devicePixelRatio: 2,
    targetVideoBitrateBps: 1_800_000,
    minimumDecodedFps: 26,
    // Hybrid-photo v5 exploratory VP9 runs measured 89.10–89.80. The floor
    // retains 0.60 points beneath that observed band while the final contract
    // requires five independent repetitions and rejects harness-invalid runs.
    minimumVisualScore: 88.5,
    minimumVisualScoreByCodecScenario: Object.freeze({
      // Stable VP8 compatibility runs clustered at 88.82–88.89; a frozen,
      // phase-incomplete 90.74 outlier is intentionally not used as the floor.
      "native-compat": 88,
    }),
    minimumFixturePhaseCoverage: 0.95,
    maximumFreezeRatio: 0.01,
    maximumP95FrameGapMs: 50,
    maximumVisibleFrameGapMs: 150,
    maximumDroppedFrameRatio: 0.02,
    maximumReceiverPacketLossRatio: 0.01,
    maximumReceiverVideoBitrateBps: 2_100_000,
    maximumJitterBufferDelayMsPerFrame: 70,
    // Conservative temporary end-to-end guards. Recalibrate downward from at
    // least five valid schema-matched rooms; never infer these from jitter-
    // buffer delay because capture/encode/decode/render queues are additional.
    maximumCaptureToDisplayP95Ms: 250,
    maximumCaptureToDisplayMs: 500,
    minimumDecodedHeight: 640,
    maximumNavigationToTargetMs: 7_000,
    maximumFirstDecodeToTargetMs: 4_000,
    maximumConsumerGenerationResetInterruptionMs: 250,
    // Provisional hard ceilings for exact 500 ms codec deltas. These are
    // intentionally independent of the full-window average so one expensive
    // encode/decode interval cannot hide inside an otherwise healthy room.
    maximumEncodeMeanMsPerFrame: 20,
    maximumEncodeP95MsPerFrame: 35,
    maximumEncodeMsPerFrame: 75,
    maximumDecodeMeanMsPerFrame: 12,
    maximumDecodeP95MsPerFrame: 22,
    maximumDecodeMsPerFrame: 50,
    maximumCpuQualityLimitationRatio: 0.05,
    maximumPublisherProcessCoreEquivalentsSingleReceiver: 3,
    maximumPublisherProcessCoreEquivalentsMultiReceiver: 4,
    maximumPrimaryVisualReceiverProcessCoreEquivalents: 5,
    maximumPassiveReceiverProcessCoreEquivalents: 2,
  }),
  broadband: Object.freeze({
    name: "broadband",
    description: "Healthy home connection with modest RTT",
    devicePixelRatio: 2,
    network: Object.freeze({
      latencyMs: 45,
      downloadKbps: 10_000,
      uploadKbps: 4_000,
      packetLossPercent: 0,
      packetQueueLength: 64,
      packetReordering: false,
      connectionType: "wifi",
    }),
    targetVideoBitrateBps: 1_800_000,
    minimumDecodedFps: 25,
    minimumVisualScore: 82,
    minimumFixturePhaseCoverage: 0.95,
    maximumFreezeRatio: 0.015,
    maximumP95FrameGapMs: 60,
    maximumVisibleFrameGapMs: 200,
    maximumDroppedFrameRatio: 0.03,
    maximumReceiverPacketLossRatio: 0.015,
    maximumReceiverVideoBitrateBps: 2_100_000,
    maximumJitterBufferDelayMsPerFrame: 85,
    maximumCaptureToDisplayP95Ms: 300,
    maximumCaptureToDisplayMs: 600,
    minimumDecodedHeight: 640,
    maximumNavigationToTargetMs: 7_000,
    maximumFirstDecodeToTargetMs: 5_000,
    maximumConsumerGenerationResetInterruptionMs: 250,
    maximumEncodeMeanMsPerFrame: 22,
    maximumEncodeP95MsPerFrame: 40,
    maximumEncodeMsPerFrame: 85,
    maximumDecodeMeanMsPerFrame: 14,
    maximumDecodeP95MsPerFrame: 25,
    maximumDecodeMsPerFrame: 55,
    maximumCpuQualityLimitationRatio: 0.08,
    maximumPublisherProcessCoreEquivalentsSingleReceiver: 3.25,
    maximumPublisherProcessCoreEquivalentsMultiReceiver: 4,
    maximumPrimaryVisualReceiverProcessCoreEquivalents: 5,
    maximumPassiveReceiverProcessCoreEquivalents: 2,
  }),
  constrained: Object.freeze({
    name: "constrained",
    description: "Busy Wi-Fi / usable mobile uplink",
    devicePixelRatio: 2,
    network: Object.freeze({
      latencyMs: 120,
      downloadKbps: 1_800,
      uploadKbps: 800,
      packetLossPercent: 1,
      packetQueueLength: 32,
      packetReordering: false,
      connectionType: "cellular3g",
    }),
    targetVideoBitrateBps: 650_000,
    minimumDecodedFps: 18,
    minimumVisualScore: 68,
    minimumFixturePhaseCoverage: 0.95,
    maximumFreezeRatio: 0.04,
    maximumP95FrameGapMs: 100,
    maximumVisibleFrameGapMs: 350,
    maximumDroppedFrameRatio: 0.08,
    maximumReceiverPacketLossRatio: 0.05,
    maximumReceiverVideoBitrateBps: 780_000,
    maximumJitterBufferDelayMsPerFrame: 150,
    maximumCaptureToDisplayP95Ms: 500,
    maximumCaptureToDisplayMs: 1_000,
    minimumDecodedHeight: 320,
    maximumNavigationToTargetMs: 8_000,
    maximumFirstDecodeToTargetMs: 4_000,
    maximumConsumerGenerationResetInterruptionMs: 400,
    maximumEncodeMeanMsPerFrame: 30,
    maximumEncodeP95MsPerFrame: 55,
    maximumEncodeMsPerFrame: 120,
    maximumDecodeMeanMsPerFrame: 20,
    maximumDecodeP95MsPerFrame: 38,
    maximumDecodeMsPerFrame: 85,
    maximumCpuQualityLimitationRatio: 0.2,
    maximumPublisherProcessCoreEquivalentsSingleReceiver: 3.75,
    maximumPublisherProcessCoreEquivalentsMultiReceiver: 4.25,
    maximumPrimaryVisualReceiverProcessCoreEquivalents: 5.25,
    maximumPassiveReceiverProcessCoreEquivalents: 2.25,
  }),
  poor: Object.freeze({
    name: "poor",
    description: "Severely constrained and lossy mobile connection",
    devicePixelRatio: 2,
    network: Object.freeze({
      latencyMs: 280,
      downloadKbps: 850,
      uploadKbps: 380,
      packetLossPercent: 3,
      packetQueueLength: 16,
      packetReordering: true,
      connectionType: "cellular3g",
    }),
    targetVideoBitrateBps: 280_000,
    minimumDecodedFps: 9,
    minimumVisualScore: 52,
    minimumFixturePhaseCoverage: 0.95,
    maximumFreezeRatio: 0.12,
    maximumP95FrameGapMs: 180,
    maximumVisibleFrameGapMs: 750,
    maximumDroppedFrameRatio: 0.2,
    maximumReceiverPacketLossRatio: 0.12,
    maximumReceiverVideoBitrateBps: 340_000,
    maximumJitterBufferDelayMsPerFrame: 230,
    maximumCaptureToDisplayP95Ms: 900,
    maximumCaptureToDisplayMs: 1_800,
    minimumDecodedHeight: 160,
    maximumNavigationToTargetMs: 8_000,
    maximumFirstDecodeToTargetMs: 4_000,
    maximumConsumerGenerationResetInterruptionMs: 700,
    maximumEncodeMeanMsPerFrame: 45,
    maximumEncodeP95MsPerFrame: 80,
    maximumEncodeMsPerFrame: 180,
    maximumDecodeMeanMsPerFrame: 30,
    maximumDecodeP95MsPerFrame: 55,
    maximumDecodeMsPerFrame: 120,
    maximumCpuQualityLimitationRatio: 0.35,
    maximumPublisherProcessCoreEquivalentsSingleReceiver: 4,
    maximumPublisherProcessCoreEquivalentsMultiReceiver: 4.5,
    maximumPrimaryVisualReceiverProcessCoreEquivalents: 5.5,
    maximumPassiveReceiverProcessCoreEquivalents: 2.5,
  }),
});

export const DEFAULT_VIDEO_QUALITY_MATRIX = Object.freeze([
  "pristine",
  "broadband",
  "constrained",
  "poor",
]);

export function getVideoQualityProfile(name, codecScenario = "all-modern") {
  const profile = VIDEO_QUALITY_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown video quality profile ${JSON.stringify(name)}. Expected one of: ${Object.keys(
        VIDEO_QUALITY_PROFILES,
      ).join(", ")}`,
    );
  }
  const scenarioMinimum =
    profile.minimumVisualScoreByCodecScenario?.[codecScenario];
  return typeof scenarioMinimum === "number"
    ? Object.freeze({ ...profile, minimumVisualScore: scenarioMinimum })
    : profile;
}

export function resolveVideoQualityReceiverProfiles(
  value,
  {
    receiverCount,
    primaryProfileName,
    codecScenario = "all-modern",
  } = {},
) {
  if (!Number.isInteger(receiverCount) || receiverCount < 1 || receiverCount > 4) {
    throw new Error("receiver count must be an integer from 1 to 4");
  }
  const primaryProfile = getVideoQualityProfile(
    primaryProfileName,
    codecScenario,
  );
  const supplied =
    value == null || (typeof value === "string" && value.trim() === "")
      ? null
      : Array.isArray(value)
        ? value
        : String(value).split(",");
  const names = supplied
    ? supplied.map((name) => String(name).trim())
    : Array(receiverCount).fill(primaryProfile.name);
  if (names.some((name) => name.length === 0)) {
    throw new Error("receiver profiles cannot contain an empty profile name");
  }
  if (names.length !== receiverCount) {
    throw new Error(
      `receiver profiles must contain exactly ${receiverCount} ordered profile name(s)`,
    );
  }
  if (names[0] !== primaryProfile.name) {
    throw new Error(
      `the first receiver profile must match the primary run profile ${primaryProfile.name}`,
    );
  }
  return names.map((name) => getVideoQualityProfile(name, codecScenario));
}

export function resolveVideoCodecPerformanceLimits(profile, kind) {
  if (!profile || typeof profile !== "object") {
    throw new Error("video quality profile is required");
  }
  if (kind === "encode") {
    return Object.freeze({
      maximumMeanMsPerFrame: profile.maximumEncodeMeanMsPerFrame,
      maximumP95MsPerFrame: profile.maximumEncodeP95MsPerFrame,
      maximumMsPerFrame: profile.maximumEncodeMsPerFrame,
      maximumCpuQualityLimitationRatio:
        profile.maximumCpuQualityLimitationRatio,
    });
  }
  if (kind === "decode") {
    return Object.freeze({
      maximumMeanMsPerFrame: profile.maximumDecodeMeanMsPerFrame,
      maximumP95MsPerFrame: profile.maximumDecodeP95MsPerFrame,
      maximumMsPerFrame: profile.maximumDecodeMsPerFrame,
    });
  }
  throw new Error(`Unknown codec performance kind ${JSON.stringify(kind)}`);
}

export function resolveVideoProcessCpuLimit(
  profile,
  role,
  { receiverCount } = {},
) {
  if (!profile || typeof profile !== "object") {
    throw new Error("video quality profile is required");
  }
  if (role === "publisher") {
    if (!Number.isInteger(receiverCount) || receiverCount < 1) {
      throw new Error("receiver count is required for publisher CPU topology");
    }
    return receiverCount === 1
      ? profile.maximumPublisherProcessCoreEquivalentsSingleReceiver
      : profile.maximumPublisherProcessCoreEquivalentsMultiReceiver;
  }
  if (role === "primary-visual-receiver") {
    return profile.maximumPrimaryVisualReceiverProcessCoreEquivalents;
  }
  if (role === "passive-telemetry-receiver") {
    return profile.maximumPassiveReceiverProcessCoreEquivalents;
  }
  throw new Error(`Unknown browser process role ${JSON.stringify(role)}`);
}

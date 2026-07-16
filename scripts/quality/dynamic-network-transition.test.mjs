import assert from "node:assert/strict";
import test from "node:test";
import {
  DYNAMIC_NETWORK_TRANSITION_ASSESSMENT_VERSION,
  DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS,
  DYNAMIC_NETWORK_TRANSITION_ENDPOINTS,
  DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN,
  DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
  DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
  advanceDynamicNetworkHintLedger,
  applyDynamicNetworkCdpMutation,
  assessDynamicNetworkCheckpointAuthority,
  assessDynamicNetworkRealization,
  assessDynamicNetworkTransition,
  buildDynamicNetworkCdpSchedule,
  buildDynamicNetworkCheckpointTargets,
  buildDynamicNetworkHintBootstrapScript,
  buildDynamicNetworkHintApplicationObservationExpression,
  buildDynamicNetworkHintSchedule,
  buildDynamicNetworkHintUpdateExpression,
  buildDynamicNetworkTransitionPlan,
  createDynamicNetworkHintLedger,
  dynamicNetworkDownshiftCheckpointPassed,
  dynamicNetworkRecoveryGoodCheckpointPassed,
  enableDynamicNetworkCdp,
  findSustainedCheckpointProof,
  recordDynamicNetworkHintApplication,
  resolveAuthorityRelativeDeadline,
  validateDynamicNetworkHintUpdate,
} from "./dynamic-network-transition.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

const WINDOW_ID = "schema-13-transition-window";
const WINDOW_STARTED_AT = 1_000_000;
const CDP_TARGET_IDS = Object.freeze({
  publisher: "target-publisher",
  primaryReceiver: "target-primary-receiver",
  controlReceiver: "target-control-receiver",
});
const CDP_SESSION_IDS = Object.freeze({
  publisher: "session-publisher",
  primaryReceiver: "session-primary-receiver",
  controlReceiver: "session-control-receiver",
});

const codecIdentity = (mimeType) => ({
  mimeType,
  payloadType: mimeType === "video/vp9" ? 98 : 96,
  clockRate: 90_000,
  fmtp: mimeType === "video/vp9" ? "profile-id=0" : "",
  scalabilityMode: mimeType === "video/vp9" ? "L2T1" : "L1T1",
  implementation: "libvpx",
  powerEfficient: false,
});

const endpointHintState = (endpoint, offset) => {
  if (offset < 12_000) return { hintGeneration: 1, hintState: "pristine" };
  if (endpoint === "publisher" && offset < 24_000) {
    return { hintGeneration: 1, hintState: "pristine" };
  }
  if (offset < 36_000) {
    return {
      hintGeneration: 2,
      hintState: endpoint === "controlReceiver" ? "pristine" : "poor",
    };
  }
  return { hintGeneration: 3, hintState: "pristine" };
};

const producerIdAt = () => "producer-stable";

const runtimeHintReceipt = (
  ledger,
  update,
  observerId,
  observedAtOffsetMs = update.updatedAtOffsetMs,
) => ({
  version: 1,
  issuedBy: "__conclaveQualityDynamicNetworkHint",
  windowId: ledger.windowId,
  windowStartedAtEpochMs: ledger.measurementWindow.startedAtEpochMs,
  targetId: ledger.targetId,
  sessionId: ledger.sessionId,
  endpoint: ledger.endpoint,
  receiptSequence: update.generation,
  runtimeGeneration: update.generation,
  runtimeDispatchedChangeEventCount: update.generation,
  runtimeObservedChangeEventCount: update.generation,
  runtimeUpdateIndex: update.updateIndex,
  runtimeUpdatedAtEpochMs: update.updatedAtEpochMs,
  runtimeUpdatedAtOffsetMs: update.updatedAtOffsetMs,
  productObservation: {
    version: 1,
    source: "useConnectionQuality",
    observedAtEpochMs:
      ledger.measurementWindow.startedAtEpochMs + observedAtOffsetMs,
    browserNetwork: {
      supported: true,
      quality: update.hint.saveData ? "poor" : "good",
      startupQuality: update.hint.saveData ? "poor" : "good",
      emergency: false,
      effectiveType: update.hint.effectiveType,
      saveData: update.hint.saveData,
      downlinkMbps: update.hint.downlinkMbps,
      rttMs: update.hint.rttMs > 0 ? update.hint.rttMs : null,
    },
  },
  productDebug: {
    source: "__conclaveGetMeetVideoDebug.network",
    observerId,
    capturedAtEpochMs:
      ledger.measurementWindow.startedAtEpochMs + observedAtOffsetMs,
    quality: update.hint.saveData ? "poor" : "good",
    publishAdaptationQuality: update.hint.saveData ? "poor" : "good",
    receiveAdaptationQuality: update.hint.saveData ? "poor" : "good",
  },
  observedConnection: clone(update.hint),
  observedAtEpochMs:
    ledger.measurementWindow.startedAtEpochMs + observedAtOffsetMs,
  observedAtOffsetMs,
});

const endpointSnapshotsAt = (offset, codec) => {
  const producerId = producerIdAt(codec, offset);
  const publisherDownshifted = offset >= 24_500 && offset < 36_000;
  const primaryDownshifted = offset >= 14_000 && offset < 36_000;
  const recoveryGood = offset >= 43_000;
  const recoveryFull = offset >= 88_000;
  const publisher = {
    version: 1,
    ...endpointHintState("publisher", offset),
    connectionQuality: publisherDownshifted
      ? "poor"
      : recoveryGood || offset < 24_000
        ? "good"
        : "fair",
    publishQuality:
      codec === "vp8"
        ? "standard"
        : publisherDownshifted
          ? "low"
          : recoveryFull || offset < 24_000
            ? "standard"
            : "medium",
    networkProfile: publisherDownshifted
      ? "poor"
      : recoveryFull || offset < 24_000
        ? "good"
        : "fair",
    // A failed capture downshift preserves the live high-quality track; the
    // sender's encoded raster below remains the network adaptation authority.
    captureWidth: 1280,
    captureHeight: 720,
    captureFps: 30,
    encodedWidth:
      codec === "vp8"
        ? 1280
        : publisherDownshifted
          ? 284
          : recoveryFull || offset < 24_000
            ? 960
            : 640,
    encodedHeight:
      codec === "vp8"
        ? 720
        : publisherDownshifted
          ? 160
          : recoveryFull || offset < 24_000
            ? 540
            : 360,
    encodedFps: publisherDownshifted
      ? 12
      : recoveryFull || offset < 24_000
        ? 24
        : 18,
    mediaSurvived: true,
    adaptationUpdateInFlight: false,
    producerId,
    fullLadder: codec === "vp8" || recoveryFull || offset < 24_000,
    senderEncodingConfiguration: {
      version: 1,
      degradationPreference:
        codec === "vp9" ? "maintain-resolution" : "maintain-framerate",
      encodings:
        codec === "vp8"
          ? [
              {
                rid: "q",
                active: true,
                maxBitrate: publisherDownshifted ? 80_000 : 80_000,
                maxFramerate: 12,
                scaleResolutionDownBy: 4,
                scalabilityMode: "L1T1",
              },
              {
                rid: "h",
                active: true,
                maxBitrate: publisherDownshifted
                  ? 25_000
                  : recoveryFull || offset < 24_000
                    ? 220_000
                    : 220_000,
                maxFramerate: publisherDownshifted ? 5 : 20,
                scaleResolutionDownBy: 2,
                scalabilityMode: "L1T1",
              },
              {
                rid: "f",
                active: true,
                maxBitrate: publisherDownshifted
                  ? 15_000
                  : recoveryFull || offset < 24_000
                    ? 1_800_000
                    : 35_000,
                maxFramerate: publisherDownshifted
                  ? 3
                  : recoveryFull || offset < 24_000
                    ? 30
                    : 5,
                scaleResolutionDownBy: 1,
                scalabilityMode: "L1T1",
              },
            ]
          : [
              {
                rid: null,
                active: true,
                maxBitrate: publisherDownshifted
                  ? 160_000
                  : recoveryFull || offset < 24_000
                    ? 1_650_000
                    : 900_000,
                maxFramerate: publisherDownshifted
                  ? 12
                  : recoveryFull || offset < 24_000
                    ? 30
                    : 24,
                scaleResolutionDownBy: 1,
                scalabilityMode: "L2T1",
              },
            ],
    },
    codecIdentity: codecIdentity(
      codec === "vp9" ? "video/vp9" : "video/vp8",
    ),
    mediaPathAuthority: {
      version: 1,
      source: "fixed-publisher-sender-binding",
      matched: true,
      reasons: [],
      connectionId: "publisher-pc",
      senderId: "publisher-sender",
      trackId: "publisher-track",
      consumerId: null,
      producerId,
      rtpStatIds: ["publisher-outbound"],
      rtpSsrcs: ["1001"],
    },
    transportEvidence: {
      capturedAtEpochMs: WINDOW_STARTED_AT + offset,
    },
  };
  const primaryAtTop = recoveryFull || offset < 12_000;
  const primaryReceiver = {
    version: 1,
    ...endpointHintState("primaryReceiver", offset),
    connectionQuality: primaryDownshifted
      ? "poor"
      : recoveryGood || offset < 12_000
        ? "good"
        : "fair",
    spatialLayer: primaryAtTop ? 1 : 0,
    temporalLayer: 0,
    maximumSpatialLayer: 1,
    maximumTemporalLayer: 0,
    atTopLayer: primaryAtTop,
    mediaSurvived: true,
    adaptationUpdateInFlight: false,
    producerId,
    mediaPathAuthority: {
      version: 1,
      source: "fixed-receiver-media-path-binding",
      matched: true,
      reasons: [],
      connectionId: "primary-pc",
      senderId: null,
      trackId: null,
      consumerId: "primary-consumer",
      producerId,
      rtpStatIds: ["primary-inbound"],
      rtpSsrcs: ["2001"],
    },
    transportEvidence: {
      capturedAtEpochMs: WINDOW_STARTED_AT + offset,
    },
  };
  const controlAtTop = offset < 24_500 || recoveryFull;
  const controlReceiver = {
    version: 1,
    ...endpointHintState("controlReceiver", offset),
    connectionQuality: "good",
    spatialLayer: controlAtTop ? 1 : 0,
    temporalLayer: 0,
    maximumSpatialLayer: 1,
    maximumTemporalLayer: 0,
    atTopLayer: controlAtTop,
    mediaSurvived: true,
    adaptationUpdateInFlight: false,
    producerId,
    mediaPathAuthority: {
      version: 1,
      source: "fixed-receiver-media-path-binding",
      matched: true,
      reasons: [],
      connectionId: "control-pc",
      senderId: null,
      trackId: null,
      consumerId: "control-consumer",
      producerId,
      rtpStatIds: ["control-inbound"],
      rtpSsrcs: ["3001"],
    },
    transportEvidence: {
      capturedAtEpochMs: WINDOW_STARTED_AT + offset,
    },
  };
  return { publisher, primaryReceiver, controlReceiver };
};

const validHintLedgers = (plan, generationDelays = {}) => {
  const ledgers = Object.fromEntries(
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) => [
      endpoint,
      createDynamicNetworkHintLedger(endpoint, {
        measurementWindow: plan.measurementWindow,
        targetId: CDP_TARGET_IDS[endpoint],
        sessionId: CDP_SESSION_IDS[endpoint],
      }),
    ]),
  );
  for (const update of buildDynamicNetworkHintSchedule(plan)) {
    const delay =
      generationDelays[update.generation] ??
      (update.generation === 1 ? -100 : 0);
    const updatedAtOffsetMs = update.scheduledAtOffsetMs + delay;
    const observerId = `${update.endpoint}-adaptive-network-policy`;
    const advanced = advanceDynamicNetworkHintLedger(
      ledgers[update.endpoint],
      {
        generation: update.generation,
        state: update.state,
        scheduledAtOffsetMs: update.scheduledAtOffsetMs,
        updatedAtEpochMs:
          plan.measurementWindow.startedAtEpochMs + updatedAtOffsetMs,
        updatedAtOffsetMs,
      },
    );
    const receipt = runtimeHintReceipt(
      advanced,
      advanced.updates.at(-1),
      observerId,
      updatedAtOffsetMs,
    );
    ledgers[update.endpoint] = recordDynamicNetworkHintApplication(advanced, {
      generation: update.generation,
      observerId,
      runtimeReceipt: receipt,
    });
  }
  return ledgers;
};

const validCdpEvidence = (plan, stageDelays = {}) => {
  const schedule = buildDynamicNetworkCdpSchedule(plan, {
    targetIds: CDP_TARGET_IDS,
    sessionIds: CDP_SESSION_IDS,
  });
  return {
    version: 1,
    windowId: plan.measurementWindow.id,
    deprecatedFallbackAllowed: false,
    setup: schedule.setup.map((entry) => ({
      ...clone(entry),
      enabledAtEpochMs: plan.measurementWindow.startedAtEpochMs - 200,
      enabledAtOffsetMs: -200,
      succeeded: true,
    })),
    mutations: schedule.mutations.map((mutation) => {
      const delay =
        stageDelays[mutation.scheduledAtOffsetMs] ??
        (mutation.scheduledAtOffsetMs === 0 ? -100 : 0);
      const appliedAtOffsetMs = mutation.scheduledAtOffsetMs + delay;
      return {
        ...clone(mutation),
        appliedAtEpochMs:
          plan.measurementWindow.startedAtEpochMs + appliedAtOffsetMs,
        appliedAtOffsetMs,
        commands: mutation.commands.map((command) => ({
          ...clone(command),
          result:
            command.method === "Network.emulateNetworkConditionsByRule"
              ? {
                  ruleIds: command.params.matchedNetworkConditions.map(
                    (_, index) => `rule-${mutation.id}-${index}`,
                  ),
                }
              : {},
          succeeded: true,
        })),
      };
    }),
  };
};

const validSampler = (plan, codec) => ({
  version: 1,
  instanceId: "continuous-sampler-1",
  windowId: plan.measurementWindow.id,
  measurementWindow: plan.measurementWindow,
  startCount: 1,
  stopCount: 1,
  restartCount: 0,
  windowMutationCount: 0,
  startOffsetMs: 0,
  stopOffsetMs: DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
  checkpoints: buildDynamicNetworkCheckpointTargets(plan).map((target) => ({
    schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
    windowId: plan.measurementWindow.id,
    samplerInstanceId: "continuous-sampler-1",
    index: target.index,
    scheduledOffsetMs: target.scheduledOffsetMs,
    capturedOffsetMs: target.scheduledOffsetMs,
    endpointSnapshots: endpointSnapshotsAt(target.scheduledOffsetMs, codec),
  })),
});

const publisherAdaptationState = (checkpoint) => {
  const publisher = checkpoint.endpointSnapshots.publisher;
  return {
    producerId: publisher.producerId,
    publishQuality: publisher.publishQuality,
    networkProfile: publisher.networkProfile,
    networkProfileAuthority: publisher.networkProfileAuthority ?? null,
    producerTransportId: publisher.producerTransportId ?? null,
    producerTransportNetworkProfile:
      publisher.producerTransportNetworkProfile ?? null,
    producerTransportMaxIncomingBitrateBps:
      publisher.producerTransportMaxIncomingBitrateBps ?? null,
    captureWidth: publisher.captureWidth,
    captureHeight: publisher.captureHeight,
    captureFps: publisher.captureFps,
    encodedWidth: publisher.encodedWidth,
    encodedHeight: publisher.encodedHeight,
    encodedFps: publisher.encodedFps,
    fullLadder: publisher.fullLadder,
    senderEncodingConfiguration: publisher.senderEncodingConfiguration,
  };
};

const adaptationEventEvidence = (sampler, observedOffsetMs, direction) => {
  const observedIndex = sampler.checkpoints.findIndex(
    (checkpoint) => checkpoint.capturedOffsetMs === observedOffsetMs,
  );
  const previous = sampler.checkpoints[observedIndex - 1];
  const observed = sampler.checkpoints[observedIndex];
  return {
    version: 1,
    direction,
    previousCheckpointIndex: previous.index,
    observedCheckpointIndex: observed.index,
    startOffsetMs: previous.capturedOffsetMs,
    endOffsetMs: observed.capturedOffsetMs,
    fromSignature: publisherAdaptationState(previous),
    toSignature: publisherAdaptationState(observed),
    changed: true,
  };
};

const realizationSample = ({
  windowId,
  endpoint,
  phase,
  candidatePairId,
  counterStarts,
  rttMs,
  packetCount,
  lostPacketCount,
  bitrateBps,
  state,
}) => {
  const counterOffsets = {
    baseline: [500, 11_500],
    receiverLimited: [12_500, 23_500],
    publisherLimited: [24_500, 35_500],
    recovered: [91_500, 102_500],
  };
  const [sampleStartOffsetMs, sampleEndOffsetMs] = counterOffsets[phase];
  const sampleDurationMs = sampleEndOffsetMs - sampleStartOffsetMs;
  const { packetsStart, lostPacketsStart, bytesStart } = counterStarts;
  const byteCount = (bitrateBps * sampleDurationMs) / (8 * 1_000);
  assert.equal(Number.isInteger(byteCount), true);
  return {
    version: 1,
    windowId,
    endpoint,
    phase,
    transport: {
      version: 1,
      id: `transport-${endpoint}`,
      selectedCandidatePairId: candidatePairId,
      state: "connected",
    },
    candidatePair: {
      version: 1,
      id: candidatePairId,
      transportId: `transport-${endpoint}`,
      localCandidateId: `local-candidate-${endpoint}`,
      remoteCandidateId: `remote-candidate-${endpoint}`,
      selected: true,
      state: "succeeded",
    },
    localCandidate: {
      version: 1,
      id: `local-candidate-${endpoint}`,
      transportId: `transport-${endpoint}`,
      protocol: "udp",
      candidateType: "host",
    },
    remoteCandidate: {
      version: 1,
      id: `remote-candidate-${endpoint}`,
      transportId: `transport-${endpoint}`,
      protocol: "udp",
      candidateType: "host",
    },
    rttMs,
    packetsStart,
    packetsEnd: packetsStart + packetCount,
    lostPacketsStart,
    lostPacketsEnd: lostPacketsStart + lostPacketCount,
    bytesStart,
    bytesEnd: bytesStart + byteCount,
    sampleStartedAtEpochMs: WINDOW_STARTED_AT + sampleStartOffsetMs,
    sampleEndedAtEpochMs: WINDOW_STARTED_AT + sampleEndOffsetMs,
    sampleDurationMs,
    packetCount,
    lossRatio: lostPacketCount / packetCount,
    bitrateBps,
    state,
  };
};

const validNetworkRealization = (
  plan = buildDynamicNetworkTransitionPlan({
    windowId: WINDOW_ID,
    startedAtEpochMs: WINDOW_STARTED_AT,
  }),
  sampler = validSampler(plan, "vp9"),
) => {
  const windowId = plan.measurementWindow.id;
  const pairIds = {
    publisher: "udp-pair-publisher",
    primaryReceiver: "udp-pair-primary",
    controlReceiver: "udp-pair-control",
  };
  const sample = (endpoint, phase, values) =>
    realizationSample({
      windowId,
      endpoint,
      phase,
      candidatePairId: pairIds[endpoint],
      counterStarts:
        phase === "baseline"
          ? { packetsStart: 1_000, lostPacketsStart: 100, bytesStart: 10_000 }
          : phase === "receiverLimited"
            ? {
                packetsStart: 5_000,
                lostPacketsStart: 500,
                bytesStart: 5_000_000,
              }
            : phase === "publisherLimited"
              ? {
                  packetsStart: 10_000,
                  lostPacketsStart: 1_000,
                  bytesStart: 10_000_000,
                }
              : {
                  packetsStart: 15_000,
                  lostPacketsStart: 1_500,
                  bytesStart: 15_000_000,
                },
      ...values,
    });
  const phase = (
    name,
    { startOffsetMs, endOffsetMs, expectedCheckpointCount },
    samples,
  ) => {
    const counterOffsets = {
      baseline: [500, 11_500, 0],
      receiverLimited: [12_500, 23_500, 12_000],
      publisherLimited: [24_500, 35_500, 24_000],
      recovered: [91_500, 102_500, 91_000],
    };
    const [counterStartOffsetMs, counterEndOffsetMs, requiredAuthorityOffsetMs] =
      counterOffsets[name];
    const counterStartCheckpoint = sampler.checkpoints.find(
      (checkpoint) => checkpoint.scheduledOffsetMs === counterStartOffsetMs,
    );
    const counterEndCheckpoint = sampler.checkpoints.find(
      (checkpoint) => checkpoint.scheduledOffsetMs === counterEndOffsetMs,
    );
    const checkpointBindings = sampler.checkpoints
      .filter((checkpoint) =>
        name === "recovered"
          ? checkpoint.scheduledOffsetMs >= startOffsetMs &&
            checkpoint.scheduledOffsetMs <= endOffsetMs
          : checkpoint.scheduledOffsetMs >= startOffsetMs &&
            checkpoint.scheduledOffsetMs < endOffsetMs,
      )
      .map((checkpoint) => ({
        version: 1,
        windowId,
        samplerInstanceId: sampler.instanceId,
        checkpointId: `${windowId}:${sampler.instanceId}:${checkpoint.index}`,
        checkpointIndex: checkpoint.index,
        scheduledOffsetMs: checkpoint.scheduledOffsetMs,
        capturedOffsetMs: checkpoint.capturedOffsetMs,
      }));
    return {
      version: 1,
      windowId,
      phase: name,
      startOffsetMs,
      endOffsetMs,
      counterBaselineId: `${name}-counters`,
      counterResetDetected: false,
      requiredAuthorityOffsetMs,
      counterStartCheckpointId: `${windowId}:${sampler.instanceId}:${counterStartCheckpoint.index}`,
      counterEndCheckpointId: `${windowId}:${sampler.instanceId}:${counterEndCheckpoint.index}`,
      counterStartScheduledOffsetMs: counterStartOffsetMs,
      counterEndScheduledOffsetMs: counterEndOffsetMs,
      counterStartCapturedOffsetMs: counterStartCheckpoint.capturedOffsetMs,
      counterEndCapturedOffsetMs: counterEndCheckpoint.capturedOffsetMs,
      expectedCheckpointCount,
      checkpointCount: checkpointBindings.length,
      checkpointCoverageRatio:
        checkpointBindings.length / expectedCheckpointCount,
      checkpointBindings,
      ...samples,
    };
  };
  return {
    version: 2,
    windowId,
    samplerInstanceId: sampler.instanceId,
    baseline: phase(
      "baseline",
      { startOffsetMs: 0, endOffsetMs: 12_000, expectedCheckpointCount: 24 },
      {
        publisher: sample("publisher", "baseline", {
          rttMs: 20,
          packetCount: 1_000,
          lostPacketCount: 5,
          bitrateBps: 1_600_000,
          state: "high",
        }),
        primaryReceiver: sample("primaryReceiver", "baseline", {
          rttMs: 20,
          packetCount: 1_000,
          lostPacketCount: 5,
          bitrateBps: 1_500_000,
          state: "high",
        }),
        controlReceiver: sample("controlReceiver", "baseline", {
          rttMs: 20,
          packetCount: 1_000,
          lostPacketCount: 5,
          bitrateBps: 1_500_000,
          state: "high",
        }),
      },
    ),
    receiverLimited: phase(
      "receiverLimited",
      {
        startOffsetMs: 12_000,
        endOffsetMs: 24_000,
        expectedCheckpointCount: 24,
      },
      {
        publisher: sample("publisher", "receiverLimited", {
          rttMs: 0,
          packetCount: 1_000,
          lostPacketCount: 0,
          bitrateBps: 1_600_000,
          state: "high",
        }),
        primaryReceiver: sample("primaryReceiver", "receiverLimited", {
          rttMs: 0,
          packetCount: 250,
          lostPacketCount: 0,
          bitrateBps: 350_000,
          state: "low",
        }),
        controlReceiver: sample("controlReceiver", "receiverLimited", {
          rttMs: 0,
          packetCount: 1_000,
          lostPacketCount: 0,
          bitrateBps: 1_500_000,
          state: "high",
        }),
      },
    ),
    publisherLimited: phase(
      "publisherLimited",
      {
        startOffsetMs: 24_000,
        endOffsetMs: 36_000,
        expectedCheckpointCount: 24,
      },
      {
        publisher: sample("publisher", "publisherLimited", {
          rttMs: 0,
          packetCount: 200,
          lostPacketCount: 0,
          bitrateBps: 200_000,
          state: "low",
        }),
        primaryReceiver: sample("primaryReceiver", "publisherLimited", {
          rttMs: 0,
          packetCount: 200,
          lostPacketCount: 0,
          bitrateBps: 190_000,
          state: "low",
        }),
        controlReceiver: sample("controlReceiver", "publisherLimited", {
          rttMs: 0,
          packetCount: 200,
          lostPacketCount: 0,
          bitrateBps: 180_000,
          state: "source-limited",
        }),
      },
    ),
    recovered: phase(
      "recovered",
      {
        startOffsetMs: 91_000,
        endOffsetMs: 103_000,
        expectedCheckpointCount: 25,
      },
      {
        publisher: sample("publisher", "recovered", {
          rttMs: 25,
          packetCount: 1_000,
          lostPacketCount: 5,
          bitrateBps: 1_500_000,
          state: "high",
        }),
        primaryReceiver: sample("primaryReceiver", "recovered", {
          rttMs: 25,
          packetCount: 1_000,
          lostPacketCount: 5,
          bitrateBps: 1_500_000,
          state: "high",
        }),
        controlReceiver: sample("controlReceiver", "recovered", {
          rttMs: 25,
          packetCount: 1_000,
          lostPacketCount: 5,
          bitrateBps: 1_500_000,
          state: "high",
        }),
      },
    ),
  };
};

const validCodecEvidence = (plan, codec) => {
  const mimeType = codec === "vp9" ? "video/vp9" : "video/vp8";
  const identity = codecIdentity(mimeType);
  const base = {
    version: 1,
    windowId: plan.measurementWindow.id,
    phaseIdentities: {
      pristine: identity,
      poor: { ...identity },
      recovered: { ...identity },
    },
  };
  return {
    ...base,
    producerLineage: {
      version: 1,
      windowId: plan.measurementWindow.id,
      lineageId: "publisher-camera-lineage",
      pristineProducerId: "producer-stable",
      poorProducerId: "producer-stable",
      recoveredProducerId: "producer-stable",
      transitions: [],
    },
  };
};

const phaseMetricEvidence = (
  plan,
  sampler,
  phase,
  { startOffsetMs, endOffsetMs, primaryReceiver },
) => {
  const durationSeconds = (endOffsetMs - startOffsetMs) / 1_000;
  const presentationSampleCount = primaryReceiver.decodedFps * durationSeconds;
  assert.equal(Number.isInteger(presentationSampleCount), true);
  const sourceGeneration = phase === "pristine" ? 1 : 3;
  const sequenceBase = phase === "pristine" ? 0 : 10_000;
  const presentationSamples = Array.from(
    { length: presentationSampleCount },
    (_, index) => {
      const capturedAtOffsetMs =
        startOffsetMs +
        ((index + 0.5) * (endOffsetMs - startOffsetMs)) /
          presentationSampleCount;
      return {
        version: 1,
        id: `${plan.measurementWindow.id}:${phase}:presentation:${index}`,
        windowId: plan.measurementWindow.id,
        sourceMeasurementWindowId: plan.measurementWindow.id,
        endpoint: "primaryReceiver",
        targetId: CDP_TARGET_IDS.primaryReceiver,
        sessionId: CDP_SESSION_IDS.primaryReceiver,
        observerId: "primary-receiver-presentation-observer",
        timestampSource: "requestVideoFrameCallback",
        sourceGeneration,
        sourceSequence: sequenceBase + index,
        capturedAtOffsetMs,
        presentedAtEpochMs: WINDOW_STARTED_AT + capturedAtOffsetMs,
        captureToDisplayMs: primaryReceiver.captureToDisplayP95Ms,
      };
    },
  );
  const visualSampleCount = 24;
  const visualMetricSamples = Array.from(
    { length: visualSampleCount },
    (_, index) => {
      const presentationIndex = Math.min(
        presentationSamples.length - 1,
        Math.floor(
          ((index + 0.5) * presentationSamples.length) / visualSampleCount,
        ),
      );
      return {
        version: 1,
        id: `${plan.measurementWindow.id}:${phase}:visual:${index}`,
        windowId: plan.measurementWindow.id,
        sourceMeasurementWindowId: plan.measurementWindow.id,
        endpoint: "primaryReceiver",
        targetId: CDP_TARGET_IDS.primaryReceiver,
        sessionId: CDP_SESSION_IDS.primaryReceiver,
        observerId: "primary-receiver-visual-observer",
        metricSource: "dedicated-visual-worker",
        sourceGeneration,
        sourceSequence:
          presentationSamples[presentationIndex].sourceSequence,
        capturedAtOffsetMs:
          startOffsetMs +
          ((index + 0.5) * (endOffsetMs - startOffsetMs)) /
            visualSampleCount,
        visualScore: primaryReceiver.visualScore,
      };
    },
  );
  return {
    version: 1,
    windowId: plan.measurementWindow.id,
    phase,
    startOffsetMs,
    endOffsetMs,
    targetId: CDP_TARGET_IDS.primaryReceiver,
    sessionId: CDP_SESSION_IDS.primaryReceiver,
    metricImplementationVersion: 1,
    metricImplementation: "conclave-dynamic-video-quality-v1",
    measurementSource: "primary-receiver-rvfc-and-visual-worker",
    visualObserverId: "primary-receiver-visual-observer",
    presentationObserverId: "primary-receiver-presentation-observer",
    visualSampleIntervalMs: 450,
    samplerInstanceId: sampler.instanceId,
    checkpointBindings: sampler.checkpoints
      .filter((checkpoint) =>
        phase === "recovered"
          ? checkpoint.scheduledOffsetMs >= startOffsetMs &&
            checkpoint.scheduledOffsetMs <= endOffsetMs
          : checkpoint.scheduledOffsetMs >= startOffsetMs &&
            checkpoint.scheduledOffsetMs < endOffsetMs,
      )
      .map((checkpoint) => ({
        version: 1,
        windowId: plan.measurementWindow.id,
        samplerInstanceId: sampler.instanceId,
        checkpointIndex: checkpoint.index,
        scheduledOffsetMs: checkpoint.scheduledOffsetMs,
        capturedOffsetMs: checkpoint.capturedOffsetMs,
      })),
    visualMetricSamples,
    presentationSamples,
    primaryReceiver: {
      ...primaryReceiver,
      visualSampleCount: visualMetricSamples.length,
      decodedFrameCount: presentationSamples.length,
      latencySampleCount: presentationSamples.length,
    },
  };
};

const validSourceTimeline = (plan, phaseMetrics) => {
  const byGeneration = new Map();
  for (const phase of Object.values(phaseMetrics)) {
    for (const sample of phase.presentationSamples) {
      const frames = byGeneration.get(sample.sourceGeneration) ?? [];
      frames.push({
        sourceGeneration: sample.sourceGeneration,
        sourceSequence: sample.sourceSequence,
        availableAtEpochMs:
          sample.presentedAtEpochMs - sample.captureToDisplayMs,
      });
      byGeneration.set(sample.sourceGeneration, frames);
    }
  }
  return {
    version: 1,
    windowId: plan.measurementWindow.id,
    markerSequenceModulus: 65_536,
    resetAtEpochMs: plan.measurementWindow.startedAtEpochMs - 100,
    sources: Array.from(byGeneration, ([sourceGeneration, frames]) => ({
      version: 1,
      sourceGeneration,
      timestampMode: "performance-time-origin-before-request-frame",
      manualFrames: true,
      resetAtEpochMs: plan.measurementWindow.startedAtEpochMs - 100,
      requestFrameFailureCount: 0,
      frames,
    })),
  };
};

const validEvidence = (codec = "vp9") => {
  const plan = buildDynamicNetworkTransitionPlan({
    windowId: WINDOW_ID,
    startedAtEpochMs: WINDOW_STARTED_AT,
  });
  const sampler = validSampler(plan, codec);
  const phaseMetrics = {
    pristine: phaseMetricEvidence(plan, sampler, "pristine", {
      startOffsetMs: 0,
      endOffsetMs: 12_000,
      primaryReceiver: {
        visualScore: 90,
        decodedFps: 28,
        captureToDisplayP95Ms: 200,
      },
    }),
    recovered: phaseMetricEvidence(plan, sampler, "recovered", {
      startOffsetMs: 91_000,
      endOffsetMs: 103_000,
      primaryReceiver: {
        visualScore: 88.5,
        decodedFps: 26.5,
        captureToDisplayP95Ms: 245,
      },
    }),
  };
  const downEvent = adaptationEventEvidence(sampler, 24_500, "down");
  const recoveryEvent = adaptationEventEvidence(sampler, 88_000, "up");
  const downFrameOffsets =
    codec === "vp8" ? [23_900, 24_500] : [24_000, 24_500];
  const recoveryFrameOffsets =
    codec === "vp8"
      ? [87_500, 87_700, 87_800, 88_000]
      : [87_500, 87_680, 87_820, 88_000];
  return {
    schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
    controllerFailures: [],
    plan,
    topology: plan.topology,
    sampler,
    cdp: validCdpEvidence(plan),
    networkHints: validHintLedgers(plan),
    phaseMetrics,
    sourceTimeline: validSourceTimeline(plan, phaseMetrics),
    networkRealization: validNetworkRealization(plan, sampler),
    codec: validCodecEvidence(plan, codec),
    continuity: {
      version: 1,
      windowId: plan.measurementWindow.id,
      downshiftVisibleGapMs: codec === "vp8" ? 600 : 500,
      recoveryVisibleGapMs: codec === "vp8" ? 200 : 180,
      frameVisibility: {
        version: 1,
        windowId: plan.measurementWindow.id,
        downshift: {
          version: 1,
          windowId: plan.measurementWindow.id,
          endpoint: "primaryReceiver",
          targetId: CDP_TARGET_IDS.primaryReceiver,
          sessionId: CDP_SESSION_IDS.primaryReceiver,
          samplerInstanceId: sampler.instanceId,
          fromProducerId: "producer-stable",
          toProducerId: "producer-stable",
          adaptationEvent: downEvent,
          adaptationProofStartOffsetMs: 24_500,
          adaptationProofEndOffsetMs: 26_500,
          observerId: "primary-receiver-frame-visibility",
          timestampSource: "requestVideoFrameCallback",
          maximumObservationIntervalMs: 20,
          adaptationIntervalFrameOffsets: downFrameOffsets,
          visibleFrameCountWithinAdaptationInterval: downFrameOffsets.filter(
            (offset) =>
              offset >= downEvent.startOffsetMs &&
              offset <= downEvent.endOffsetMs,
          ).length,
          lastVisibleFrameAtOffsetMs: codec === "vp8" ? 23_900 : 24_000,
          firstVisibleFrameAtOffsetMs: 24_500,
          visibleGapMs: codec === "vp8" ? 600 : 500,
        },
        recovery: {
          version: 1,
          windowId: plan.measurementWindow.id,
          endpoint: "primaryReceiver",
          targetId: CDP_TARGET_IDS.primaryReceiver,
          sessionId: CDP_SESSION_IDS.primaryReceiver,
          samplerInstanceId: sampler.instanceId,
          fromProducerId: "producer-stable",
          toProducerId: "producer-stable",
          adaptationEvent: recoveryEvent,
          adaptationProofStartOffsetMs: 88_000,
          adaptationProofEndOffsetMs: 91_000,
          observerId: "primary-receiver-frame-visibility",
          timestampSource: "requestVideoFrameCallback",
          maximumObservationIntervalMs: 20,
          adaptationIntervalFrameOffsets: recoveryFrameOffsets,
          visibleFrameCountWithinAdaptationInterval:
            recoveryFrameOffsets.filter(
              (offset) =>
                offset >= recoveryEvent.startOffsetMs &&
                offset <= recoveryEvent.endOffsetMs,
            ).length,
          lastVisibleFrameAtOffsetMs: 87_500,
          firstVisibleFrameAtOffsetMs:
            codec === "vp8" ? 87_700 : 87_680,
          visibleGapMs: codec === "vp8" ? 200 : 180,
        },
      },
    },
  };
};

const updateCounterEvidence = (
  sample,
  { packetCount, lostPacketCount, bitrateBps },
) => {
  sample.packetsEnd = sample.packetsStart + packetCount;
  sample.lostPacketsEnd = sample.lostPacketsStart + lostPacketCount;
  sample.bytesEnd =
    sample.bytesStart + (bitrateBps * sample.sampleDurationMs) / (8 * 1_000);
  sample.packetCount = packetCount;
  sample.lossRatio = lostPacketCount / packetCount;
  sample.bitrateBps = bitrateBps;
};

const setDownshifted = (checkpoint, downshifted) => {
  const publisher = checkpoint.endpointSnapshots.publisher;
  const primary = checkpoint.endpointSnapshots.primaryReceiver;
  publisher.connectionQuality = downshifted ? "poor" : "fair";
  publisher.publishQuality = downshifted ? "low" : "medium";
  publisher.captureWidth = 1280;
  publisher.captureHeight = 720;
  publisher.captureFps = 30;
  publisher.encodedWidth = downshifted ? 284 : 640;
  publisher.encodedHeight = downshifted ? 160 : 360;
  publisher.encodedFps = downshifted ? 12 : 18;
  publisher.fullLadder = false;
  publisher.senderEncodingConfiguration.encodings[0].maxBitrate = downshifted
    ? 160_000
    : 900_000;
  publisher.senderEncodingConfiguration.encodings[0].maxFramerate = downshifted
    ? 12
    : 24;
  primary.connectionQuality = downshifted ? "poor" : "fair";
  primary.spatialLayer = downshifted ? 0 : 1;
  primary.temporalLayer = 0;
  primary.atTopLayer = false;
};

const setPhaseMetricValues = (
  evidence,
  phaseName,
  { visualScore, decodedFps, captureToDisplayP95Ms },
) => {
  const phaseEvidence = evidence.phaseMetrics[phaseName];
  const durationSeconds =
    (phaseEvidence.endOffsetMs - phaseEvidence.startOffsetMs) / 1_000;
  const decodedFrameCount = decodedFps * durationSeconds;
  assert.equal(Number.isInteger(decodedFrameCount), true);
  const existing = phaseEvidence.presentationSamples[0];
  phaseEvidence.presentationSamples = Array.from(
    { length: decodedFrameCount },
    (_, index) => ({
      ...existing,
      id: `${phaseEvidence.windowId}:${phaseEvidence.phase}:presentation:${index}`,
      sourceSequence:
        (phaseEvidence.phase === "pristine" ? 0 : 10_000) + index,
      capturedAtOffsetMs:
        phaseEvidence.startOffsetMs +
        ((index + 0.5) *
          (phaseEvidence.endOffsetMs - phaseEvidence.startOffsetMs)) /
          decodedFrameCount,
      presentedAtEpochMs:
        WINDOW_STARTED_AT +
        phaseEvidence.startOffsetMs +
        ((index + 0.5) *
          (phaseEvidence.endOffsetMs - phaseEvidence.startOffsetMs)) /
          decodedFrameCount,
      captureToDisplayMs: captureToDisplayP95Ms,
    }),
  );
  for (const [index, sample] of phaseEvidence.visualMetricSamples.entries()) {
    sample.visualScore = visualScore;
    const presentationIndex = Math.min(
      phaseEvidence.presentationSamples.length - 1,
      Math.floor(
        ((index + 0.5) * phaseEvidence.presentationSamples.length) /
          phaseEvidence.visualMetricSamples.length,
      ),
    );
    sample.sourceSequence =
      phaseEvidence.presentationSamples[presentationIndex].sourceSequence;
  }
  Object.assign(phaseEvidence.primaryReceiver, {
    visualScore,
    decodedFps,
    captureToDisplayP95Ms,
    visualSampleCount: phaseEvidence.visualMetricSamples.length,
    decodedFrameCount: phaseEvidence.presentationSamples.length,
    latencySampleCount: phaseEvidence.presentationSamples.length,
  });
  evidence.sourceTimeline = validSourceTimeline(
    evidence.plan,
    evidence.phaseMetrics,
  );
};

test("schema-13 plan is one frozen 103s immutable window", () => {
  const plan = buildDynamicNetworkTransitionPlan({
    windowId: WINDOW_ID,
    startedAtEpochMs: WINDOW_STARTED_AT,
  });
  assert.equal(plan.schemaVersion, 13);
  assert.equal(plan.measurementWindow.durationMs, 103_000);
  assert.equal(plan.measurementWindow.immutable, true);
  assert.equal(plan.sampler.mode, "one-continuous-immutable-window");
  assert.equal(buildDynamicNetworkCheckpointTargets(plan).length, 207);
  assert.equal(Object.isFrozen(plan.phasePlan), true);
  assert.deepEqual(plan.topology.endpoints, DYNAMIC_NETWORK_TRANSITION_ENDPOINTS);
});

test("CDP plan uses modern rule/override commands, exact poor profiles, and clears", () => {
  const plan = validEvidence().plan;
  const schedule = buildDynamicNetworkCdpSchedule(plan, {
    targetIds: CDP_TARGET_IDS,
    sessionIds: CDP_SESSION_IDS,
  });
  assert.equal(schedule.deprecatedFallbackAllowed, false);
  assert.equal(schedule.setup.length, 3);
  assert.equal(schedule.mutations.length, 12);
  assert.equal(new Set(schedule.setup.map((entry) => entry.targetId)).size, 3);
  assert.equal(new Set(schedule.setup.map((entry) => entry.sessionId)).size, 3);
  assert.equal(
    schedule.mutations.flatMap((mutation) => mutation.commands).some(
      (command) => command.method === "Network.emulateNetworkConditions",
    ),
    false,
  );
  const publisherPoor = schedule.mutations.find(
    (mutation) =>
      mutation.endpoint === "publisher" && mutation.state === "poor",
  );
  assert.deepEqual(publisherPoor.commands[0].params.matchedNetworkConditions, [
    {
      urlPattern: "",
      offline: false,
      latency: 140,
      downloadThroughput: 1_250_000,
      uploadThroughput: 27_500,
      connectionType: "cellular3g",
      packetLoss: 9,
      packetQueueLength: 16,
      packetReordering: true,
    },
  ]);
  const primaryPoor = schedule.mutations.find(
    (mutation) =>
      mutation.endpoint === "primaryReceiver" && mutation.state === "poor",
  );
  assert.equal(
    primaryPoor.commands[0].params.matchedNetworkConditions[0]
      .downloadThroughput,
    47_500,
  );
  assert.equal(
    primaryPoor.commands[0].params.matchedNetworkConditions[0]
      .uploadThroughput,
    125_000,
  );
  for (const clear of schedule.mutations.filter(
    (mutation) => mutation.state === "pristine",
  )) {
    assert.deepEqual(clear.commands[0].params.matchedNetworkConditions, []);
    assert.equal(clear.commands[1].params.downloadThroughput, -1);
    assert.equal(clear.commands[1].params.uploadThroughput, -1);
  }
});

test("CDP executor output is directly assessable and has no fallback path", async () => {
  const evidence = validEvidence();
  const schedule = buildDynamicNetworkCdpSchedule(evidence.plan, {
    targetIds: CDP_TARGET_IDS,
    sessionIds: CDP_SESSION_IDS,
  });
  const publisherClient = {
    targetId: CDP_TARGET_IDS.publisher,
    sessionId: CDP_SESSION_IDS.publisher,
    calls: [],
    async send(method, params) {
      this.calls.push({ method, params });
      if (method === "Network.emulateNetworkConditionsByRule") {
        return {
          ruleIds: params.matchedNetworkConditions.map(
            (_, index) => `runtime-rule-${index}`,
          ),
        };
      }
      return {};
    },
  };
  evidence.cdp.setup[0] = await enableDynamicNetworkCdp(publisherClient, {
    endpoint: "publisher",
    targetId: CDP_TARGET_IDS.publisher,
    sessionId: CDP_SESSION_IDS.publisher,
    measurementWindow: evidence.plan.measurementWindow,
    now: () => WINDOW_STARTED_AT - 200,
  });
  const publisherPoor = schedule.mutations.find(
    (mutation) =>
      mutation.endpoint === "publisher" && mutation.state === "poor",
  );
  const mutationIndex = evidence.cdp.mutations.findIndex(
    (mutation) => mutation.id === publisherPoor.id,
  );
  evidence.cdp.mutations[mutationIndex] =
    await applyDynamicNetworkCdpMutation(publisherClient, publisherPoor, {
      measurementWindow: evidence.plan.measurementWindow,
      now: () => WINDOW_STARTED_AT + 24_000,
    });
  const assessed = assessDynamicNetworkTransition(evidence);
  assert.equal(assessed.passed, true);
  assert.deepEqual(
    evidence.cdp.mutations[mutationIndex].commands[0].result.ruleIds,
    ["runtime-rule-0"],
  );
  assert.equal(
    assessed.cdpAuthority.ruleReceipts.some(
      (receipt) =>
        receipt.mutationId === publisherPoor.id &&
        receipt.ruleIds[0] === "runtime-rule-0",
    ),
    true,
  );
  assert.deepEqual(
    publisherClient.calls.map((call) => call.method),
    [
      "Network.enable",
      "Network.emulateNetworkConditionsByRule",
      "Network.overrideNetworkState",
    ],
  );

  const rejectingClient = {
    targetId: CDP_TARGET_IDS.publisher,
    sessionId: CDP_SESSION_IDS.publisher,
    async send(method) {
      if (method === "Network.overrideNetworkState") {
        throw new Error("unsupported");
      }
      return method === "Network.emulateNetworkConditionsByRule"
        ? { ruleIds: ["runtime-rule-0"] }
        : {};
    },
  };
  await assert.rejects(
    applyDynamicNetworkCdpMutation(rejectingClient, publisherPoor, {
      measurementWindow: evidence.plan.measurementWindow,
    }),
    /unsupported/,
  );
  await assert.rejects(
    applyDynamicNetworkCdpMutation(
      { async send() {} },
      publisherPoor,
      { measurementWindow: evidence.plan.measurementWindow },
    ),
    /target binding is required/,
  );
});

test("CDP rule installation requires exact returned rule-id receipts", () => {
  const missing = validEvidence();
  const poorMutation = missing.cdp.mutations.find(
    (mutation) =>
      mutation.endpoint === "publisher" && mutation.state === "poor",
  );
  delete poorMutation.commands[0].result;
  let result = assessDynamicNetworkTransition(missing);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /installed rule id/);

  const uncleared = validEvidence();
  const clearMutation = uncleared.cdp.mutations.find(
    (mutation) =>
      mutation.endpoint === "publisher" &&
      mutation.state === "pristine" &&
      mutation.scheduledAtOffsetMs === 36_000,
  );
  clearMutation.commands[0].result.ruleIds = ["stale-rule"];
  result = assessDynamicNetworkTransition(uncleared);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /0 installed rule id/);
});

test("duplicate or swapped CDP target/session bindings fail closed", () => {
  const duplicate = validEvidence();
  duplicate.cdp.setup[1].targetId = duplicate.cdp.setup[0].targetId;
  let result = assessDynamicNetworkTransition(duplicate);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /complete and unique/);

  const swapped = validEvidence();
  const publisherPoor = swapped.cdp.mutations.find(
    (mutation) =>
      mutation.endpoint === "publisher" && mutation.state === "poor",
  );
  publisherPoor.targetId = CDP_TARGET_IDS.primaryReceiver;
  publisherPoor.sessionId = CDP_SESSION_IDS.primaryReceiver;
  result = assessDynamicNetworkTransition(swapped);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /malformed or late/);
});

test("mutable hints require exact updates plus separate application observations", () => {
  const evidence = validEvidence();
  const publisher = evidence.networkHints.publisher;
  assert.equal(publisher.generation, 3);
  assert.equal(publisher.runtimeObservedChangeEventCount, 3);
  assert.equal(publisher.applicationObservations.length, 3);
  assert.deepEqual(
    publisher.updates.map((update) => [update.generation, update.state]),
    [
      [1, "pristine"],
      [2, "poor"],
      [3, "pristine"],
    ],
  );
  assert.throws(
    () =>
      advanceDynamicNetworkHintLedger(publisher, {
        generation: 5,
        state: "pristine",
        scheduledAtOffsetMs: 50_000,
        updatedAtEpochMs: WINDOW_STARTED_AT + 50_000,
        updatedAtOffsetMs: 50_000,
      }),
    /exactly one/,
  );
  const alteredLedger = clone(publisher);
  alteredLedger.updates[1].hint.downlinkMbps = 999;
  assert.throws(
    () =>
      advanceDynamicNetworkHintLedger(alteredLedger, {
        generation: 4,
        state: "pristine",
        scheduledAtOffsetMs: 36_000,
        updatedAtEpochMs: WINDOW_STARTED_AT + 36_000,
        updatedAtOffsetMs: 36_000,
      }),
    /altered update/,
  );

  const initialSchedule = buildDynamicNetworkHintSchedule(evidence.plan).find(
    (update) =>
      update.endpoint === "publisher" && update.generation === 1,
  );
  const initialLedger = advanceDynamicNetworkHintLedger(
    createDynamicNetworkHintLedger("publisher", {
      measurementWindow: evidence.plan.measurementWindow,
      targetId: CDP_TARGET_IDS.publisher,
      sessionId: CDP_SESSION_IDS.publisher,
    }),
    {
      generation: 1,
      state: initialSchedule.state,
      scheduledAtOffsetMs: initialSchedule.scheduledAtOffsetMs,
      updatedAtEpochMs: WINDOW_STARTED_AT - 100,
      updatedAtOffsetMs: -100,
    },
  );
  const invalidReceipt = runtimeHintReceipt(
    initialLedger,
    initialLedger.updates[0],
    "publisher-adaptive-network-policy",
    -50,
  );
  invalidReceipt.productObservation.browserNetwork.downlinkMbps = 999;
  assert.throws(
    () =>
      recordDynamicNetworkHintApplication(initialLedger, {
        generation: 1,
        observerId: "publisher-adaptive-network-policy",
        runtimeReceipt: invalidReceipt,
      }),
    /runtime receipt/,
  );
});

test("hint script builders require product-owned application consumption", () => {
  const plan = validEvidence().plan;
  const scheduled = buildDynamicNetworkHintSchedule(plan).find(
    (entry) => entry.endpoint === "publisher" && entry.generation === 1,
  );
  const update = validateDynamicNetworkHintUpdate({
    ...scheduled,
    targetId: CDP_TARGET_IDS.publisher,
    sessionId: CDP_SESSION_IDS.publisher,
    updateIndex: 0,
    updatedAtEpochMs: WINDOW_STARTED_AT - 100,
    updatedAtOffsetMs: -100,
  });
  const bootstrap = buildDynamicNetworkHintBootstrapScript({
    endpoint: "publisher",
    initialUpdate: update,
  });
  assert.match(bootstrap, /runtimeObservedChangeEventCount/);
  assert.match(bootstrap, /__conclaveGetMeetVideoDebug/);
  assert.match(bootstrap, /browserNetworkObservation/);
  assert.doesNotMatch(bootstrap, /__conclaveNetworkPolicyObservationLedger/);
  assert.doesNotMatch(bootstrap, /applicationObservations/);
  assert.match(buildDynamicNetworkHintUpdateExpression(update), /\.update\(/);
  assert.match(
    buildDynamicNetworkHintApplicationObservationExpression({
      observerId: "publisher-adaptive-network-policy",
    }),
    /observeProductDebug/,
  );

  const altered = clone(update);
  altered.hint.downlinkMbps = 999;
  assert.throws(
    () => buildDynamicNetworkHintUpdateExpression(altered),
    /altered/,
  );

  const missingAppObservation = clone(validEvidence());
  missingAppObservation.networkHints.publisher.applicationObservations.pop();
  const result = assessDynamicNetworkTransition(missingAppObservation);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /ledger is incomplete/);

  const replayed = clone(validEvidence());
  replayed.networkHints.publisher.windowId = "replayed-window";
  const replayResult = assessDynamicNetworkTransition(replayed);
  assert.equal(replayResult.valid, false);
  assert.match(replayResult.harnessFailures.join("\n"), /ledger is incomplete/);
});

test("authoritative VP9 pristine-poor-pristine transition passes", () => {
  const result = assessDynamicNetworkTransition(validEvidence("vp9"));
  assert.equal(result.version, DYNAMIC_NETWORK_TRANSITION_ASSESSMENT_VERSION);
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checkpointAuthority.coverageRatio, 1);
  assert.equal(result.transitionProofs.receiverIsolation.endOffsetMs, 16_000);
  assert.equal(result.transitionProofs.downshift.endOffsetMs, 26_500);
  assert.equal(result.transitionProofs.recoveryGood.endOffsetMs, 46_000);
  assert.equal(result.transitionProofs.recoveryFull.endOffsetMs, 91_000);
  assert.equal(result.codecContinuity.mimeType, "video/vp9");
});

test("continuous VP9 downshift is proven by exact sender caps without a raster change", () => {
  const evidence = validEvidence("vp9");
  const checkpoint = evidence.sampler.checkpoints.find(
    (candidate) => candidate.capturedOffsetMs === 24_500,
  );
  checkpoint.endpointSnapshots.publisher.encodedWidth = 1280;
  checkpoint.endpointSnapshots.publisher.encodedHeight = 720;

  assert.equal(dynamicNetworkDownshiftCheckpointPassed(checkpoint), true);

  checkpoint.endpointSnapshots.publisher.senderEncodingConfiguration.encodings[0].maxBitrate =
    900_000;
  assert.equal(dynamicNetworkDownshiftCheckpointPassed(checkpoint), false);
});

test("stable VP8 downshift accepts an SFU transport budget only with canonical sender parameters", () => {
  const evidence = validEvidence("vp8");
  const checkpoint = evidence.sampler.checkpoints.find(
    (candidate) => candidate.capturedOffsetMs === 24_500,
  );
  const publisher = checkpoint.endpointSnapshots.publisher;
  publisher.networkProfileAuthority = "producer-transport";
  publisher.producerTransportId = "publisher-transport";
  publisher.producerTransportNetworkProfile = "poor";
  publisher.producerTransportMaxIncomingBitrateBps = 180_000;
  publisher.senderEncodingConfiguration.encodings.forEach(
    (encoding, index) => {
      encoding.maxBitrate = [80_000, 220_000, 1_650_000][index];
      encoding.maxFramerate = [12, 20, 30][index];
    },
  );

  assert.equal(dynamicNetworkDownshiftCheckpointPassed(checkpoint), true);

  publisher.networkProfile = "emergency";
  publisher.producerTransportNetworkProfile = "emergency";
  publisher.producerTransportMaxIncomingBitrateBps = 160_000;
  assert.equal(dynamicNetworkDownshiftCheckpointPassed(checkpoint), true);

  publisher.producerTransportNetworkProfile = "poor";
  assert.equal(dynamicNetworkDownshiftCheckpointPassed(checkpoint), false);
  publisher.networkProfile = "poor";
  publisher.producerTransportNetworkProfile = "poor";
  publisher.producerTransportMaxIncomingBitrateBps = 180_000;

  publisher.senderEncodingConfiguration.encodings[1].maxBitrate = 200_000;
  assert.equal(dynamicNetworkDownshiftCheckpointPassed(checkpoint), false);
  publisher.senderEncodingConfiguration.encodings[1].maxBitrate = 220_000;
  publisher.producerTransportMaxIncomingBitrateBps = 180_001;
  assert.equal(dynamicNetworkDownshiftCheckpointPassed(checkpoint), false);
});

test("bounded receiver recovery proof accepts resumed media while aggregate loss history is stale", () => {
  const evidence = validEvidence("vp8");
  const checkpoint = evidence.sampler.checkpoints.find(
    (candidate) => candidate.capturedOffsetMs === 43_000,
  );

  for (const receiverName of ["primaryReceiver", "controlReceiver"]) {
    const receiver = checkpoint.endpointSnapshots[receiverName];
    receiver.connectionQuality = "fair";
    receiver.browserAllowsFairWebcamLayerRecovery = true;
    receiver.receiveRecoveryProbePhase = "active";
    receiver.receiveRecoveryProbeActive = true;
    receiver.consumerScoreQuality = "good";
    receiver.requestedSpatialLayer = 1;
    receiver.spatialLayer = 0;
    receiver.networkPolicyEvidence = {
      browserNetwork: { quality: "good", saveData: false },
    };
  }

  assert.equal(dynamicNetworkRecoveryGoodCheckpointPassed(checkpoint), true);

  checkpoint.endpointSnapshots.primaryReceiver.requestedSpatialLayer = 0;
  assert.equal(dynamicNetworkRecoveryGoodCheckpointPassed(checkpoint), false);
  checkpoint.endpointSnapshots.primaryReceiver.requestedSpatialLayer = 1;
  checkpoint.endpointSnapshots.primaryReceiver.consumerScoreQuality = "fair";
  assert.equal(dynamicNetworkRecoveryGoodCheckpointPassed(checkpoint), false);
});

test("VP9 source-track generations may change while the exact RTP path stays fixed", () => {
  const evidence = validEvidence("vp9");
  for (const checkpoint of evidence.sampler.checkpoints) {
    const publisher = checkpoint.endpointSnapshots.publisher;
    publisher.mediaPathAuthority.trackId =
      checkpoint.capturedOffsetMs >= 88_000
        ? "publisher-track-recovered"
        : checkpoint.capturedOffsetMs >= 24_500
          ? "publisher-track-poor"
          : "publisher-track-pristine";
  }

  const result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));
});

test("schema-13 accepts stable VP8 and rejects an in-window path replacement", () => {
  const stableResult = assessDynamicNetworkTransition(validEvidence("vp8"));
  assert.equal(stableResult.valid, true, stableResult.failures.join("\n"));
  assert.equal(stableResult.passed, true, stableResult.failures.join("\n"));

  const replaced = validEvidence("vp8");
  const checkpoint = replaced.sampler.checkpoints.find(
    (candidate) => candidate.capturedOffsetMs >= 24_500,
  );
  checkpoint.endpointSnapshots.publisher.producerId = "replacement-producer";
  checkpoint.endpointSnapshots.publisher.mediaPathAuthority.producerId =
    "replacement-producer";
  const result = assessDynamicNetworkTransition(replaced);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /fixed media-path identity changed/);
});

test("continuous sampler rejects gaps, restarts, low coverage, and duplicate captures", () => {
  const gapEvidence = validEvidence();
  gapEvidence.sampler.checkpoints.splice(1, 1);
  let authority = assessDynamicNetworkCheckpointAuthority({
    plan: gapEvidence.plan,
    sampler: gapEvidence.sampler,
  });
  assert.equal(authority.valid, false);
  assert.match(authority.failures.join("\n"), /1000ms/);

  const restarted = validEvidence();
  restarted.sampler.restartCount = 1;
  restarted.sampler.checkpoints = restarted.sampler.checkpoints.filter(
    (checkpoint) => checkpoint.index % 3 !== 0,
  );
  let result = assessDynamicNetworkTransition(restarted);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /coverage/);

  const duplicateCapture = validEvidence();
  duplicateCapture.sampler.checkpoints[1].capturedOffsetMs = 750;
  duplicateCapture.sampler.checkpoints[2].capturedOffsetMs = 750;
  authority = assessDynamicNetworkCheckpointAuthority({
    plan: duplicateCapture.plan,
    sampler: duplicateCapture.sampler,
  });
  assert.equal(authority.valid, false);
  assert.match(authority.failures.join("\n"), /order is not monotonic/);

  const mixed = validEvidence();
  mixed.sampler.checkpoints[10].windowId = "another-window";
  result = assessDynamicNetworkTransition(mixed);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /window\/sampler/);
});

test("phase coverage is scheduled-target based and never exceeds one under skew", () => {
  const evidence = validEvidence();
  evidence.sampler.checkpoints[47].capturedOffsetMs += 250;
  evidence.sampler.checkpoints[48].capturedOffsetMs += 250;
  evidence.sampler.checkpoints[71].capturedOffsetMs += 250;
  evidence.sampler.checkpoints[72].capturedOffsetMs += 250;
  const result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.phaseCoverage.poor.expectedCount, 24);
  assert.equal(result.phaseCoverage.poor.qualifyingCoverageRatio <= 1, true);
  assert.equal(result.phaseCoverage.recovered.qualifyingCoverageRatio <= 1, true);
});

test("stale hint generations cannot prove downshift or recovery milestones", () => {
  const down = validEvidence();
  for (const checkpoint of down.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 24_500 &&
      checkpoint.capturedOffsetMs <= 36_000
    ) {
      checkpoint.endpointSnapshots.publisher.hintGeneration = 1;
      checkpoint.endpointSnapshots.publisher.hintState = "pristine";
    }
  }
  let result = assessDynamicNetworkTransition(down);
  assert.equal(result.transitionProofs.downshift.passed, false);
  assert.match(result.productFailures.join("\n"), /downshift/);

  const recovery = validEvidence();
  for (const checkpoint of recovery.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 43_000 &&
      checkpoint.capturedOffsetMs <= 46_000
    ) {
      checkpoint.endpointSnapshots.publisher.hintGeneration = 2;
      checkpoint.endpointSnapshots.publisher.hintState = "poor";
    }
  }
  result = assessDynamicNetworkTransition(recovery);
  assert.equal(result.transitionProofs.recoveryGood.passed, false);
  assert.match(result.productFailures.join("\n"), /good recovery/);
});

test("milestone proof starts after acknowledged CDP and app-observed hint authority", () => {
  const evidence = validEvidence();
  evidence.cdp = validCdpEvidence(evidence.plan, { 24_000: 750 });
  evidence.networkHints = validHintLedgers(evidence.plan, { 2: 750 });
  for (const checkpoint of evidence.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 24_000 &&
      checkpoint.capturedOffsetMs < 36_000
    ) {
      setDownshifted(
        checkpoint,
        checkpoint.capturedOffsetMs >= 24_000 &&
          checkpoint.capturedOffsetMs <= 26_000,
      );
    }
  }
  const result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.cdpAuthority.applyAtOffsetMs, 24_750);
  assert.equal(result.hintAuthority.applyAtOffsetMs, 24_750);
  assert.equal(result.transitionProofs.downshift.authorityAtOffsetMs, 24_750);
  assert.equal(result.transitionProofs.downshift.passed, false);
});

test("frame visibility binds to the adaptation event interval, not proof start", () => {
  const evidence = validEvidence();
  for (const checkpoint of evidence.sampler.checkpoints) {
    if (checkpoint.capturedOffsetMs === 24_500) {
      // The capture/topology signature can complete one sample before the
      // connection-quality label catches up. Event timing is bound to the
      // observable media transition, not that lagging diagnostic label.
      checkpoint.endpointSnapshots.publisher.connectionQuality = "good";
      const primary = checkpoint.endpointSnapshots.primaryReceiver;
      primary.connectionQuality = "fair";
      primary.spatialLayer = 1;
      primary.atTopLayer = false;
    }
  }
  const visibility = evidence.continuity.frameVisibility.downshift;
  visibility.adaptationProofStartOffsetMs = 25_000;
  visibility.adaptationProofEndOffsetMs = 27_000;

  const result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));
  assert.equal(result.transitionProofs.downshift.startOffsetMs, 25_000);
  assert.equal(visibility.adaptationEvent.endOffsetMs, 24_500);
});

test("poor-phase coverage follows applied media state, not lagging quality labels", () => {
  const evidence = validEvidence();
  for (const checkpoint of evidence.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 24_500 &&
      checkpoint.capturedOffsetMs < 36_000
    ) {
      checkpoint.endpointSnapshots.publisher.connectionQuality = "good";
      checkpoint.endpointSnapshots.controlReceiver.connectionQuality = "fair";
    }
  }
  let result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.passed, true, result.failures.join("\n"));
  assert.equal(result.phaseCoverage.poor.qualifyingCoverageRatio >= 0.9, true);

  for (const checkpoint of evidence.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 24_000 &&
      checkpoint.capturedOffsetMs < 36_000
    ) {
      checkpoint.endpointSnapshots.controlReceiver.mediaSurvived = false;
    }
  }
  result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /poor 12s phase/);
});

test("modern CDP fallback use or missing explicit clear invalidates authority", () => {
  const deprecated = validEvidence();
  deprecated.cdp.mutations[3].commands[0].method =
    "Network.emulateNetworkConditions";
  let result = assessDynamicNetworkTransition(deprecated);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /deprecated/);

  const uncleared = validEvidence();
  uncleared.cdp.mutations = uncleared.cdp.mutations.filter(
    (mutation) =>
      !(
        mutation.endpoint === "publisher" &&
        mutation.scheduledAtOffsetMs === 36_000
      ),
  );
  result = assessDynamicNetworkTransition(uncleared);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /mutation coverage/);
});

test("initial clears and hints must be authoritative before the pristine window", () => {
  const late = clone(validEvidence());
  late.cdp.setup[0].enabledAtOffsetMs = 0;
  late.cdp.setup[0].enabledAtEpochMs = WINDOW_STARTED_AT;
  const initialPublisher = late.cdp.mutations.find(
    (mutation) =>
      mutation.endpoint === "publisher" &&
      mutation.scheduledAtOffsetMs === 0,
  );
  initialPublisher.appliedAtOffsetMs = 0;
  initialPublisher.appliedAtEpochMs = WINDOW_STARTED_AT;
  const publisherHints = late.networkHints.publisher;
  publisherHints.updates[0].updatedAtOffsetMs = 0;
  publisherHints.updates[0].updatedAtEpochMs = WINDOW_STARTED_AT;
  publisherHints.applicationObservations[0].observedAtOffsetMs = 0;
  publisherHints.applicationObservations[0].observedAtEpochMs =
    WINDOW_STARTED_AT;

  const result = assessDynamicNetworkTransition(late);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /CDP setup|CDP mutation/);
  assert.match(result.harnessFailures.join("\n"), /network hint update/);
});

test("realized impairment without media downshift is a product failure", () => {
  const evidence = validEvidence();
  for (const checkpoint of evidence.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 12_000 &&
      checkpoint.capturedOffsetMs < 36_000
    ) {
      setDownshifted(checkpoint, false);
    }
  }
  const result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /downshift/);
  assert.match(result.productFailures.join("\n"), /poor 12s phase/);
});

test("good/full recovery and recovered visual quality are independent gates", () => {
  const late = validEvidence();
  for (const checkpoint of late.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 43_000 &&
      checkpoint.capturedOffsetMs < 47_000
    ) {
      checkpoint.endpointSnapshots.publisher.connectionQuality = "fair";
      checkpoint.endpointSnapshots.primaryReceiver.connectionQuality = "fair";
    }
    if (
      checkpoint.capturedOffsetMs >= 88_000 &&
      checkpoint.capturedOffsetMs < 92_000
    ) {
      checkpoint.endpointSnapshots.publisher.fullLadder = false;
      checkpoint.endpointSnapshots.primaryReceiver.atTopLayer = false;
    }
  }
  let result = assessDynamicNetworkTransition(late);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /good recovery/);
  assert.match(result.productFailures.join("\n"), /full-ladder/);

  const regressed = validEvidence();
  setPhaseMetricValues(regressed, "recovered", {
    visualScore: 87.9,
    decodedFps: 25.5,
    captureToDisplayP95Ms: 251,
  });
  result = assessDynamicNetworkTransition(regressed);
  assert.match(result.productFailures.join("\n"), /visual score/);
  assert.match(result.productFailures.join("\n"), /decoded FPS/);
  assert.match(result.productFailures.join("\n"), /capture-to-display/);
});

test("top-layer gates require the authoritative multi-spatial-layer ladder", () => {
  const evidence = validEvidence();
  for (const checkpoint of evidence.sampler.checkpoints) {
    const control = checkpoint.endpointSnapshots.controlReceiver;
    control.spatialLayer = 0;
    control.maximumSpatialLayer = 0;
    control.atTopLayer = true;
  }
  const result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /pristine control|recovery/);
});

test("phase metrics reject bad-equals-bad and malformed negative values", () => {
  const badEqualsBad = validEvidence();
  for (const phase of ["pristine", "recovered"]) {
    setPhaseMetricValues(badEqualsBad, phase, {
      visualScore: 10,
      decodedFps: 10,
      captureToDisplayP95Ms: 1_000,
    });
  }
  let result = assessDynamicNetworkTransition(badEqualsBad);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /below 88/);
  assert.match(result.productFailures.join("\n"), /below 24/);
  assert.match(result.productFailures.join("\n"), /exceeds 250ms/);

  const negative = validEvidence();
  negative.phaseMetrics.pristine.primaryReceiver.visualScore = -1;
  result = assessDynamicNetworkTransition(negative);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /visual baseline is missing/);

  const staleProvenance = validEvidence();
  staleProvenance.phaseMetrics.recovered.checkpointBindings[0].checkpointIndex =
    -1;
  result = assessDynamicNetworkTransition(staleProvenance);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /checkpoint provenance/);

  const inconsistentAggregate = validEvidence();
  inconsistentAggregate.phaseMetrics.pristine.primaryReceiver.decodedFps = 27;
  result = assessDynamicNetworkTransition(inconsistentAggregate);
  assert.equal(result.valid, false);
  assert.match(
    result.harnessFailures.join("\n"),
    /not derived from separate raw visual and rVFC samples/,
  );

  const clusteredCallbacks = validEvidence();
  for (const [index, sample] of
    clusteredCallbacks.phaseMetrics.pristine.presentationSamples.entries()) {
    sample.capturedAtOffsetMs = index + 1;
    sample.presentedAtEpochMs = WINDOW_STARTED_AT + index + 1;
  }
  result = assessDynamicNetworkTransition(clusteredCallbacks);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /temporal coverage/);
});

test("source generations and visual/rVFC observers remain independent", () => {
  const staleGeneration = validEvidence();
  staleGeneration.phaseMetrics.recovered.presentationSamples[0].sourceGeneration =
    99;
  let result = assessDynamicNetworkTransition(staleGeneration);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /presentation sample/);

  const clonedCadence = validEvidence();
  const template = clonedCadence.phaseMetrics.pristine.visualMetricSamples[0];
  clonedCadence.phaseMetrics.pristine.visualMetricSamples =
    clonedCadence.phaseMetrics.pristine.presentationSamples.map(
      (presentation, index) => ({
        ...template,
        id: `${template.windowId}:cloned-visual:${index}`,
        sourceGeneration: presentation.sourceGeneration,
        sourceSequence: presentation.sourceSequence,
        capturedAtOffsetMs: presentation.capturedAtOffsetMs,
      }),
    );
  clonedCadence.phaseMetrics.pristine.primaryReceiver.visualSampleCount =
    clonedCadence.phaseMetrics.pristine.visualMetricSamples.length;
  result = assessDynamicNetworkTransition(clonedCadence);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /independent sparse cadence/);
});

test("controller failures and receiver-isolation counterfactual fail independently", () => {
  const missingLedger = validEvidence();
  delete missingLedger.controllerFailures;
  let result = assessDynamicNetworkTransition(missingLedger);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /controller failure ledger/);

  const controllerFailure = validEvidence();
  controllerFailure.controllerFailures.push("timer callback failed");
  result = assessDynamicNetworkTransition(controllerFailure);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /timer callback failed/);

  const confounded = validEvidence();
  for (const checkpoint of confounded.sampler.checkpoints) {
    if (
      checkpoint.capturedOffsetMs >= 12_000 &&
      checkpoint.capturedOffsetMs < 24_000
    ) {
      setDownshifted(checkpoint, true);
    }
  }
  result = assessDynamicNetworkTransition(confounded);
  assert.equal(result.transitionProofs.receiverIsolation.passed, false);
  assert.match(result.productFailures.join("\n"), /while publisher\/control remained pristine/);
});

test("UDP realization is derived from selected candidate-pair counters", () => {
  const evidence = validEvidence();
  let result = assessDynamicNetworkRealization(evidence.networkRealization, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.derived.publisherLimited.publisher.packetCount, 200);
  assert.equal(result.derived.publisherLimited.publisher.lostPacketCount, 0);
  assert.equal(
    result.diagnostics.rtcRttAndLossCountersAreAuthoritativeForCdpShaping,
    false,
  );
  assert.equal(
    result.diagnostics.publisherOutboundRtpBytesRepresentAttemptedPreNetworkTraffic,
    true,
  );

  const connectivityCheck = clone(evidence.networkRealization);
  connectivityCheck.recovered.publisher.candidatePair.state = "in-progress";
  result = assessDynamicNetworkRealization(connectivityCheck, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));

  const failedPair = clone(evidence.networkRealization);
  failedPair.recovered.publisher.candidatePair.state = "failed";
  result = assessDynamicNetworkRealization(failedPair, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /candidate-pair counters/);

  const tcp = clone(evidence.networkRealization);
  tcp.publisherLimited.publisher.localCandidate.protocol = "tcp";
  const invalid = assessDynamicNetworkRealization(tcp, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.harnessFailures.join("\n"), /candidate-pair counters/);

  const unboundSelection = clone(evidence.networkRealization);
  unboundSelection.publisherLimited.publisher.transport.selectedCandidatePairId =
    "other";
  const unbound = assessDynamicNetworkRealization(unboundSelection, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(unbound.valid, false);
  assert.match(unbound.harnessFailures.join("\n"), /candidate-pair counters/);
});

test("UDP counter baselines move strictly after acknowledged mutation authority", () => {
  const evidence = validEvidence();
  evidence.cdp = validCdpEvidence(evidence.plan, { 24_000: 500 });
  evidence.networkHints = validHintLedgers(evidence.plan);

  let result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.valid, false);
  assert.match(
    result.harnessFailures.join("\n"),
    /publisherLimited UDP realization phase\/counter authority is malformed/,
  );

  const stage = evidence.networkRealization.publisherLimited;
  const startCheckpoint = evidence.sampler.checkpoints.find(
    (checkpoint) => checkpoint.scheduledOffsetMs === 25_000,
  );
  stage.requiredAuthorityOffsetMs = 24_500;
  stage.counterStartCheckpointId = `${evidence.plan.measurementWindow.id}:${evidence.sampler.instanceId}:${startCheckpoint.index}`;
  stage.counterStartScheduledOffsetMs = 25_000;
  stage.counterStartCapturedOffsetMs = 25_000;
  for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
    const sample = stage[endpoint];
    const lostPacketCount = sample.lostPacketsEnd - sample.lostPacketsStart;
    sample.sampleStartedAtEpochMs = WINDOW_STARTED_AT + 25_000;
    sample.sampleDurationMs =
      sample.sampleEndedAtEpochMs - sample.sampleStartedAtEpochMs;
    updateCounterEvidence(sample, {
      packetCount: sample.packetCount,
      lostPacketCount,
      bitrateBps: sample.bitrateBps,
    });
  }

  result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));
});

test("throughput shaping requires useful packets, configured ceilings, and source fanout", () => {
  const evidence = validEvidence();
  const weak = clone(evidence.networkRealization);
  weak.publisherLimited.publisher.rttMs = 10_000;
  updateCounterEvidence(weak.publisherLimited.publisher, {
    packetCount: 49,
    lostPacketCount: 0,
    bitrateBps: 200_000,
  });
  updateCounterEvidence(weak.receiverLimited.primaryReceiver, {
    packetCount: 200,
    lostPacketCount: 0,
    bitrateBps: 500_000,
  });
  updateCounterEvidence(weak.publisherLimited.primaryReceiver, {
    packetCount: 200,
    lostPacketCount: 0,
    bitrateBps: 500_000,
  });
  const result = assessDynamicNetworkRealization(weak, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
  assert.match(result.harnessFailures.join("\n"), /packet count/);
  assert.match(result.harnessFailures.join("\n"), /configured-ceiling/);
  assert.match(result.harnessFailures.join("\n"), /receiver-fanout/);
  assert.doesNotMatch(result.harnessFailures.join("\n"), /RTT|loss/);
});

test("publisher shaping uses delivered receiver bytes, not pre-network sender attempts", () => {
  const evidence = validEvidence();
  updateCounterEvidence(evidence.networkRealization.publisherLimited.publisher, {
    packetCount: 700,
    lostPacketCount: 0,
    bitrateBps: 700_000,
  });
  updateCounterEvidence(
    evidence.networkRealization.publisherLimited.primaryReceiver,
    {
      packetCount: 200,
      lostPacketCount: 0,
      bitrateBps: 127_000,
    },
  );
  updateCounterEvidence(
    evidence.networkRealization.publisherLimited.controlReceiver,
    {
      packetCount: 200,
      lostPacketCount: 0,
      bitrateBps: 113_000,
    },
  );

  const result = assessDynamicNetworkRealization(evidence.networkRealization, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));
});

test("healthy and receiver-isolation stages require useful measured throughput", () => {
  const evidence = validEvidence();
  const unhealthy = clone(evidence.networkRealization);
  unhealthy.recovered.publisher.rttMs = 10_000;
  updateCounterEvidence(unhealthy.recovered.primaryReceiver, {
    packetCount: 1,
    lostPacketCount: 0,
    bitrateBps: 1_500_000,
  });
  updateCounterEvidence(unhealthy.recovered.controlReceiver, {
    packetCount: 1_000,
    lostPacketCount: 0,
    bitrateBps: 1_000_000,
  });
  updateCounterEvidence(unhealthy.receiverLimited.controlReceiver, {
    packetCount: 1,
    lostPacketCount: 0,
    bitrateBps: 900_000,
  });
  const result = assessDynamicNetworkRealization(unhealthy, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /packet count 1/);
  assert.match(result.harnessFailures.join("\n"), /not above 1Mbps/);
  assert.doesNotMatch(result.harnessFailures.join("\n"), /RTT|loss/);
});

test("counter reset and derived-value mismatches fail while endpoint-scoped RTC IDs may collide", () => {
  const evidence = validEvidence();
  const reset = clone(evidence.networkRealization);
  reset.publisherLimited.counterResetDetected = true;
  let result = assessDynamicNetworkRealization(reset, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /counter authority/);

  const mismatch = clone(evidence.networkRealization);
  mismatch.publisherLimited.publisher.lossRatio = 0.9;
  result = assessDynamicNetworkRealization(mismatch, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /inconsistent/);

  const endpointScopedCollisions = clone(evidence.networkRealization);
  for (const phase of [
    "baseline",
    "receiverLimited",
    "publisherLimited",
    "recovered",
  ]) {
    const publisher = endpointScopedCollisions[phase].publisher;
    for (const endpoint of ["primaryReceiver", "controlReceiver"]) {
      const sample = endpointScopedCollisions[phase][endpoint];
      sample.transport.id = publisher.transport.id;
      sample.transport.selectedCandidatePairId =
        publisher.transport.selectedCandidatePairId;
      sample.candidatePair.id = publisher.candidatePair.id;
      sample.candidatePair.transportId = publisher.candidatePair.transportId;
      sample.candidatePair.localCandidateId =
        publisher.candidatePair.localCandidateId;
      sample.candidatePair.remoteCandidateId =
        publisher.candidatePair.remoteCandidateId;
      sample.localCandidate.id = publisher.localCandidate.id;
      sample.localCandidate.transportId = publisher.localCandidate.transportId;
      sample.remoteCandidate.id = publisher.remoteCandidate.id;
      sample.remoteCandidate.transportId =
        publisher.remoteCandidate.transportId;
    }
  }
  result = assessDynamicNetworkRealization(endpointScopedCollisions, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));

  const rewound = clone(evidence.networkRealization);
  rewound.publisherLimited.publisher.packetsStart =
    rewound.receiverLimited.publisher.packetsEnd - 1;
  rewound.publisherLimited.publisher.packetsEnd =
    rewound.publisherLimited.publisher.packetsStart +
    rewound.publisherLimited.publisher.packetCount;
  result = assessDynamicNetworkRealization(rewound, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /reset or rewound/);

  const staleCheckpoint = clone(evidence.networkRealization);
  staleCheckpoint.publisherLimited.checkpointBindings[0].checkpointId =
    "stale";
  result = assessDynamicNetworkRealization(staleCheckpoint, {
    plan: evidence.plan,
    checkpoints: evidence.sampler.checkpoints,
  });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /checkpoint binding/);
});

test("top-level transition is invalid when network realization is weak", () => {
  const evidence = validEvidence();
  updateCounterEvidence(evidence.networkRealization.publisherLimited.controlReceiver, {
    packetCount: 200,
    lostPacketCount: 0,
    bitrateBps: 400_000,
  });
  const result = assessDynamicNetworkTransition(evidence);
  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
  assert.match(
    result.harnessFailures.join("\n"),
    /network realization.*configured-ceiling/,
  );
});

test("codec policy rejects identity drift and non-profile-0 L2T1 VP9", () => {
  const metadataUnavailable = validEvidence("vp9");
  for (const phase of ["pristine", "poor", "recovered"]) {
    metadataUnavailable.codec.phaseIdentities[phase].implementation = null;
    metadataUnavailable.codec.phaseIdentities[phase].powerEfficient = null;
  }
  let result = assessDynamicNetworkTransition(metadataUnavailable);
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));

  const partialMetadata = validEvidence("vp9");
  partialMetadata.codec.phaseIdentities.poor.implementation = null;
  result = assessDynamicNetworkTransition(partialMetadata);
  assert.equal(result.valid, false);
  assert.match(
    result.harnessFailures.join("\n"),
    /codec identity evidence is missing or malformed/,
  );

  const drift = validEvidence("vp9");
  drift.codec.phaseIdentities.recovered.implementation = "other-encoder";
  result = assessDynamicNetworkTransition(drift);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /identity changed/);

  const wrongMode = validEvidence("vp9");
  for (const phase of ["pristine", "poor", "recovered"]) {
    wrongMode.codec.phaseIdentities[phase].scalabilityMode = "L3T3_KEY";
  }
  result = assessDynamicNetworkTransition(wrongMode);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /continuous L2T1 ladder/);
});

test("VP8 accepts stable numeric bitrate hints and rejects unrelated fmtp", () => {
  const bitrateHint = validEvidence("vp8");
  for (const phase of ["pristine", "poor", "recovered"]) {
    bitrateHint.codec.phaseIdentities[phase].fmtp =
      "x-google-start-bitrate=1800";
  }
  let result = assessDynamicNetworkTransition(bitrateHint);
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, true, result.failures.join("\n"));

  const unrelatedFmtp = validEvidence("vp8");
  for (const phase of ["pristine", "poor", "recovered"]) {
    unrelatedFmtp.codec.phaseIdentities[phase].fmtp = "profile-id=2";
  }
  result = assessDynamicNetworkTransition(unrelatedFmtp);
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /VP8 L1T1/);
});

test("codec lineage is window-bound and attached to every checkpoint producer ID", () => {
  const detached = validEvidence("vp9");
  detached.sampler.checkpoints[100].endpointSnapshots.primaryReceiver.producerId =
    "unrelated-producer";
  let result = assessDynamicNetworkTransition(detached);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /fixed media-path authority/);

  const stale = validEvidence("vp9");
  stale.continuity.windowId = "stale-window";
  result = assessDynamicNetworkTransition(stale);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /visible-gap.*stale/);

  const fabricatedGap = validEvidence("vp9");
  fabricatedGap.continuity.frameVisibility.recovery.visibleGapMs = 1;
  result = assessDynamicNetworkTransition(fabricatedGap);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /high-resolution frame timestamps/);

  const detachedGap = validEvidence("vp8");
  detachedGap.continuity.frameVisibility.downshift.adaptationEvent.endOffsetMs =
    21_800;
  result = assessDynamicNetworkTransition(detachedGap);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /not causally bound/);

  const detachedVp9Proof = validEvidence("vp9");
  detachedVp9Proof.continuity.frameVisibility.downshift.adaptationProofStartOffsetMs =
    21_800;
  result = assessDynamicNetworkTransition(detachedVp9Proof);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /not causally bound/);
});

test("VP8 rejects producer transitions and excessive visible gaps", () => {
  const replacement = validEvidence("vp8");
  replacement.codec.producerLineage.transitions.push({
    version: 1,
    windowId: replacement.plan.measurementWindow.id,
    direction: "down",
    lineageId: replacement.codec.producerLineage.lineageId,
    fromProducerId: "producer-stable",
    toProducerId: "replacement-producer",
    atOffsetMs: 24_500,
  });
  let result = assessDynamicNetworkTransition(replacement);
  assert.equal(result.valid, false);
  assert.match(result.failures.join("\n"), /transition window evidence is malformed/);

  const gap = validEvidence("vp8");
  gap.continuity.downshiftVisibleGapMs = 701;
  gap.continuity.frameVisibility.downshift.lastVisibleFrameAtOffsetMs = 23_799;
  gap.continuity.frameVisibility.downshift.adaptationIntervalFrameOffsets = [
    23_799,
    24_500,
  ];
  gap.continuity.frameVisibility.downshift.visibleFrameCountWithinAdaptationInterval =
    1;
  gap.continuity.frameVisibility.downshift.visibleGapMs = 701;
  result = assessDynamicNetworkTransition(gap);
  assert.equal(result.valid, true, result.harnessFailures.join("\n"));
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /visible gap 701ms/);
});

test("sustained proof resets on failed checkpoints and evidence gaps", () => {
  const checkpoints = [
    { capturedOffsetMs: 0, ok: true },
    { capturedOffsetMs: 500, ok: true },
    { capturedOffsetMs: 1_000, ok: false },
    { capturedOffsetMs: 1_500, ok: true },
    { capturedOffsetMs: 2_000, ok: true },
    { capturedOffsetMs: 2_500, ok: true },
  ];
  const proof = findSustainedCheckpointProof(
    checkpoints,
    (checkpoint) => checkpoint.ok,
    {
      notBeforeOffsetMs: 0,
      deadlineOffsetMs: 3_000,
      requiredSustainedMs: 1_000,
    },
  );
  assert.equal(proof.passed, true);
  assert.equal(proof.startOffsetMs, 1_500);
  assert.equal(proof.endOffsetMs, 2_500);
});

test("milestone deadlines preserve the full budget after acknowledged authority", () => {
  assert.equal(
    resolveAuthorityRelativeDeadline({
      authorityAtOffsetMs: 36_019,
      scheduledAtOffsetMs: 36_000,
      plannedDeadlineOffsetMs: 46_000,
    }),
    46_019,
  );
  assert.throws(
    () =>
      resolveAuthorityRelativeDeadline({
        authorityAtOffsetMs: 35_999,
        scheduledAtOffsetMs: 36_000,
        plannedDeadlineOffsetMs: 46_000,
      }),
    /invalid/,
  );
});

test("assessment is deterministic, non-mutating, and uses consistent envelopes", () => {
  const evidence = validEvidence();
  const before = JSON.stringify(evidence);
  const first = assessDynamicNetworkTransition(evidence);
  const second = assessDynamicNetworkTransition(evidence);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(evidence), before);
  assert.equal(first.valid, first.harnessFailures.length === 0);
  assert.equal(first.passed, first.valid && first.productFailures.length === 0);
  assert.deepEqual(first.failures, [
    ...first.harnessFailures,
    ...first.productFailures,
  ]);
  for (const nested of [
    first.checkpointAuthority,
    first.cdpAuthority,
    first.hintAuthority,
    first.phaseMetrics,
    first.networkRealization,
    first.codecContinuity,
  ]) {
    assert.equal(nested.version, DYNAMIC_NETWORK_TRANSITION_ASSESSMENT_VERSION);
    assert.equal(nested.valid, nested.harnessFailures.length === 0);
    assert.equal(
      nested.passed,
      nested.valid && nested.productFailures.length === 0,
    );
    assert.deepEqual(nested.failures, [
      ...nested.harnessFailures,
      ...nested.productFailures,
    ]);
  }
});

test("schema or exact-plan loss fails closed with complete result fields", () => {
  const missing = validEvidence();
  missing.schemaVersion = 12;
  delete missing.plan;
  const result = assessDynamicNetworkTransition(missing);
  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
  assert.match(result.harnessFailures.join("\n"), /expected 13/);
  assert.match(result.harnessFailures.join("\n"), /plan is missing/);
  assert.equal(result.phases, null);
  assert.equal(result.transitionDurationsMs, null);
  assert.equal(result.continuity, null);
});

test("phase constants preserve the exact pristine-poor-pristine budget", () => {
  assert.deepEqual(DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases, {
    pristine: { startOffsetMs: 0, endOffsetMs: 12_000 },
    downshift: { startOffsetMs: 12_000, endOffsetMs: 24_000 },
    poor: { startOffsetMs: 24_000, endOffsetMs: 36_000 },
    recovery: { startOffsetMs: 36_000, endOffsetMs: 91_000 },
    recovered: { startOffsetMs: 91_000, endOffsetMs: 103_000 },
  });
  assert.equal(DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS, 500);
  assert.equal(DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.length, 3);
});

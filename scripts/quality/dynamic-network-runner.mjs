import { startEpochAlignedObserver } from "./epoch-aligned-observer.mjs";
import {
  DYNAMIC_NETWORK_TRANSITION_ENDPOINTS,
  DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS,
  DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
  DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
  advanceDynamicNetworkHintLedger,
  applyDynamicNetworkCdpMutation,
  buildDynamicNetworkCdpSchedule,
  buildDynamicNetworkHintApplicationObservationExpression,
  buildDynamicNetworkHintBootstrapScript,
  buildDynamicNetworkHintSchedule,
  buildDynamicNetworkHintUpdateExpression,
  buildDynamicNetworkTransitionPlan,
  createDynamicNetworkHintLedger,
  dynamicNetworkDownshiftCheckpointPassed,
  dynamicNetworkRecoveryFullCheckpointPassed,
  enableDynamicNetworkCdp,
  findSustainedCheckpointProof,
  recordDynamicNetworkHintApplication,
} from "./dynamic-network-transition.mjs";
import { scoreVisualMetrics } from "./scoring.mjs";

export const DYNAMIC_NETWORK_TRANSITION_RUN_MODE =
  "dynamic-network-transition";

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const clone = (value) => JSON.parse(JSON.stringify(value));

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

export function assertDynamicNetworkTransitionRunConfiguration({
  profileNames,
  receiverCount,
  durationMs,
  repetitions,
  requireUdp,
  sampleIntervalMs,
  codecScenario,
} = {}) {
  if (
    !Array.isArray(profileNames) ||
    profileNames.length !== 1 ||
    profileNames[0] !== "pristine" ||
    receiverCount !== 2 ||
    durationMs !== DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
    repetitions !== 1 ||
    requireUdp !== true ||
    sampleIntervalMs !== 450 ||
    !["all-modern", "native-compat"].includes(codecScenario)
  ) {
    throw new TypeError(
      "dynamic-network transition requires a supported exact codec scenario, pristine startup, two receivers, one 103s repetition, UDP, and a 450ms visual cadence",
    );
  }
  return Object.freeze({
    runMode: DYNAMIC_NETWORK_TRANSITION_RUN_MODE,
    schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
    profileNames: Object.freeze(["pristine"]),
    receiverCount: 2,
    durationMs: DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
    repetitions: 1,
    requireUdp: true,
    sampleIntervalMs: 450,
    codecScenario,
  });
}

export function buildFutureDynamicNetworkTransitionPlan({
  windowId,
  nowEpochMs = Date.now(),
} = {}) {
  if (!Number.isFinite(nowEpochMs) || nowEpochMs < 0) {
    throw new TypeError("dynamic-network current epoch must be non-negative");
  }
  return buildDynamicNetworkTransitionPlan({
    windowId,
    startedAtEpochMs:
      nowEpochMs + DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS,
  });
}

export function buildDynamicNetworkCheckpointExpression(endpoint) {
  if (!DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.includes(endpoint)) {
    throw new TypeError("dynamic-network checkpoint endpoint is invalid");
  }
  return `(async () => {
    const debug = globalThis.__conclaveGetMeetVideoDebug?.();
    const hintRuntime = globalThis.__conclaveQualityDynamicNetworkHint?.snapshot?.();
    const rtc = await globalThis.__conclaveQualityHarness?.collectPeerConnectionStats?.();
    return {
      ok: Boolean(debug && hintRuntime && rtc),
      endpoint: ${JSON.stringify(endpoint)},
      capturedAtEpochMs: Date.now(),
      debug: debug ?? null,
      hintRuntime: hintRuntime ?? null,
      rtc: rtc ?? null,
    };
  })()`;
}

const activeEncodings = (producer) =>
  Array.isArray(producer?.encodings)
    ? producer.encodings.filter((encoding) => encoding?.active !== false)
    : [];

const publisherHasFullLadder = (adaptivePublish) => {
  const producer = adaptivePublish?.producers?.webcam;
  const codec = producer?.codecs?.[0];
  const mimeType = String(codec?.mimeType ?? "").toLowerCase();
  const encodings = activeEncodings(producer);
  if (adaptivePublish?.videoQuality !== "standard") return false;
  if (mimeType === "video/vp9") {
    return (
      encodings.length === 1 && encodings[0]?.scalabilityMode === "L2T1"
    );
  }
  if (mimeType === "video/vp8") {
    return (
      encodings.length >= 3 &&
      encodings.every((encoding) => encoding?.scalabilityMode === "L1T1")
    );
  }
  return false;
};

const codecIdentityFromProducer = (producer) => {
  const codec = producer?.codecs?.[0];
  const encoding = activeEncodings(producer)[0];
  return {
    mimeType: String(codec?.mimeType ?? "").toLowerCase(),
    payloadType: Number.isInteger(codec?.payloadType)
      ? codec.payloadType
      : null,
    clockRate: codec?.clockRate ?? null,
    fmtp:
      typeof codec?.sdpFmtpLine === "string"
        ? codec.sdpFmtpLine
        : codec?.parameters?.["profile-id"] != null
          ? `profile-id=${codec.parameters["profile-id"]}`
          : "",
    scalabilityMode: encoding?.scalabilityMode ?? null,
    implementation: producer?.implementation ?? null,
    powerEfficient: producer?.powerEfficient ?? null,
  };
};

const videoKind = (stat) =>
  String(stat?.kind ?? stat?.mediaType ?? "").toLowerCase() === "video";

const uniqueExact = (values) => (values.length === 1 ? values[0] : null);

const networkPolicyEvidence = (network, direction) => {
  const prefix = direction === "publisher" ? "publish" : "receive";
  const media = network?.[`${prefix}Media`] ?? null;
  const browser = network?.browserNetwork ?? null;
  return {
    rtcQuality: network?.[`rtc${prefix[0].toUpperCase()}${prefix.slice(1)}Quality`] ?? null,
    rttMs: finite(network?.[`${prefix}RttMs`]),
    packetLoss: finite(network?.[`${prefix}PacketLoss`]),
    jitterMs: finite(network?.[`${prefix}JitterMs`]),
    availableBitrate: finite(
      network?.[
        direction === "publisher"
          ? "availableOutgoingBitrate"
          : "availableIncomingBitrate"
      ],
    ),
    audioBitrateBps: finite(media?.audio?.bitrateBps),
    videoBitrateBps: finite(media?.video?.bitrateBps),
    browserNetwork: {
      quality: browser?.quality ?? null,
      effectiveType: browser?.effectiveType ?? null,
      saveData:
        typeof browser?.saveData === "boolean" ? browser.saveData : null,
      downlinkMbps: finite(browser?.downlinkMbps),
      rttMs: finite(browser?.rttMs),
    },
  };
};

const exactPublisherPath = (raw, producer, mediaPathBinding) => {
  const reasons = [];
  const rtc = raw?.rtc;
  const connection = uniqueExact(
    (rtc?.peerConnections ?? []).filter(
      (candidate) => candidate?.id === mediaPathBinding?.connectionId,
    ),
  );
  if (!connection) reasons.push("fixed publisher peer connection is ambiguous or missing");
  const sender = uniqueExact(
    (connection?.senders ?? []).filter(
      (candidate) =>
        candidate?.id === mediaPathBinding?.senderId &&
        candidate?.track?.kind === "video",
    ),
  );
  if (!sender) reasons.push("fixed publisher sender is ambiguous or missing");
  if (sender?.track?.readyState !== "live" || sender?.statsError) {
    reasons.push("fixed publisher sender is not live and readable");
  }
  const currentTrackId = sender?.track?.id ?? null;
  if (
    !nonEmptyString(currentTrackId) ||
    producer?.trackId !== currentTrackId ||
    raw?.debug?.videoProducer?.track?.id !== currentTrackId ||
    raw?.debug?.videoProducer?.id !== producer?.id
  ) {
    reasons.push("product-current publisher is detached from the fixed sender");
  }
  const stats = sender?.stats ?? [];
  const rtps = stats.filter(
    (stat) =>
      stat?.type === "outbound-rtp" &&
      videoKind(stat) &&
      stat?.isRemote !== true &&
      stat?.mid !== "probator" &&
      stat?.trackIdentifier !== "probator",
  );
  if (rtps.length === 0) reasons.push("fixed publisher RTP stats are missing");
  const codecIds = new Set(rtps.map((rtp) => rtp?.codecId).filter(nonEmptyString));
  const codecs = stats.filter(
    (stat) => stat?.type === "codec" && codecIds.has(stat?.id),
  );
  if (codecIds.size !== 1 || codecs.length !== 1) {
    reasons.push("fixed publisher codec identity is ambiguous or missing");
  }
  return {
    direction: "publisher",
    reasons,
    connection,
    sender,
    stats,
    rtps,
    codec: codecs[0] ?? null,
    producerId: producer?.id ?? null,
    binding: mediaPathBinding,
  };
};

const exactReceiverPath = (raw, consumer, mediaPathBinding) => {
  const reasons = [];
  const rtc = raw?.rtc;
  const connection = uniqueExact(
    (rtc?.peerConnections ?? []).filter(
      (candidate) => candidate?.id === mediaPathBinding?.connectionId,
    ),
  );
  if (!connection) reasons.push("fixed receiver peer connection is ambiguous or missing");
  const stats = connection?.stats ?? [];
  const rtps = stats.filter(
    (stat) =>
      stat?.type === "inbound-rtp" &&
      videoKind(stat) &&
      stat?.isRemote !== true &&
      stat?.id === mediaPathBinding?.statId &&
      String(stat?.ssrc ?? "") === String(mediaPathBinding?.ssrc ?? "") &&
      stat?.trackIdentifier === mediaPathBinding?.consumerId,
  );
  if (rtps.length !== 1) {
    reasons.push("fixed receiver RTP stat is ambiguous or missing");
  }
  const rtp = rtps[0] ?? null;
  const codecs = stats.filter(
    (stat) => stat?.type === "codec" && stat?.id === rtp?.codecId,
  );
  if (codecs.length !== 1) {
    reasons.push("fixed receiver codec identity is ambiguous or missing");
  }
  if (
    consumer?.consumerId !== mediaPathBinding?.consumerId ||
    consumer?.producerId !== mediaPathBinding?.producerId
  ) {
    reasons.push("product-current consumer is detached from the fixed RTP path");
  }
  return {
    direction: "receiver",
    reasons,
    connection,
    sender: null,
    stats,
    rtps,
    codec: codecs[0] ?? null,
    producerId: consumer?.producerId ?? null,
    binding: mediaPathBinding,
  };
};

const mediaPathAuthority = (path) => ({
  version: 1,
  source:
    path?.direction === "publisher"
      ? "fixed-publisher-sender-binding"
      : "fixed-receiver-media-path-binding",
  matched: path?.reasons?.length === 0,
  reasons: [...(path?.reasons ?? [])],
  connectionId: path?.connection?.id ?? null,
  senderId: path?.sender?.id ?? null,
  trackId: path?.sender?.track?.id ?? null,
  consumerId:
    path?.direction === "receiver" ? path?.binding?.consumerId ?? null : null,
  producerId: path?.producerId ?? null,
  rtpStatIds: (path?.rtps ?? []).map((rtp) => rtp?.id ?? null).sort(),
  rtpSsrcs: (path?.rtps ?? [])
    .map((rtp) => String(rtp?.ssrc ?? ""))
    .sort(),
});

const codecIdentityFromPath = (path, producer = null) => {
  const rtp = path?.rtps?.[0] ?? null;
  const codec = path?.codec ?? null;
  const producerIdentity = codecIdentityFromProducer(producer);
  return {
    mimeType: String(codec?.mimeType ?? producerIdentity.mimeType ?? "").toLowerCase(),
    payloadType: Number.isInteger(codec?.payloadType)
      ? codec.payloadType
      : producerIdentity.payloadType,
    clockRate: codec?.clockRate ?? producerIdentity.clockRate,
    fmtp: codec?.sdpFmtpLine ?? producerIdentity.fmtp ?? "",
    scalabilityMode:
      rtp?.scalabilityMode ?? producerIdentity.scalabilityMode ?? null,
    implementation:
      rtp?.encoderImplementation ??
      rtp?.decoderImplementation ??
      producerIdentity.implementation ??
      null,
    powerEfficient:
      typeof rtp?.powerEfficientEncoder === "boolean"
        ? rtp.powerEfficientEncoder
        : typeof rtp?.powerEfficientDecoder === "boolean"
          ? rtp.powerEfficientDecoder
          : producerIdentity.powerEfficient,
  };
};

const encodedVideoShapeFromPath = (path) => {
  const maximum = (field) => {
    const values = (path?.rtps ?? [])
      .map((rtp) => finite(rtp?.[field]))
      .filter((value) => value !== null && value > 0);
    return values.length > 0 ? Math.max(...values) : null;
  };
  return {
    encodedWidth: maximum("frameWidth"),
    encodedHeight: maximum("frameHeight"),
    encodedFps: maximum("framesPerSecond"),
  };
};

const senderEncodingConfigurationFromPath = (path) => {
  const parameters = path?.sender?.parameters;
  const encodings = Array.isArray(parameters?.encodings)
    ? parameters.encodings
    : [];
  return {
    version: 1,
    degradationPreference:
      typeof parameters?.degradationPreference === "string"
        ? parameters.degradationPreference
        : null,
    encodings: encodings.map((encoding) => ({
      rid: typeof encoding?.rid === "string" ? encoding.rid : null,
      active: encoding?.active !== false,
      maxBitrate: finite(encoding?.maxBitrate),
      maxFramerate: finite(encoding?.maxFramerate),
      scaleResolutionDownBy: finite(encoding?.scaleResolutionDownBy),
      scalabilityMode:
        typeof encoding?.scalabilityMode === "string"
          ? encoding.scalabilityMode
          : null,
    })),
  };
};

const transportEvidenceFromPath = (path) => {
  const connection = path?.connection;
  const rtps = path?.rtps ?? [];
  if (!connection || rtps.length === 0 || path?.reasons?.length > 0) return null;
  const stats = path.stats ?? [];
  const transportIds = new Set(rtps.map((rtp) => rtp?.transportId).filter(nonEmptyString));
  const transport = uniqueExact(
    stats.filter((stat) =>
      stat?.type === "transport" &&
      (transportIds.size === 1
        ? transportIds.has(stat?.id)
        : nonEmptyString(stat?.selectedCandidatePairId)),
    ),
  );
  const candidatePair = uniqueExact(stats.filter(
    (stat) =>
      stat?.type === "candidate-pair" &&
      stat?.id === transport?.selectedCandidatePairId,
  ));
  const localCandidate = uniqueExact(stats.filter(
    (stat) => stat?.id === candidatePair?.localCandidateId,
  ));
  const remoteCandidate = uniqueExact(stats.filter(
    (stat) => stat?.id === candidatePair?.remoteCandidateId,
  ));
  const remoteInbound = path.direction === "publisher"
    ? rtps.map((rtp) =>
        uniqueExact(stats.filter(
          (stat) =>
            stat?.type === "remote-inbound-rtp" &&
            videoKind(stat) &&
            nonEmptyString(rtp?.remoteId) &&
            stat?.id === rtp.remoteId,
        )),
      )
    : [];
  const packetValues = rtps.map((rtp) =>
    path.direction === "publisher" ? rtp?.packetsSent : rtp?.packetsReceived,
  );
  const byteValues = rtps.map((rtp) =>
    path.direction === "publisher" ? rtp?.bytesSent : rtp?.bytesReceived,
  );
  const lostValues = path.direction === "publisher"
    ? remoteInbound.map((remote) => remote?.packetsLost)
    : rtps.map((rtp) => rtp?.packetsLost);
  const rttValues = path.direction === "publisher"
    ? remoteInbound.map((remote) => finite(remote?.roundTripTime)).filter((value) => value !== null)
    : [];
  const sumIntegers = (values) =>
    values.length > 0 && values.every(Number.isInteger)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  return {
    capturedAtEpochMs: path?.raw?.rtc?.capturedAt ?? null,
    transport: transport
      ? {
          id: transport.id,
          selectedCandidatePairId: transport.selectedCandidatePairId,
          state: transport.dtlsState === "connected" ? "connected" : null,
        }
      : null,
    candidatePair: candidatePair
      ? {
          id: candidatePair.id,
          transportId: transport?.id ?? candidatePair.transportId,
          localCandidateId: candidatePair.localCandidateId,
          remoteCandidateId: candidatePair.remoteCandidateId,
          selected: transport?.selectedCandidatePairId === candidatePair.id,
          state: candidatePair.state,
          currentRoundTripTime: candidatePair.currentRoundTripTime,
        }
      : null,
    localCandidate: localCandidate
      ? {
          id: localCandidate.id,
          transportId: transport?.id ?? localCandidate.transportId,
          protocol: localCandidate.protocol,
          candidateType: localCandidate.candidateType,
        }
      : null,
    remoteCandidate: remoteCandidate
      ? {
          id: remoteCandidate.id,
          transportId: transport?.id ?? remoteCandidate.transportId,
          protocol: remoteCandidate.protocol,
          candidateType: remoteCandidate.candidateType,
        }
      : null,
    rttMs:
      rttValues.length > 0
        ? Math.max(...rttValues) * 1_000
        : finite(candidatePair?.currentRoundTripTime) !== null
          ? candidatePair.currentRoundTripTime * 1_000
          : null,
    packets: sumIntegers(packetValues),
    lostPackets: sumIntegers(lostValues),
    bytes: sumIntegers(byteValues),
  };
};

const webcamConsumerEntry = (debug) => {
  const entries = Array.isArray(debug?.adaptiveConsumers?.entries)
    ? debug.adaptiveConsumers.entries.filter(
        (entry) => entry?.kind === "video" && entry?.type === "webcam",
      )
    : [];
  return entries.length === 1 ? entries[0] : null;
};

/**
 * Convert one page's product debug snapshot into the strict checkpoint shape.
 * Missing or ambiguous product fields intentionally remain null and are later
 * rejected by the schema-13 assessor.
 */
export function normalizeDynamicNetworkEndpointCheckpoint(
  raw,
  endpoint,
  { mediaPathBinding = null } = {},
) {
  const debug = raw?.debug;
  const hint = raw?.hintRuntime?.current;
  const network = debug?.network;
  if (endpoint === "publisher") {
    const adaptivePublish = debug?.adaptivePublish;
    const producer = adaptivePublish?.producers?.webcam;
    const settings = producer?.trackSettings ?? {};
    const path = exactPublisherPath(raw, producer, mediaPathBinding);
    const encodedShape = encodedVideoShapeFromPath(path);
    path.raw = raw;
    return {
      version: 1,
      hintGeneration: hint?.generation ?? null,
      hintState: hint?.state ?? null,
      connectionQuality: network?.publishAdaptationQuality ?? null,
      publishQuality: adaptivePublish?.videoQuality ?? null,
      networkProfile: adaptivePublish?.appliedWebcamNetworkProfile ?? null,
      networkProfileAuthority:
        adaptivePublish?.webcamNetworkProfileAuthority ?? null,
      producerTransportId: adaptivePublish?.producerTransportId ?? null,
      producerTransportNetworkProfile:
        adaptivePublish?.producerTransportNetworkProfile ?? null,
      producerTransportMaxIncomingBitrateBps: finite(
        adaptivePublish?.producerTransportMaxIncomingBitrateBps,
      ),
      captureWidth: finite(settings.width),
      captureHeight: finite(settings.height),
      captureFps: finite(settings.frameRate),
      ...encodedShape,
      mediaSurvived:
        producer?.closed === false &&
        producer?.paused === false &&
        producer?.trackReadyState === "live",
      adaptationUpdateInFlight: adaptivePublish?.updateInFlight === true,
      producerId: producer?.id ?? null,
      fullLadder: publisherHasFullLadder(adaptivePublish),
      senderEncodingConfiguration: senderEncodingConfigurationFromPath(path),
      networkPolicyEvidence: networkPolicyEvidence(network, "publisher"),
      mediaPathAuthority: mediaPathAuthority(path),
      codecIdentity: codecIdentityFromPath(path, producer),
      transportEvidence: transportEvidenceFromPath(path),
    };
  }
  const consumer = webcamConsumerEntry(debug);
  const path = exactReceiverPath(raw, consumer, mediaPathBinding);
  path.raw = raw;
  const currentLayers = consumer?.currentLayers ?? {};
  const bounds = consumer?.bounds ?? {};
  const maximumSpatialLayer = Number.isInteger(bounds.maxSpatialLayer)
    ? bounds.maxSpatialLayer
    : null;
  const maximumTemporalLayer = Number.isInteger(bounds.maxTemporalLayer)
    ? bounds.maxTemporalLayer
    : null;
  return {
    version: 1,
    hintGeneration: hint?.generation ?? null,
    hintState: hint?.state ?? null,
    connectionQuality: network?.receiveAdaptationQuality ?? null,
    receiveContinuityRisk:
      typeof network?.receiveContinuityRisk === "boolean"
        ? network.receiveContinuityRisk
        : null,
    browserAllowsFairWebcamLayerRecovery:
      typeof debug?.adaptiveConsumers
        ?.browserAllowsFairWebcamLayerRecovery === "boolean"
        ? debug.adaptiveConsumers.browserAllowsFairWebcamLayerRecovery
        : null,
    receiveRecoveryProbePhase:
      consumer?.receiveRecoveryProbePhase ?? null,
    receiveRecoveryProbeActive:
      typeof consumer?.receiveRecoveryProbeActive === "boolean"
        ? consumer.receiveRecoveryProbeActive
        : null,
    consumerScore:
      typeof consumer?.consumerScore === "number" &&
      Number.isFinite(consumer.consumerScore)
        ? consumer.consumerScore
        : null,
    consumerScoreQuality: consumer?.consumerScoreQuality ?? null,
    requestedSpatialLayer: Number.isInteger(
      consumer?.requestedLayers?.spatialLayer,
    )
      ? consumer.requestedLayers.spatialLayer
      : null,
    preferredSpatialLayer: Number.isInteger(
      consumer?.preferredLayers?.spatialLayer,
    )
      ? consumer.preferredLayers.spatialLayer
      : null,
    requestedKeyFrame:
      typeof consumer?.requestKeyFrame === "boolean"
        ? consumer.requestKeyFrame
        : null,
    spatialLayer: Number.isInteger(currentLayers.spatialLayer)
      ? currentLayers.spatialLayer
      : null,
    temporalLayer: Number.isInteger(currentLayers.temporalLayer)
      ? currentLayers.temporalLayer
      : 0,
    maximumSpatialLayer,
    maximumTemporalLayer,
    atTopLayer:
      Number.isInteger(currentLayers.spatialLayer) &&
      maximumSpatialLayer !== null &&
      currentLayers.spatialLayer === maximumSpatialLayer &&
      (currentLayers.temporalLayer ?? 0) === maximumTemporalLayer,
    mediaSurvived:
      consumer?.paused === false &&
      consumer?.producerPaused === false &&
      consumer?.status === "applied",
    adaptationUpdateInFlight:
      debug?.adaptiveConsumers?.deferredCount > 0 ||
      consumer?.status === "deferred",
    producerId: consumer?.producerId ?? null,
    networkPolicyEvidence: networkPolicyEvidence(network, "receiver"),
    mediaPathAuthority: mediaPathAuthority(path),
    codecIdentity: codecIdentityFromPath(path),
    transportEvidence: transportEvidenceFromPath(path),
  };
}

export function buildDynamicNetworkSamplerFromAlignedObservations({
  plan,
  publisherObservationWindow,
  primaryReceiverMeasurement,
  controlReceiverMeasurement,
} = {}) {
  const publisher = publisherObservationWindow?.observations ?? [];
  const primary =
    primaryReceiverMeasurement?.mediaPathBinding?.observations ?? [];
  const control =
    controlReceiverMeasurement?.mediaPathBinding?.observations ?? [];
  const expectedCount = DYNAMIC_NETWORK_TRANSITION_WINDOW_MS / 500 + 1;
  if (
    publisher.length !== expectedCount ||
    primary.length !== expectedCount ||
    control.length !== expectedCount
  ) {
    throw new Error(
      `dynamic-network shared observer coverage is ${publisher.length}/${primary.length}/${control.length}; expected ${expectedCount}`,
    );
  }
  const samplerInstanceId = `${plan.measurementWindow.id}:shared-aligned-500ms`;
  const checkpoints = publisher.map((publisherObservation, index) => {
    const primaryObservation = primary[index];
    const controlObservation = control[index];
    const expectedScheduledAtEpochMs =
      index === expectedCount - 1
        ? plan.measurementWindow.endedAtEpochMs - 50
        : plan.measurementWindow.startedAtEpochMs + index * 500;
    if (
      publisherObservation?.scheduledAtEpochMs !== expectedScheduledAtEpochMs ||
      primaryObservation?.scheduledAtEpochMs !== expectedScheduledAtEpochMs ||
      controlObservation?.scheduledAtEpochMs !== expectedScheduledAtEpochMs
    ) {
      throw new Error(
        `dynamic-network shared observer target ${index} is not synchronized`,
      );
    }
    const capturedAtEpochMs = Math.max(
      publisherObservation.capturedAtEpochMs,
      primaryObservation.capturedAtEpochMs,
      controlObservation.capturedAtEpochMs,
    );
    const endpointSnapshots = {
      publisher: clone(publisherObservation.dynamicNetworkCheckpoint),
      primaryReceiver: normalizeDynamicNetworkEndpointCheckpoint(
        primaryObservation.dynamicNetworkRaw,
        "primaryReceiver",
        {
          mediaPathBinding:
            primaryReceiverMeasurement?.mediaPathBinding?.expected,
        },
      ),
      controlReceiver: normalizeDynamicNetworkEndpointCheckpoint(
        controlObservation.dynamicNetworkRaw,
        "controlReceiver",
        {
          mediaPathBinding:
            controlReceiverMeasurement?.mediaPathBinding?.expected,
        },
      ),
    };
    delete primaryObservation.dynamicNetworkRaw;
    delete controlObservation.dynamicNetworkRaw;
    return {
      schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
      windowId: plan.measurementWindow.id,
      samplerInstanceId,
      index,
      scheduledOffsetMs:
        index === expectedCount - 1
          ? DYNAMIC_NETWORK_TRANSITION_WINDOW_MS
          : index * 500,
      capturedOffsetMs:
        capturedAtEpochMs - plan.measurementWindow.startedAtEpochMs,
      endpointSnapshots,
    };
  });
  return {
    version: 1,
    instanceId: samplerInstanceId,
    windowId: plan.measurementWindow.id,
    measurementWindow: plan.measurementWindow,
    startCount: 1,
    stopCount: 1,
    restartCount: 0,
    windowMutationCount: 0,
    startOffsetMs: 0,
    stopOffsetMs: DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
    checkpoints,
    observerAuthority: {
      version: 1,
      source: "publisher-codec-plus-receiver-path-observers",
      scheduledObservationCount: expectedCount,
      publisher: {
        skippedTickCount: publisherObservationWindow?.skippedTickCount,
        captureErrorCount: publisherObservationWindow?.captureErrorCount,
      },
      primaryReceiver:
        primaryReceiverMeasurement?.mediaPathBinding?.observerMetadata ?? null,
      controlReceiver:
        controlReceiverMeasurement?.mediaPathBinding?.observerMetadata ?? null,
    },
  };
}

const phaseCheckpointBindings = (sampler, phase, range) => {
  const checkpoints = sampler?.checkpoints ?? [];
  return checkpoints
    .filter((checkpoint) =>
      phase === "recovered"
        ? checkpoint.scheduledOffsetMs >= range.startOffsetMs &&
          checkpoint.scheduledOffsetMs <= range.endOffsetMs
        : checkpoint.scheduledOffsetMs >= range.startOffsetMs &&
          checkpoint.scheduledOffsetMs < range.endOffsetMs,
    )
    .map((checkpoint) => ({
      version: 1,
      windowId: sampler.windowId,
      samplerInstanceId: sampler.instanceId,
      checkpointId: `${sampler.windowId}:${sampler.instanceId}:${checkpoint.index}`,
      checkpointIndex: checkpoint.index,
      scheduledOffsetMs: checkpoint.scheduledOffsetMs,
      capturedOffsetMs: checkpoint.capturedOffsetMs,
    }));
};

const checkpointAt = (sampler, scheduledOffsetMs) =>
  sampler?.checkpoints?.find(
    (checkpoint) => checkpoint.scheduledOffsetMs === scheduledOffsetMs,
  ) ?? null;

const realizationEndpointSample = ({
  plan,
  endpoint,
  phase,
  startCheckpoint,
  endCheckpoint,
}) => {
  const start = startCheckpoint?.endpointSnapshots?.[endpoint];
  const end = endCheckpoint?.endpointSnapshots?.[endpoint];
  const first = start?.transportEvidence;
  const last = end?.transportEvidence;
  const packetsStart = first?.packets;
  const packetsEnd = last?.packets;
  const lostPacketsStart = first?.lostPackets;
  const lostPacketsEnd = last?.lostPackets;
  const bytesStart = first?.bytes;
  const bytesEnd = last?.bytes;
  const packetCount =
    Number.isInteger(packetsStart) && Number.isInteger(packetsEnd)
      ? packetsEnd - packetsStart
      : null;
  const lostPacketCount =
    Number.isInteger(lostPacketsStart) && Number.isInteger(lostPacketsEnd)
      ? lostPacketsEnd - lostPacketsStart
      : null;
  const byteCount =
    Number.isInteger(bytesStart) && Number.isInteger(bytesEnd)
      ? bytesEnd - bytesStart
      : null;
  const sampleStartedAtEpochMs = finite(first?.capturedAtEpochMs);
  const sampleEndedAtEpochMs = finite(last?.capturedAtEpochMs);
  const sampleDurationMs =
    sampleStartedAtEpochMs !== null && sampleEndedAtEpochMs !== null
      ? sampleEndedAtEpochMs - sampleStartedAtEpochMs
      : null;
  return {
    version: 1,
    windowId: plan.measurementWindow.id,
    endpoint,
    phase,
    transport: { version: 1, ...clone(last?.transport ?? {}) },
    candidatePair: { version: 1, ...clone(last?.candidatePair ?? {}) },
    localCandidate: { version: 1, ...clone(last?.localCandidate ?? {}) },
    remoteCandidate: { version: 1, ...clone(last?.remoteCandidate ?? {}) },
    rttMs: last?.rttMs ?? null,
    packetsStart,
    packetsEnd,
    lostPacketsStart,
    lostPacketsEnd,
    bytesStart,
    bytesEnd,
    sampleStartedAtEpochMs,
    sampleEndedAtEpochMs,
    sampleDurationMs,
    packetCount,
    lossRatio:
      packetCount > 0 && lostPacketCount >= 0
        ? lostPacketCount / packetCount
        : null,
    bitrateBps:
      byteCount >= 0 && sampleDurationMs > 0
        ? (byteCount * 8 * 1_000) / sampleDurationMs
        : null,
  };
};

const maximumFinite = (values, fallback) => {
  const usable = values.map(finite).filter((value) => value !== null);
  return usable.length > 0 ? Math.max(...usable) : fallback;
};

const controllerAuthorityOffsets = ({ plan, cdp, networkHints }) => ({
  receiverPoor: maximumFinite(
    [
      ...(cdp?.mutations ?? [])
        .filter(
          (mutation) =>
            mutation?.scheduledAtOffsetMs ===
            plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
        )
        .map((mutation) => mutation?.appliedAtOffsetMs),
      ...["primaryReceiver", "controlReceiver"].flatMap((endpoint) =>
        (networkHints?.[endpoint]?.applicationObservations ?? [])
          .filter((observation) => observation?.generation === 2)
          .map((observation) => observation?.observedAtOffsetMs),
      ),
    ],
    plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
  ),
  publisherPoor: maximumFinite(
    [
      ...(cdp?.mutations ?? [])
        .filter(
          (mutation) =>
            mutation?.scheduledAtOffsetMs ===
            plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
        )
        .map((mutation) => mutation?.appliedAtOffsetMs),
      ...DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.flatMap((endpoint) =>
        (networkHints?.[endpoint]?.applicationObservations ?? [])
          .filter((observation) => observation?.generation === 2)
          .map((observation) => observation?.observedAtOffsetMs),
      ),
    ],
    plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
  ),
  recovered: maximumFinite(
    [
      ...(cdp?.mutations ?? [])
        .filter(
          (mutation) =>
            mutation?.scheduledAtOffsetMs ===
            plan.phasePlan.mutations.clearPoorAtOffsetMs,
        )
        .map((mutation) => mutation?.appliedAtOffsetMs),
      ...DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.flatMap((endpoint) =>
        (networkHints?.[endpoint]?.applicationObservations ?? [])
          .filter((observation) => observation?.generation === 3)
          .map((observation) => observation?.observedAtOffsetMs),
      ),
    ],
    plan.phasePlan.mutations.clearPoorAtOffsetMs,
  ),
});

const boundarySafeCounterCheckpoints = ({ plan, sampler, cdp, networkHints }) => {
  const checkpoints = sampler?.checkpoints ?? [];
  const authorities = controllerAuthorityOffsets({ plan, cdp, networkHints });
  const firstStrictlyAfter = (offsetMs) =>
    checkpoints.find(
      (checkpoint) => checkpoint?.scheduledOffsetMs > offsetMs,
    ) ?? null;
  const lastStrictlyBefore = (offsetMs) =>
    checkpoints
      .filter((checkpoint) => checkpoint?.scheduledOffsetMs < offsetMs)
      .at(-1) ?? null;
  return {
    baseline: {
      requiredAuthorityOffsetMs: 0,
      startCheckpoint: checkpointAt(sampler, 500),
      endCheckpoint: lastStrictlyBefore(
        plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
      ),
    },
    receiverLimited: {
      requiredAuthorityOffsetMs: authorities.receiverPoor,
      startCheckpoint: firstStrictlyAfter(
        Math.max(
          plan.phasePlan.phases.downshift.startOffsetMs,
          authorities.receiverPoor,
        ),
      ),
      endCheckpoint: lastStrictlyBefore(
        plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
      ),
    },
    publisherLimited: {
      requiredAuthorityOffsetMs: authorities.publisherPoor,
      startCheckpoint: firstStrictlyAfter(
        Math.max(
          plan.phasePlan.phases.poor.startOffsetMs,
          authorities.publisherPoor,
        ),
      ),
      endCheckpoint: lastStrictlyBefore(
        plan.phasePlan.mutations.clearPoorAtOffsetMs,
      ),
    },
    recovered: {
      requiredAuthorityOffsetMs: Math.max(
        plan.phasePlan.phases.recovered.startOffsetMs,
        authorities.recovered,
      ),
      startCheckpoint: firstStrictlyAfter(
        Math.max(
          plan.phasePlan.phases.recovered.startOffsetMs,
          authorities.recovered,
        ),
      ),
      endCheckpoint: lastStrictlyBefore(
        plan.phasePlan.phases.recovered.endOffsetMs,
      ),
    },
  };
};

export function buildDynamicNetworkRealizationEvidence({
  plan,
  sampler,
  cdp,
  networkHints,
} = {}) {
  const phaseRanges = {
    baseline: plan.phasePlan.phases.pristine,
    receiverLimited: plan.phasePlan.phases.downshift,
    publisherLimited: plan.phasePlan.phases.poor,
    recovered: plan.phasePlan.phases.recovered,
  };
  const evidence = {
    version: 2,
    windowId: plan.measurementWindow.id,
    samplerInstanceId: sampler.instanceId,
  };
  const counterRanges = boundarySafeCounterCheckpoints({
    plan,
    sampler,
    cdp,
    networkHints,
  });
  for (const [phase, range] of Object.entries(phaseRanges)) {
    const bindings = phaseCheckpointBindings(sampler, phase, range);
    const counterRange = counterRanges[phase];
    const startCheckpoint = counterRange.startCheckpoint;
    const endCheckpoint = counterRange.endCheckpoint;
    const expectedCheckpointCount =
      (range.endOffsetMs - range.startOffsetMs) / 500 +
      (phase === "recovered" ? 1 : 0);
    evidence[phase] = {
      version: 1,
      windowId: plan.measurementWindow.id,
      phase,
      startOffsetMs: range.startOffsetMs,
      endOffsetMs: range.endOffsetMs,
      counterBaselineId: `${plan.measurementWindow.id}:${phase}:counters`,
      counterResetDetected: false,
      requiredAuthorityOffsetMs: counterRange.requiredAuthorityOffsetMs,
      counterStartCheckpointId: `${plan.measurementWindow.id}:${sampler.instanceId}:${startCheckpoint?.index ?? "missing"}`,
      counterEndCheckpointId: `${plan.measurementWindow.id}:${sampler.instanceId}:${endCheckpoint?.index ?? "missing"}`,
      counterStartScheduledOffsetMs:
        startCheckpoint?.scheduledOffsetMs ?? null,
      counterEndScheduledOffsetMs: endCheckpoint?.scheduledOffsetMs ?? null,
      counterStartCapturedOffsetMs: startCheckpoint?.capturedOffsetMs ?? null,
      counterEndCapturedOffsetMs: endCheckpoint?.capturedOffsetMs ?? null,
      expectedCheckpointCount,
      checkpointCount: bindings.length,
      checkpointCoverageRatio: bindings.length / expectedCheckpointCount,
      checkpointBindings: bindings,
      ...Object.fromEntries(
        DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) => [
          endpoint,
          realizationEndpointSample({
            plan,
            endpoint,
            phase,
            startCheckpoint,
            endCheckpoint,
          }),
        ]),
      ),
    };
  }
  return evidence;
}

const nearestRank = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
};

const visualScoreForSample = (sample) =>
  sample?.valid === true
    ? scoreVisualMetrics({
        ssim: sample.multiScaleSsim ?? sample.ssim,
        psnrDb: sample.psnrDb,
        edgeRetention: sample.edgeRetention,
        lumaError: sample.meanAbsoluteLumaError,
        blockiness: sample.blockiness,
        chromaPsnrDb: sample.chromaPsnrDb,
        chromaSsim: sample.chromaSsim,
        chromaError: sample.meanAbsoluteChromaError,
      })
    : null;

const buildSourceTimelineEvidence = (measurement, plan) => {
  const source =
    measurement?.publisher?.fixture?.captureToDisplaySource ?? null;
  return {
    version: 1,
    windowId: plan.measurementWindow.id,
    markerSequenceModulus: source?.markerSequenceModulus ?? null,
    resetAtEpochMs: source?.resetAtEpochMs ?? null,
    sources: (source?.sources ?? []).map((entry) => ({
      version: 1,
      sourceGeneration: entry.sourceGeneration,
      timestampMode: entry.timestampMode,
      manualFrames: entry.manualFrames,
      resetAtEpochMs: entry.resetAtEpochMs,
      requestFrameFailureCount: entry.requestFrameFailureCount,
      frames: (entry.frames ?? []).map((frame) => ({ ...frame })),
    })),
  };
};

const sourceFrameIndex = (sourceTimeline) => {
  const bySequence = new Map();
  for (const source of sourceTimeline?.sources ?? []) {
    for (const frame of source.frames ?? []) {
      const existing = bySequence.get(frame.sourceSequence);
      bySequence.set(
        frame.sourceSequence,
        existing ? null : { sourceGeneration: source.sourceGeneration, frame },
      );
    }
  }
  return bySequence;
};

const buildPhaseMetrics = ({
  phase,
  range,
  measurement,
  plan,
  sampler,
  targetId,
  sessionId,
  sourceTimeline,
}) => {
  const sourceBySequence = sourceFrameIndex(sourceTimeline);
  const visualSamples = (measurement?.visualSamples ?? [])
    .map((sample, index) => {
      const source = sourceBySequence.get(sample?.sourceSequence);
      return {
        version: 1,
        id: `${plan.measurementWindow.id}:${phase}:visual:${index}`,
        windowId: plan.measurementWindow.id,
        sourceMeasurementWindowId: sample?.measurementWindowId ?? null,
        endpoint: "primaryReceiver",
        targetId,
        sessionId,
        observerId: "primary-receiver-dedicated-visual-worker",
        metricSource: "dedicated-visual-worker",
        sourceGeneration: source?.sourceGeneration ?? null,
        sourceSequence: sample?.sourceSequence ?? null,
        capturedAtOffsetMs: sample?.sampledAtMs,
        visualScore: visualScoreForSample(sample),
      };
    })
    .filter(
      (sample) =>
        finite(sample.capturedAtOffsetMs) !== null &&
        sample.capturedAtOffsetMs >= range.startOffsetMs &&
        sample.capturedAtOffsetMs < range.endOffsetMs &&
        finite(sample.visualScore) !== null &&
        Number.isInteger(sample.sourceGeneration),
    )
    .sort((left, right) => left.capturedAtOffsetMs - right.capturedAtOffsetMs);
  const presentations =
    measurement?.captureToDisplayPresentation?.observations ?? [];
  const presentationObserverId =
    "primary-receiver-requestVideoFrameCallback";
  const presentationSamples = presentations
    .map((presentation, index) => {
      const capturedAtOffsetMs =
        presentation?.presentedAtEpochMs - plan.measurementWindow.startedAtEpochMs;
      if (
        finite(capturedAtOffsetMs) === null ||
        capturedAtOffsetMs < range.startOffsetMs ||
        capturedAtOffsetMs >= range.endOffsetMs
      ) {
        return null;
      }
      const source = sourceBySequence.get(presentation?.sourceSequence);
      const availableAtEpochMs = source?.frame?.availableAtEpochMs;
      return {
        version: 1,
        id: `${plan.measurementWindow.id}:${phase}:presentation:${index}`,
        windowId: plan.measurementWindow.id,
        sourceMeasurementWindowId:
          presentation?.measurementWindowId ?? null,
        endpoint: "primaryReceiver",
        targetId,
        sessionId,
        observerId: presentationObserverId,
        timestampSource: "requestVideoFrameCallback",
        sourceGeneration: source?.sourceGeneration ?? null,
        sourceSequence: presentation?.sourceSequence ?? null,
        capturedAtOffsetMs,
        presentedAtEpochMs: presentation?.presentedAtEpochMs ?? null,
        captureToDisplayMs:
          finite(availableAtEpochMs) !== null
            ? presentation.presentedAtEpochMs - availableAtEpochMs
            : null,
      };
    })
    .filter(
      (sample) =>
        sample &&
        Number.isInteger(sample.sourceGeneration) &&
        finite(sample.captureToDisplayMs) !== null,
    )
    .sort((left, right) => left.capturedAtOffsetMs - right.capturedAtOffsetMs);
  const visualScores = visualSamples.map((sample) => sample.visualScore);
  const latencies = presentationSamples.map(
    (sample) => sample.captureToDisplayMs,
  );
  const durationSeconds = (range.endOffsetMs - range.startOffsetMs) / 1_000;
  return {
    version: 1,
    windowId: plan.measurementWindow.id,
    phase,
    startOffsetMs: range.startOffsetMs,
    endOffsetMs: range.endOffsetMs,
    targetId,
    sessionId,
    metricImplementationVersion: 1,
    metricImplementation: "conclave-dynamic-video-quality-v1",
    measurementSource: "primary-receiver-rvfc-and-visual-worker",
    visualObserverId: "primary-receiver-dedicated-visual-worker",
    presentationObserverId,
    visualSampleIntervalMs: measurement?.sampleIntervalMs ?? null,
    samplerInstanceId: sampler.instanceId,
    checkpointBindings: phaseCheckpointBindings(sampler, phase, range).map(
      ({ checkpointId: _checkpointId, ...binding }) => binding,
    ),
    visualMetricSamples: visualSamples,
    presentationSamples,
    primaryReceiver: {
      visualScore:
        visualScores.length > 0
          ? visualScores.reduce((sum, value) => sum + value, 0) /
            visualScores.length
          : null,
      decodedFps: presentationSamples.length / durationSeconds,
      captureToDisplayP95Ms: nearestRank(latencies, 0.95),
      visualSampleCount: visualSamples.length,
      decodedFrameCount: presentationSamples.length,
      latencySampleCount: presentationSamples.length,
    },
  };
};

export const visibilityAroundInterval = ({
  eventIntervalStartOffsetMs,
  eventIntervalEndOffsetMs,
  presentations,
  plan,
}) => {
  const offsets = presentations
    .map(
      (presentation) =>
        presentation?.presentedAtEpochMs - plan.measurementWindow.startedAtEpochMs,
    )
    .filter((offset) => finite(offset) !== null)
    .sort((left, right) => left - right);
  const boundaryStartIndex = offsets.findLastIndex(
    (offset) => offset <= eventIntervalStartOffsetMs,
  );
  const boundaryEndIndex = offsets.findIndex(
    (offset) => offset >= eventIntervalEndOffsetMs,
  );
  const adaptationIntervalFrameOffsets =
    boundaryStartIndex >= 0 && boundaryEndIndex > boundaryStartIndex
      ? offsets.slice(boundaryStartIndex, boundaryEndIndex + 1)
      : [];
  const overlappingGaps = adaptationIntervalFrameOffsets
    .slice(1)
    .map((offset, index) => ({
      last: adaptationIntervalFrameOffsets[index],
      first: offset,
      gap: offset - adaptationIntervalFrameOffsets[index],
    }))
    .filter(
      ({ last, first }) =>
        last <= eventIntervalEndOffsetMs &&
        first >= eventIntervalStartOffsetMs,
    )
    .sort((left, right) => right.gap - left.gap);
  const maximumGap = overlappingGaps[0] ?? null;
  return {
    adaptationIntervalFrameOffsets,
    visibleFrameCountWithinAdaptationInterval:
      adaptationIntervalFrameOffsets.filter(
        (offset) =>
          offset >= eventIntervalStartOffsetMs &&
          offset <= eventIntervalEndOffsetMs,
      ).length,
    lastVisibleFrameAtOffsetMs: maximumGap?.last ?? null,
    firstVisibleFrameAtOffsetMs: maximumGap?.first ?? null,
    visibleGapMs: maximumGap?.gap ?? null,
  };
};

const publisherAdaptationSignature = (checkpoint) => {
  const publisher = checkpoint?.endpointSnapshots?.publisher;
  return {
    producerId: publisher?.producerId ?? null,
    publishQuality: publisher?.publishQuality ?? null,
    networkProfile: publisher?.networkProfile ?? null,
    networkProfileAuthority: publisher?.networkProfileAuthority ?? null,
    producerTransportId: publisher?.producerTransportId ?? null,
    producerTransportNetworkProfile:
      publisher?.producerTransportNetworkProfile ?? null,
    producerTransportMaxIncomingBitrateBps:
      publisher?.producerTransportMaxIncomingBitrateBps ?? null,
    captureWidth: publisher?.captureWidth ?? null,
    captureHeight: publisher?.captureHeight ?? null,
    captureFps: publisher?.captureFps ?? null,
    encodedWidth: publisher?.encodedWidth ?? null,
    encodedHeight: publisher?.encodedHeight ?? null,
    encodedFps: publisher?.encodedFps ?? null,
    fullLadder: publisher?.fullLadder ?? null,
    senderEncodingConfiguration:
      publisher?.senderEncodingConfiguration ?? null,
  };
};

export const frameVisibilityProducerIdsForAdaptationEvent = (
  event,
  fallbackProducerId = null,
) => ({
  fromProducerId:
    event?.fromSignature?.producerId ?? fallbackProducerId ?? null,
  toProducerId:
    event?.toSignature?.producerId ?? fallbackProducerId ?? null,
});

const publisherHasContinuousVp9PoorCap = (publisher) => {
  const configuration = publisher?.senderEncodingConfiguration;
  const encoding = configuration?.encodings?.[0];
  return (
    publisher?.codecIdentity?.mimeType === "video/vp9" &&
    publisher?.codecIdentity?.scalabilityMode === "L2T1" &&
    configuration?.degradationPreference === "maintain-resolution" &&
    configuration?.encodings?.length === 1 &&
    encoding?.active === true &&
    encoding?.maxBitrate > 0 &&
    encoding.maxBitrate <= 160_000 &&
    encoding?.maxFramerate > 0 &&
    encoding.maxFramerate <= 12 &&
    encoding?.scaleResolutionDownBy === 1 &&
    encoding?.scalabilityMode === "L2T1"
  );
};

const publisherHasStableVp8PoorCaps = (publisher) => {
  const configuration = publisher?.senderEncodingConfiguration;
  const encodings = configuration?.encodings;
  const maximumBitrates = [80_000, 25_000, 15_000];
  // A normal good-start live sender preserves its canonical cadence and only
  // changes bitrate. A sender created while constrained may expose lower
  // values, which also satisfy these upper bounds.
  const maximumFramerates = [12, 20, 30];
  const scales = [4, 2, 1];
  return (
    publisher?.codecIdentity?.mimeType === "video/vp8" &&
    publisher?.codecIdentity?.scalabilityMode === "L1T1" &&
    publisher?.networkProfile === "poor" &&
    configuration?.degradationPreference === "maintain-framerate" &&
    Array.isArray(encodings) &&
    encodings.length === 3 &&
    encodings.every(
      (encoding, index) =>
        encoding?.active === true &&
        encoding?.maxBitrate > 0 &&
        encoding.maxBitrate <= maximumBitrates[index] &&
        encoding?.maxFramerate > 0 &&
        encoding.maxFramerate <= maximumFramerates[index] &&
        encoding?.scaleResolutionDownBy === scales[index] &&
        encoding?.scalabilityMode === "L1T1",
    )
  );
};

const publisherHasStableVp8TransportPoorBudget = (publisher) => {
  const configuration = publisher?.senderEncodingConfiguration;
  const encodings = configuration?.encodings;
  const bitrates = [80_000, 220_000, 1_650_000];
  const framerates = [12, 20, 30];
  const scales = [4, 2, 1];
  const constrainedProfile = publisher?.networkProfile;
  const constrainedTransportProfile =
    publisher?.producerTransportNetworkProfile;
  return (
    publisher?.codecIdentity?.mimeType === "video/vp8" &&
    publisher?.codecIdentity?.scalabilityMode === "L1T1" &&
    (constrainedProfile === "poor" || constrainedProfile === "emergency") &&
    publisher?.networkProfileAuthority === "producer-transport" &&
    typeof publisher?.producerTransportId === "string" &&
    publisher.producerTransportId.length > 0 &&
    constrainedTransportProfile === constrainedProfile &&
    publisher?.producerTransportMaxIncomingBitrateBps > 0 &&
    publisher.producerTransportMaxIncomingBitrateBps <= 180_000 &&
    configuration?.degradationPreference === "maintain-framerate" &&
    Array.isArray(encodings) &&
    encodings.length === 3 &&
    encodings.every(
      (encoding, index) =>
        encoding?.active === true &&
        encoding?.maxBitrate === bitrates[index] &&
        encoding?.maxFramerate === framerates[index] &&
        encoding?.scaleResolutionDownBy === scales[index] &&
        encoding?.scalabilityMode === "L1T1",
    )
  );
};

const publisherMatchesAdaptationTarget = (checkpoint, direction) => {
  const publisher = checkpoint?.endpointSnapshots?.publisher;
  return direction === "down"
    ? ((publisher?.publishQuality === "low" &&
        ((publisher?.encodedWidth > 0 &&
          publisher.encodedWidth <= 427 &&
          publisher?.encodedHeight > 0 &&
          publisher.encodedHeight <= 240) ||
          publisherHasContinuousVp9PoorCap(publisher)) &&
        publisher?.fullLadder === false) ||
        (publisher?.publishQuality === "standard" &&
          publisher?.fullLadder === true &&
          (publisherHasStableVp8PoorCaps(publisher) ||
            publisherHasStableVp8TransportPoorBudget(publisher))))
    : publisher?.publishQuality === "standard" &&
        publisher?.networkProfile === "good" &&
        publisher?.encodedWidth >= 960 &&
        publisher?.encodedHeight >= 540 &&
        publisher?.fullLadder === true;
};

const adaptationEventInterval = (
  checkpoints,
  proof,
  direction,
  notBeforeOffsetMs,
) => {
  const currentIndex = checkpoints.findIndex((checkpoint, index) => {
    const previous = checkpoints[index - 1];
    return (
      index > 0 &&
      checkpoint?.capturedOffsetMs >= notBeforeOffsetMs &&
      checkpoint?.capturedOffsetMs <= proof?.startOffsetMs &&
      publisherMatchesAdaptationTarget(checkpoint, direction) &&
      !publisherMatchesAdaptationTarget(previous, direction) &&
      JSON.stringify(publisherAdaptationSignature(previous)) !==
        JSON.stringify(publisherAdaptationSignature(checkpoint))
    );
  });
  const current = checkpoints[currentIndex] ?? null;
  const previous = currentIndex > 0 ? checkpoints[currentIndex - 1] : null;
  return {
    version: 1,
    direction,
    previousCheckpointIndex: previous?.index ?? null,
    observedCheckpointIndex: current?.index ?? null,
    startOffsetMs: previous?.capturedOffsetMs ?? null,
    endOffsetMs: current?.capturedOffsetMs ?? null,
    fromSignature: previous ? publisherAdaptationSignature(previous) : null,
    toSignature: current ? publisherAdaptationSignature(current) : null,
    changed:
      Boolean(previous && current) &&
      JSON.stringify(publisherAdaptationSignature(previous)) !==
        JSON.stringify(publisherAdaptationSignature(current)),
  };
};

const codecAndContinuityEvidence = ({ plan, sampler, measurement, bindings }) => {
  const checkpoints = sampler.checkpoints;
  const downProof = findSustainedCheckpointProof(
    checkpoints,
    dynamicNetworkDownshiftCheckpointPassed,
    {
      notBeforeOffsetMs: 24_000,
      deadlineOffsetMs: 36_000,
      requiredSustainedMs: 2_000,
    },
  );
  const recoveryProof = findSustainedCheckpointProof(
    checkpoints,
    dynamicNetworkRecoveryFullCheckpointPassed,
    {
      notBeforeOffsetMs: 36_000,
      deadlineOffsetMs: 91_000,
      requiredSustainedMs: 3_000,
    },
  );
  // Codec identity is phase evidence, not evidence that the product met an
  // adaptation milestone. Sample immutable scheduled checkpoints inside each
  // counter window so a genuine downshift/recovery miss remains a product
  // failure instead of being misreported as absent harness evidence.
  const pristine = checkpointAt(sampler, 500)?.endpointSnapshots?.publisher;
  const poor = checkpointAt(sampler, 35_500)?.endpointSnapshots?.publisher;
  const recovered = checkpointAt(sampler, 102_500)?.endpointSnapshots?.publisher;
  const mimeType = String(pristine?.codecIdentity?.mimeType ?? "").toLowerCase();
  const ids = checkpoints.map(
    (checkpoint) => checkpoint?.endpointSnapshots?.publisher?.producerId,
  );
  const changes = [];
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (ids[index] !== ids[index - 1]) {
      changes.push({
        fromProducerId: ids[index - 1],
        toProducerId: ids[index],
        atOffsetMs: checkpoints[index].capturedOffsetMs,
      });
    }
  }
  const presentations =
    measurement?.captureToDisplayPresentation?.observations ?? [];
  const downEvent = adaptationEventInterval(
    checkpoints,
    downProof,
    "down",
    plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
  );
  const recoveryEvent = adaptationEventInterval(
    checkpoints,
    recoveryProof,
    "up",
    plan.phasePlan.mutations.clearPoorAtOffsetMs,
  );
  const downVisibility = visibilityAroundInterval({
    eventIntervalStartOffsetMs: downEvent.startOffsetMs,
    eventIntervalEndOffsetMs: downEvent.endOffsetMs,
    presentations,
    plan,
  });
  const recoveryVisibility = visibilityAroundInterval({
    eventIntervalStartOffsetMs: recoveryEvent.startOffsetMs,
    eventIntervalEndOffsetMs: recoveryEvent.endOffsetMs,
    presentations,
    plan,
  });
  const downVisibilityProducerIds =
    frameVisibilityProducerIdsForAdaptationEvent(
      downEvent,
      pristine?.producerId,
    );
  const recoveryVisibilityProducerIds =
    frameVisibilityProducerIdsForAdaptationEvent(
      recoveryEvent,
      pristine?.producerId,
    );
  const lineageId = `${plan.measurementWindow.id}:publisher-camera`;
  const transitions =
    mimeType === "video/vp8"
      ? changes.slice(0, 2).map((change, index) => {
          const event = index === 0 ? downEvent : recoveryEvent;
          return {
            version: 1,
            windowId: plan.measurementWindow.id,
            direction: index === 0 ? "down" : "up",
            lineageId,
            ...change,
            eventIntervalStartOffsetMs: event.startOffsetMs,
            eventIntervalEndOffsetMs: event.endOffsetMs,
            visibleGapMs:
              index === 0
                ? downVisibility.visibleGapMs
                : recoveryVisibility.visibleGapMs,
          };
        })
      : [];
  const producerLineage = {
    version: 1,
    windowId: plan.measurementWindow.id,
    lineageId,
    pristineProducerId: pristine?.producerId ?? null,
    poorProducerId: poor?.producerId ?? null,
    recoveredProducerId: recovered?.producerId ?? null,
    transitions,
  };
  const visibility = (values, event, proof, fromId, toId) => ({
    version: 1,
    windowId: plan.measurementWindow.id,
    endpoint: "primaryReceiver",
    targetId: bindings.primaryReceiver.targetId,
    sessionId: bindings.primaryReceiver.sessionId,
    samplerInstanceId: sampler.instanceId,
    fromProducerId: fromId,
    toProducerId: toId,
    adaptationEvent: event,
    adaptationProofStartOffsetMs: proof?.startOffsetMs ?? null,
    adaptationProofEndOffsetMs: proof?.endOffsetMs ?? null,
    observerId: "primary-receiver-frame-visibility",
    timestampSource: "requestVideoFrameCallback",
    maximumObservationIntervalMs: 20,
    ...values,
  });
  return {
    codec: {
      version: 1,
      windowId: plan.measurementWindow.id,
      phaseIdentities: {
        pristine: clone(pristine?.codecIdentity ?? null),
        poor: clone(poor?.codecIdentity ?? null),
        recovered: clone(recovered?.codecIdentity ?? null),
      },
      producerLineage,
    },
    continuity: {
      version: 1,
      windowId: plan.measurementWindow.id,
      downshiftVisibleGapMs: downVisibility.visibleGapMs,
      recoveryVisibleGapMs: recoveryVisibility.visibleGapMs,
      frameVisibility: {
        version: 1,
        windowId: plan.measurementWindow.id,
        downshift: visibility(
          downVisibility,
          downEvent,
          downProof,
          downVisibilityProducerIds.fromProducerId,
          downVisibilityProducerIds.toProducerId,
        ),
        recovery: visibility(
          recoveryVisibility,
          recoveryEvent,
          recoveryProof,
          recoveryVisibilityProducerIds.fromProducerId,
          recoveryVisibilityProducerIds.toProducerId,
        ),
      },
    },
  };
};

export function buildDynamicNetworkTransitionEvidence({
  controllerEvidence,
  measurement,
  bindings,
} = {}) {
  const { plan, sampler } = controllerEvidence;
  const sourceTimeline = buildSourceTimelineEvidence(measurement, plan);
  const codecContinuity = codecAndContinuityEvidence({
    plan,
    sampler,
    measurement,
    bindings,
  });
  return {
    schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
    controllerFailures: clone(controllerEvidence.controllerFailures ?? []),
    plan,
    topology: plan.topology,
    sampler,
    cdp: controllerEvidence.cdp,
    networkHints: controllerEvidence.networkHints,
    sourceTimeline,
    phaseMetrics: {
      pristine: buildPhaseMetrics({
        phase: "pristine",
        range: plan.phasePlan.phases.pristine,
        measurement,
        plan,
        sampler,
        targetId: bindings.primaryReceiver.targetId,
        sessionId: bindings.primaryReceiver.sessionId,
        sourceTimeline,
      }),
      recovered: buildPhaseMetrics({
        phase: "recovered",
        range: plan.phasePlan.phases.recovered,
        measurement,
        plan,
        sampler,
        targetId: bindings.primaryReceiver.targetId,
        sessionId: bindings.primaryReceiver.sessionId,
        sourceTimeline,
      }),
    },
    networkRealization: buildDynamicNetworkRealizationEvidence({
      plan,
      sampler,
      cdp: controllerEvidence.cdp,
      networkHints: controllerEvidence.networkHints,
    }),
    ...codecContinuity,
  };
}

export const sleepUntil = async ({ targetEpochMs, now, setTimer }) => {
  // Timers are allowed to wake slightly early. The transition ledger is bound
  // to absolute epochs, so never apply a mutation until that epoch is actually
  // reached; otherwise an accurate run can invalidate itself by 1-2ms.
  while (now() < targetEpochMs) {
    await new Promise((resolve) => {
      const timer = setTimer(
        resolve,
        Math.max(0, targetEpochMs - now()),
      );
      timer?.unref?.();
    });
  }
};

/**
 * Arm CDP/hints after the joined product debug hook exists, but before one
 * immutable future epoch. All later mutations and samples use absolute epoch
 * targets; no callback-relative drift or deprecated CDP fallback is allowed.
 */
export async function startDynamicNetworkTransitionController({
  plan,
  endpoints,
  evaluatePage,
  waitForProductObservation,
  collectCheckpoint = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (
    typeof evaluatePage !== "function" ||
    typeof waitForProductObservation !== "function" ||
    (collectCheckpoint !== null && typeof collectCheckpoint !== "function")
  ) {
    throw new TypeError("dynamic-network controller callbacks are required");
  }
  const targetIds = {};
  const sessionIds = {};
  for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
    const binding = endpoints?.[endpoint];
    if (
      !binding?.cdp ||
      !nonEmptyString(binding.cdp.targetId) ||
      !nonEmptyString(binding.cdp.sessionId)
    ) {
      throw new TypeError(`dynamic-network CDP binding is missing for ${endpoint}`);
    }
    targetIds[endpoint] = binding.cdp.targetId;
    sessionIds[endpoint] = binding.cdp.sessionId;
  }
  const cdpSchedule = buildDynamicNetworkCdpSchedule(plan, {
    targetIds,
    sessionIds,
  });
  const hintSchedule = buildDynamicNetworkHintSchedule(plan);
  const cdp = {
    version: 1,
    windowId: plan.measurementWindow.id,
    deprecatedFallbackAllowed: false,
    setup: [],
    mutations: [],
  };
  const networkHints = {};
  const controllerFailures = [];

  const applyHint = async (endpoint, scheduled) => {
    const updatedAtEpochMs = now();
    const updatedAtOffsetMs =
      updatedAtEpochMs - plan.measurementWindow.startedAtEpochMs;
    let ledger = advanceDynamicNetworkHintLedger(networkHints[endpoint], {
      generation: scheduled.generation,
      state: scheduled.state,
      scheduledAtOffsetMs: scheduled.scheduledAtOffsetMs,
      updatedAtEpochMs,
      updatedAtOffsetMs,
    });
    const expression =
      scheduled.generation === 1
        ? buildDynamicNetworkHintBootstrapScript({
            endpoint,
            initialUpdate: ledger.updates.at(-1),
          })
        : buildDynamicNetworkHintUpdateExpression(ledger.updates.at(-1));
    await evaluatePage(endpoint, expression);
    const observerId = `${endpoint}-useConnectionQuality`;
    const observed = await waitForProductObservation(
      endpoint,
      buildDynamicNetworkHintApplicationObservationExpression({ observerId }),
    );
    const runtimeReceipt = observed?.receipt ?? observed;
    ledger = recordDynamicNetworkHintApplication(ledger, {
      generation: scheduled.generation,
      observerId,
      runtimeReceipt,
    });
    networkHints[endpoint] = ledger;
  };

  await Promise.all(
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map(async (endpoint) => {
      const binding = endpoints[endpoint];
      cdp.setup.push(
        await enableDynamicNetworkCdp(binding.cdp, {
          endpoint,
          targetId: targetIds[endpoint],
          sessionId: sessionIds[endpoint],
          measurementWindow: plan.measurementWindow,
          now,
        }),
      );
      networkHints[endpoint] = createDynamicNetworkHintLedger(endpoint, {
        measurementWindow: plan.measurementWindow,
        targetId: targetIds[endpoint],
        sessionId: sessionIds[endpoint],
      });
      const mutation = cdpSchedule.mutations.find(
        (candidate) =>
          candidate.endpoint === endpoint &&
          candidate.scheduledAtOffsetMs === 0,
      );
      cdp.mutations.push(
        await applyDynamicNetworkCdpMutation(binding.cdp, mutation, {
          measurementWindow: plan.measurementWindow,
          now,
        }),
      );
      const scheduledHint = hintSchedule.find(
        (candidate) =>
          candidate.endpoint === endpoint && candidate.generation === 1,
      );
      await applyHint(endpoint, scheduledHint);
    }),
  );
  if (now() >= plan.measurementWindow.startedAtEpochMs) {
    throw new Error(
      "dynamic-network initialization did not finish before the shared epoch",
    );
  }

  const mutationTasks = [12_000, 24_000, 36_000].map(
    async (scheduledAtOffsetMs) => {
      await sleepUntil({
        targetEpochMs:
          plan.measurementWindow.startedAtEpochMs + scheduledAtOffsetMs,
        now,
        setTimer,
      });
      await Promise.all(
        DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map(async (endpoint) => {
          try {
            const mutation = cdpSchedule.mutations.find(
              (candidate) =>
                candidate.endpoint === endpoint &&
                candidate.scheduledAtOffsetMs === scheduledAtOffsetMs,
            );
            cdp.mutations.push(
              await applyDynamicNetworkCdpMutation(
                endpoints[endpoint].cdp,
                mutation,
                { measurementWindow: plan.measurementWindow, now },
              ),
            );
            const scheduledHint = hintSchedule.find(
              (candidate) =>
                candidate.endpoint === endpoint &&
                candidate.scheduledAtOffsetMs === scheduledAtOffsetMs,
            );
            if (scheduledHint) await applyHint(endpoint, scheduledHint);
          } catch (error) {
            controllerFailures.push(
              `${scheduledAtOffsetMs}/${endpoint}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }),
      );
    },
  );

  const samplerInstanceId = `${plan.measurementWindow.id}:continuous-500ms`;
  const observer = collectCheckpoint
    ? startEpochAlignedObserver({
        measurementWindow: plan.measurementWindow,
        observationIntervalMs: 500,
        terminalLeadMs: 50,
        maximumTickLatenessMs: 250,
        maximumSampleDurationMs: 250,
        now,
        setTimer,
        clearTimer,
        observe: async (tick) => {
          const collected = await collectCheckpoint(tick);
          const capturedAtEpochMs = finite(collected?.capturedAtEpochMs) ?? now();
          const scheduledOffsetMs =
            tick.phase === "terminal"
              ? DYNAMIC_NETWORK_TRANSITION_WINDOW_MS
              : tick.scheduledAtEpochMs -
                plan.measurementWindow.startedAtEpochMs;
          return {
            schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
            windowId: plan.measurementWindow.id,
            samplerInstanceId,
            index: tick.index,
            scheduledOffsetMs,
            capturedOffsetMs:
              capturedAtEpochMs - plan.measurementWindow.startedAtEpochMs,
            capturedAtEpochMs,
            endpointSnapshots: clone(collected?.endpointSnapshots ?? {}),
          };
        },
      })
    : null;

  return Object.freeze({
    version: 1,
    schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
    plan,
    async stop({ sampler: externallyAlignedSampler = null } = {}) {
      await Promise.all(mutationTasks);
      const observed = observer ? await observer.stop() : null;
      const endpointOrder = new Map(
        DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint, index) => [
          endpoint,
          index,
        ]),
      );
      cdp.setup.sort(
        (left, right) =>
          endpointOrder.get(left.endpoint) - endpointOrder.get(right.endpoint),
      );
      cdp.mutations.sort(
        (left, right) =>
          left.scheduledAtOffsetMs - right.scheduledAtOffsetMs ||
          endpointOrder.get(left.endpoint) - endpointOrder.get(right.endpoint),
      );
      return {
        version: 1,
        schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
        plan,
        cdp,
        networkHints,
        controllerFailures,
        sampler: externallyAlignedSampler ?? {
          version: 1,
          instanceId: samplerInstanceId,
          windowId: plan.measurementWindow.id,
          measurementWindow: plan.measurementWindow,
          startCount: 1,
          stopCount: 1,
          restartCount: 0,
          windowMutationCount: 0,
          startOffsetMs: 0,
          stopOffsetMs: DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
          checkpoints: (observed?.observations ?? []).map((checkpoint) => ({
            schemaVersion: checkpoint.schemaVersion,
            windowId: checkpoint.windowId,
            samplerInstanceId: checkpoint.samplerInstanceId,
            index: checkpoint.index,
            scheduledOffsetMs: checkpoint.scheduledOffsetMs,
            capturedOffsetMs: checkpoint.capturedOffsetMs,
            endpointSnapshots: checkpoint.endpointSnapshots,
          })),
          observerAuthority: observed,
        },
      };
    },
  });
}

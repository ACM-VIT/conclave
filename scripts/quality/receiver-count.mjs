export const DEFAULT_VIDEO_QUALITY_RECEIVER_COUNT = 1;
export const MIN_VIDEO_QUALITY_RECEIVER_COUNT = 1;
export const MAX_VIDEO_QUALITY_RECEIVER_COUNT = 4;

export const parseVideoQualityReceiverCount = (value) => {
  if (value == null || String(value).trim() === "") {
    return DEFAULT_VIDEO_QUALITY_RECEIVER_COUNT;
  }

  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_VIDEO_QUALITY_RECEIVER_COUNT ||
    parsed > MAX_VIDEO_QUALITY_RECEIVER_COUNT
  ) {
    throw new Error(
      `receiver count must be an integer from ${MIN_VIDEO_QUALITY_RECEIVER_COUNT} to ${MAX_VIDEO_QUALITY_RECEIVER_COUNT}`,
    );
  }
  return parsed;
};

export const expectedActiveVideoSenderEncodingCount = ({
  codecScenario,
  receiverCount = DEFAULT_VIDEO_QUALITY_RECEIVER_COUNT,
}) => {
  if (codecScenario !== "native-compat") return 1;
  return parseVideoQualityReceiverCount(receiverCount) === 1 ? 1 : 3;
};

const NATIVE_VP8_TOPOLOGIES = {
  "single-receiver": [
    {
      rid: null,
      maxBitrate: 1_650_000,
      maxFramerate: 30,
      scalabilityMode: "L1T1",
    },
  ],
  "adaptive-layers": [
    {
      rid: "r0",
      maxBitrate: 80_000,
      maxFramerate: 12,
      scalabilityMode: "L1T1",
    },
    {
      rid: "r1",
      maxBitrate: 220_000,
      maxFramerate: 20,
      scalabilityMode: "L1T1",
    },
    {
      rid: "r2",
      maxBitrate: 1_650_000,
      maxFramerate: 30,
      scalabilityMode: "L1T1",
    },
  ],
};

export const expectedNativeVp8PublisherTopology = (receiverCount) => {
  const boundedReceiverCount = parseVideoQualityReceiverCount(receiverCount);
  const mode =
    boundedReceiverCount === 1 ? "single-receiver" : "adaptive-layers";
  return {
    mode,
    producerTopology:
      mode === "single-receiver" ? "vp8-single-layer" : "vp8-simulcast",
    transitionPhase: mode === "single-receiver" ? "single" : "adaptive",
    receiverCapacityProofBasis:
      mode === "single-receiver" ? "single-layer" : null,
    producerReplacementRequired: mode === "single-receiver",
    encodingCount: NATIVE_VP8_TOPOLOGIES[mode].length,
    activeEncodingCount: NATIVE_VP8_TOPOLOGIES[mode].length,
    encodings: NATIVE_VP8_TOPOLOGIES[mode].map((encoding) => ({
      ...encoding,
    })),
  };
};

const normalizeMimeType = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const encodingLabel = (rid, index) => rid ?? `single-${index}`;

const assessConfiguredEncodings = (observedEncodings, expected, reasons) => {
  if (observedEncodings.length !== expected.encodingCount) {
    reasons.push(
      `configured sender encoding count is ${observedEncodings.length}; expected ${expected.encodingCount}`,
    );
  }

  for (let index = 0; index < expected.encodings.length; index += 1) {
    const expectedEncoding = expected.encodings[index];
    const observed = observedEncodings[index];
    const label = encodingLabel(expectedEncoding.rid, index);
    if (!observed) {
      reasons.push(`encoding ${label} is missing`);
      continue;
    }
    if ((observed.rid ?? null) !== expectedEncoding.rid) {
      reasons.push(`encoding ${label} rid is ${String(observed.rid ?? null)}`);
    }
    if (observed.active !== true) {
      reasons.push(`encoding ${label} is not active`);
    }
    if (observed.maxBitrate !== expectedEncoding.maxBitrate) {
      reasons.push(
        `encoding ${label} maxBitrate is ${String(observed.maxBitrate)}`,
      );
    }
    if (observed.maxFramerate !== expectedEncoding.maxFramerate) {
      reasons.push(
        `encoding ${label} maxFramerate is ${String(observed.maxFramerate)}`,
      );
    }
    if (observed.scalabilityMode !== expectedEncoding.scalabilityMode) {
      reasons.push(
        `encoding ${label} scalabilityMode is ${String(observed.scalabilityMode ?? "missing")}; expected ${expectedEncoding.scalabilityMode}`,
      );
    }
  }
};

const assessTransmittedEncodings = (publisherRtc, expected, reasons) => {
  const observedEncodings = Array.isArray(publisherRtc?.encodings)
    ? publisherRtc.encodings
    : [];
  if (publisherRtc?.encodingCount !== expected.encodingCount) {
    reasons.push(
      `outbound RTP encoding count is ${String(publisherRtc?.encodingCount)}; expected ${expected.encodingCount}`,
    );
  }
  if (publisherRtc?.activeEncodingCount !== expected.activeEncodingCount) {
    reasons.push(
      `active outbound RTP encoding count is ${String(publisherRtc?.activeEncodingCount)}; expected ${expected.activeEncodingCount}`,
    );
  }
  if (observedEncodings.length !== expected.encodingCount) {
    reasons.push(
      `outbound RTP evidence contains ${observedEncodings.length} encoding(s); expected ${expected.encodingCount}`,
    );
  }
  for (const encoding of observedEncodings) {
    const label = encoding.id ?? encoding.rid ?? "unknown";
    if (encoding.active !== true || encoding.transmitted !== true) {
      reasons.push(`outbound RTP encoding ${label} is not live and transmitting`);
    }
    if (
      !(Number.isFinite(encoding.bytesSentDelta) && encoding.bytesSentDelta > 0)
    ) {
      reasons.push(`outbound RTP encoding ${label} sent no bytes`);
    }
    if (
      !(
        Number.isFinite(encoding.framesEncodedDelta) &&
        encoding.framesEncodedDelta > 0
      )
    ) {
      reasons.push(`outbound RTP encoding ${label} encoded no frames`);
    }
    if (normalizeMimeType(encoding.codecMimeType) !== "video/vp8") {
      reasons.push(
        `outbound RTP encoding ${label} codec is ${encoding.codecMimeType ?? "missing"}`,
      );
    }
    if (encoding.scalabilityMode !== "L1T1") {
      reasons.push(
        `outbound RTP encoding ${label} scalabilityMode is ${encoding.scalabilityMode ?? "missing"}; expected L1T1`,
      );
    }
  }
};

export const assessNativeVp8PublisherReadiness = ({
  receiverCount,
  adaptivePublish,
  publisherRtc,
  initialProducerId = null,
}) => {
  const boundedReceiverCount = parseVideoQualityReceiverCount(receiverCount);
  const expected = expectedNativeVp8PublisherTopology(boundedReceiverCount);
  const producer = adaptivePublish?.producers?.webcam ?? null;
  const signature = adaptivePublish?.lastAppliedProfiles?.webcam ?? null;
  const observedEncodings = Array.isArray(producer?.encodings)
    ? producer.encodings
    : [];
  const reasons = [];

  if (
    typeof producer?.id !== "string" ||
    producer.closed === true ||
    producer.paused === true ||
    producer.trackReadyState !== "live"
  ) {
    reasons.push("live webcam producer is missing");
  }
  if (
    publisherRtc?.binding?.matched !== true ||
    publisherRtc.binding.trackId !== producer?.trackId
  ) {
    reasons.push("outbound RTP evidence is not bound to the live producer sender");
  }
  if (adaptivePublish?.participantCount !== boundedReceiverCount + 1) {
    reasons.push(
      `participant count is ${String(adaptivePublish?.participantCount)}; expected ${boundedReceiverCount + 1}`,
    );
  }
  if (
    typeof signature !== "string" ||
    !signature.startsWith(`${producer?.id ?? "missing"}:standard:good:`)
  ) {
    reasons.push("publisher profile signature is not bound to the live producer");
  }
  if (adaptivePublish?.webcamProducerTopology !== expected.producerTopology) {
    reasons.push(
      `publisher topology is ${adaptivePublish?.webcamProducerTopology ?? "missing"}; expected ${expected.producerTopology}`,
    );
  }
  if (
    adaptivePublish?.webcamTopologyTransitionPhase !== expected.transitionPhase
  ) {
    reasons.push(
      `publisher transition phase is ${adaptivePublish?.webcamTopologyTransitionPhase ?? "missing"}; expected ${expected.transitionPhase}`,
    );
  }

  if (expected.producerReplacementRequired) {
    if (
      typeof initialProducerId !== "string" ||
      initialProducerId.length === 0 ||
      producer?.id === initialProducerId
    ) {
      reasons.push("VP8 simulcast to single-encoding producer replacement is missing");
    }
    if (adaptivePublish?.receiverCapacityProofProducerId !== producer?.id) {
      reasons.push("receiver-capacity proof is not bound to the final producer");
    }
    if (
      adaptivePublish?.receiverCapacityProofBasis !==
      expected.receiverCapacityProofBasis
    ) {
      reasons.push(
        `receiver-capacity proof basis is ${adaptivePublish?.receiverCapacityProofBasis ?? "missing"}; expected ${expected.receiverCapacityProofBasis}`,
      );
    }
    if (adaptivePublish?.receiverCapacityHandoffOffered === true) {
      reasons.push("final producer still exposes a replacement handoff offer");
    }
  } else if (
    typeof initialProducerId === "string" &&
    initialProducerId.length > 0 &&
    producer?.id !== initialProducerId
  ) {
    reasons.push("multi-receiver VP8 producer changed unexpectedly");
  }

  assessConfiguredEncodings(observedEncodings, expected, reasons);
  assessTransmittedEncodings(publisherRtc, expected, reasons);

  return {
    ready: reasons.length === 0,
    reasons,
    expected,
    observed: {
      producerId: producer?.id ?? null,
      producerTrackId: producer?.trackId ?? null,
      signature,
      participantCount: adaptivePublish?.participantCount ?? null,
      producerTopology: adaptivePublish?.webcamProducerTopology ?? null,
      transitionPhase:
        adaptivePublish?.webcamTopologyTransitionPhase ?? null,
      receiverCapacityProofProducerId:
        adaptivePublish?.receiverCapacityProofProducerId ?? null,
      receiverCapacityProofBasis:
        adaptivePublish?.receiverCapacityProofBasis ?? null,
      receiverCapacityHandoffOffered:
        adaptivePublish?.receiverCapacityHandoffOffered ?? null,
      encodings: observedEncodings,
      publisherRtc: publisherRtc ?? null,
    },
    transition: {
      required: expected.producerReplacementRequired,
      initialProducerId,
      finalProducerId: producer?.id ?? null,
      observed:
        typeof initialProducerId === "string" &&
        typeof producer?.id === "string" &&
        producer.id !== initialProducerId,
      finalProducerTopology:
        adaptivePublish?.webcamProducerTopology ?? null,
      finalTransitionPhase:
        adaptivePublish?.webcamTopologyTransitionPhase ?? null,
      finalProofBasis:
        adaptivePublish?.receiverCapacityProofBasis ?? null,
    },
  };
};

export const WEBCAM_RECEIVER_CAPACITY_PROOF_MAX_VALID_MS = 5_000;

export type WebcamReceiverCapacityProofBasis =
  | "simulcast-full-layer"
  | "single-layer-transition"
  | "single-layer";

export type WebcamReceiverCapacityReplacementOffer = {
  nonce: string;
  validForMs: number;
  target: "vp8-single-layer";
};

export type WebcamReceiverCapacityProofPayload = {
  roomId: string;
  producerId: string;
  revision: number;
  eligible: boolean;
  validForMs: number;
  reason: string;
  basis: WebcamReceiverCapacityProofBasis;
  replacementOffer?: WebcamReceiverCapacityReplacementOffer;
  replacesProducerId?: string;
  transitionNonce?: string;
  maxSpatialLayer?: number;
  maxTemporalLayer?: number;
  currentSpatialLayer?: number;
  currentTemporalLayer?: number;
  score?: number;
};

export type ActiveWebcamReceiverCapacityProof = {
  roomId: string;
  producerId: string;
  revision: number;
  basis: WebcamReceiverCapacityProofBasis;
  expiresAtMonotonicMs: number;
  replacementOffer?: {
    nonce: string;
    target: "vp8-single-layer";
    expiresAtMonotonicMs: number;
  };
  replacesProducerId?: string;
  transitionNonce?: string;
};

export type WebcamReceiverCapacityProofRevocation = {
  roomId: string;
  producerId: string;
  revision: number;
  basis: WebcamReceiverCapacityProofBasis;
  reason: string;
};

export type WebcamReceiverCapacityProofCache = {
  roomId: string | null;
  latestRevisionByProducer: ReadonlyMap<string, number>;
  activeByProducer: ReadonlyMap<string, ActiveWebcamReceiverCapacityProof>;
  successorByTransition: ReadonlyMap<
    string,
    ActiveWebcamReceiverCapacityProof
  >;
  revocationByProducer: ReadonlyMap<
    string,
    WebcamReceiverCapacityProofRevocation
  >;
};

type ProofContext = {
  roomId: string | null;
  producerId: string | null;
};

export type WebcamReceiverCapacityProofRevision = {
  producerId: string;
  revision: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isSafeRevision = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0;

const isFiniteLayer = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 10;

const isBoundedIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

const isProofBasis = (
  value: unknown,
): value is WebcamReceiverCapacityProofBasis =>
  value === "simulcast-full-layer" ||
  value === "single-layer-transition" ||
  value === "single-layer";

const parseReplacementOffer = (
  value: unknown,
): WebcamReceiverCapacityReplacementOffer | null => {
  if (!isRecord(value)) return null;
  if (
    !isBoundedIdentifier(value.nonce) ||
    value.target !== "vp8-single-layer" ||
    typeof value.validForMs !== "number" ||
    !Number.isInteger(value.validForMs) ||
    value.validForMs <= 0 ||
    value.validForMs > WEBCAM_RECEIVER_CAPACITY_PROOF_MAX_VALID_MS
  ) {
    return null;
  }
  return {
    nonce: value.nonce,
    target: value.target,
    validForMs: value.validForMs,
  };
};

export const parseWebcamReceiverCapacityProof = (
  value: unknown,
): WebcamReceiverCapacityProofPayload | null => {
  if (!isRecord(value)) return null;
  const {
    roomId,
    producerId,
    revision,
    eligible,
    validForMs,
    reason,
    basis,
  } = value;
  if (
    !isBoundedIdentifier(roomId) ||
    !isBoundedIdentifier(producerId) ||
    !isSafeRevision(revision) ||
    typeof eligible !== "boolean" ||
    typeof validForMs !== "number" ||
    !Number.isFinite(validForMs) ||
    !Number.isInteger(validForMs) ||
    validForMs < 0 ||
    validForMs > WEBCAM_RECEIVER_CAPACITY_PROOF_MAX_VALID_MS ||
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > 64 ||
    !isProofBasis(basis)
  ) {
    return null;
  }
  if (eligible !== (validForMs > 0)) return null;

  const optionalLayers = [
    value.maxSpatialLayer,
    value.maxTemporalLayer,
    value.currentSpatialLayer,
    value.currentTemporalLayer,
  ];
  if (
    optionalLayers.some(
      (layer) => layer !== undefined && !isFiniteLayer(layer),
    )
  ) {
    return null;
  }
  if (
    value.score !== undefined &&
    (typeof value.score !== "number" ||
      !Number.isFinite(value.score) ||
      value.score < 0 ||
      value.score > 10)
  ) {
    return null;
  }

  let replacementOffer: WebcamReceiverCapacityReplacementOffer | undefined;
  if (value.replacementOffer !== undefined) {
    const parsedOffer = parseReplacementOffer(value.replacementOffer);
    if (!parsedOffer || basis !== "simulcast-full-layer" || !eligible) {
      return null;
    }
    replacementOffer = parsedOffer;
  }

  const replacesProducerId = value.replacesProducerId;
  const transitionNonce = value.transitionNonce;
  if (
    replacesProducerId !== undefined &&
    !isBoundedIdentifier(replacesProducerId)
  ) {
    return null;
  }
  if (transitionNonce !== undefined && !isBoundedIdentifier(transitionNonce)) {
    return null;
  }
  if (
    eligible &&
    basis === "single-layer-transition" &&
    (!isBoundedIdentifier(replacesProducerId) ||
      !isBoundedIdentifier(transitionNonce))
  ) {
    return null;
  }
  if (
    basis !== "single-layer-transition" &&
    (replacesProducerId !== undefined || transitionNonce !== undefined)
  ) {
    return null;
  }

  if (
    eligible &&
    basis === "simulcast-full-layer" &&
    (!isFiniteLayer(value.maxSpatialLayer) ||
      !isFiniteLayer(value.maxTemporalLayer) ||
      value.currentSpatialLayer !== value.maxSpatialLayer ||
      value.currentTemporalLayer !== value.maxTemporalLayer)
  ) {
    return null;
  }

  const maxSpatialLayer = isFiniteLayer(value.maxSpatialLayer)
    ? value.maxSpatialLayer
    : undefined;
  const maxTemporalLayer = isFiniteLayer(value.maxTemporalLayer)
    ? value.maxTemporalLayer
    : undefined;
  const currentSpatialLayer = isFiniteLayer(value.currentSpatialLayer)
    ? value.currentSpatialLayer
    : undefined;
  const currentTemporalLayer = isFiniteLayer(value.currentTemporalLayer)
    ? value.currentTemporalLayer
    : undefined;
  const score = typeof value.score === "number" ? value.score : undefined;

  return {
    roomId,
    producerId,
    revision,
    eligible,
    validForMs,
    reason,
    basis,
    ...(replacementOffer ? { replacementOffer } : {}),
    ...(replacesProducerId === undefined ? {} : { replacesProducerId }),
    ...(transitionNonce === undefined ? {} : { transitionNonce }),
    ...(maxSpatialLayer === undefined ? {} : { maxSpatialLayer }),
    ...(maxTemporalLayer === undefined ? {} : { maxTemporalLayer }),
    ...(currentSpatialLayer === undefined ? {} : { currentSpatialLayer }),
    ...(currentTemporalLayer === undefined ? {} : { currentTemporalLayer }),
    ...(score === undefined ? {} : { score }),
  };
};

const toActiveProof = (
  payload: WebcamReceiverCapacityProofPayload,
  nowMonotonicMs: number,
): ActiveWebcamReceiverCapacityProof => ({
  roomId: payload.roomId,
  producerId: payload.producerId,
  revision: payload.revision,
  basis: payload.basis,
  expiresAtMonotonicMs: nowMonotonicMs + payload.validForMs,
  ...(payload.replacementOffer
    ? {
        replacementOffer: {
          nonce: payload.replacementOffer.nonce,
          target: payload.replacementOffer.target,
          expiresAtMonotonicMs:
            nowMonotonicMs +
            Math.min(payload.validForMs, payload.replacementOffer.validForMs),
        },
      }
    : {}),
  ...(payload.replacesProducerId === undefined
    ? {}
    : { replacesProducerId: payload.replacesProducerId }),
  ...(payload.transitionNonce === undefined
    ? {}
    : { transitionNonce: payload.transitionNonce }),
});

export const applyWebcamReceiverCapacityProof = (
  current: ActiveWebcamReceiverCapacityProof | null,
  payloadValue: unknown,
  context: ProofContext,
  nowMonotonicMs: number,
): ActiveWebcamReceiverCapacityProof | null => {
  const payload = parseWebcamReceiverCapacityProof(payloadValue);
  if (
    !payload ||
    payload.roomId !== context.roomId ||
    payload.producerId !== context.producerId
  ) {
    return current;
  }
  if (
    current?.producerId === payload.producerId &&
    payload.revision <= current.revision
  ) {
    return current;
  }
  return payload.eligible ? toActiveProof(payload, nowMonotonicMs) : null;
};

export const createWebcamReceiverCapacityProofCache = (
  roomId: string | null = null,
): WebcamReceiverCapacityProofCache => ({
  roomId,
  latestRevisionByProducer: new Map(),
  activeByProducer: new Map(),
  successorByTransition: new Map(),
  revocationByProducer: new Map(),
});

export const getWebcamReceiverCapacityTransitionKey = (
  replacesProducerId: string,
  transitionNonce: string,
): string => `${replacesProducerId.length}:${replacesProducerId}:${transitionNonce}`;

export const reduceWebcamReceiverCapacityProofCache = (
  current: WebcamReceiverCapacityProofCache,
  payloadValue: unknown,
  roomId: string,
  nowMonotonicMs: number,
): WebcamReceiverCapacityProofCache => {
  const payload = parseWebcamReceiverCapacityProof(payloadValue);
  if (!payload || payload.roomId !== roomId) return current;
  const latestRevision = current.latestRevisionByProducer.get(
    payload.producerId,
  );
  if (latestRevision !== undefined && payload.revision <= latestRevision) {
    return current;
  }

  const latestRevisionByProducer = new Map(current.latestRevisionByProducer);
  const activeByProducer = new Map(current.activeByProducer);
  const successorByTransition = new Map(current.successorByTransition);
  const revocationByProducer = new Map(current.revocationByProducer);
  latestRevisionByProducer.set(payload.producerId, payload.revision);

  for (const [key, proof] of successorByTransition) {
    if (proof.producerId === payload.producerId) successorByTransition.delete(key);
  }

  if (payload.eligible) {
    const proof = toActiveProof(payload, nowMonotonicMs);
    activeByProducer.set(payload.producerId, proof);
    revocationByProducer.delete(payload.producerId);
    if (
      proof.basis === "single-layer-transition" &&
      proof.replacesProducerId &&
      proof.transitionNonce
    ) {
      successorByTransition.set(
        getWebcamReceiverCapacityTransitionKey(
          proof.replacesProducerId,
          proof.transitionNonce,
        ),
        proof,
      );
    }
  } else {
    activeByProducer.delete(payload.producerId);
    revocationByProducer.set(payload.producerId, {
      roomId: payload.roomId,
      producerId: payload.producerId,
      revision: payload.revision,
      basis: payload.basis,
      reason: payload.reason,
    });
  }

  return {
    roomId,
    latestRevisionByProducer,
    activeByProducer,
    successorByTransition,
    revocationByProducer,
  };
};

export const selectActiveWebcamReceiverCapacityProof = (
  cache: WebcamReceiverCapacityProofCache,
  context: ProofContext,
  nowMonotonicMs: number,
): ActiveWebcamReceiverCapacityProof | null => {
  if (!context.producerId || cache.roomId !== context.roomId) return null;
  const proof = cache.activeByProducer.get(context.producerId) ?? null;
  return isWebcamReceiverCapacityProofActive(
    proof,
    context,
    nowMonotonicMs,
  )
    ? proof
    : null;
};

export const selectStagedWebcamReceiverCapacitySuccessor = (
  cache: WebcamReceiverCapacityProofCache,
  options: {
    roomId: string | null;
    replacesProducerId: string;
    transitionNonce: string;
    nowMonotonicMs: number;
  },
): ActiveWebcamReceiverCapacityProof | null => {
  if (cache.roomId !== options.roomId) return null;
  const proof =
    cache.successorByTransition.get(
      getWebcamReceiverCapacityTransitionKey(
        options.replacesProducerId,
        options.transitionNonce,
      ),
    ) ?? null;
  return proof && options.nowMonotonicMs < proof.expiresAtMonotonicMs
    ? proof
    : null;
};

export const selectWebcamReceiverCapacityRevocation = (
  cache: WebcamReceiverCapacityProofCache,
  roomId: string | null,
  producerId: string | null,
): WebcamReceiverCapacityProofRevocation | null => {
  if (!producerId || cache.roomId !== roomId) return null;
  return cache.revocationByProducer.get(producerId) ?? null;
};

export const shouldAcceptWebcamReceiverCapacityProofRevision = (
  latest: WebcamReceiverCapacityProofRevision | null,
  next: WebcamReceiverCapacityProofRevision,
): boolean =>
  latest?.producerId !== next.producerId || next.revision > latest.revision;

export const isWebcamReceiverCapacityProofActive = (
  proof: ActiveWebcamReceiverCapacityProof | null,
  context: ProofContext,
  nowMonotonicMs: number,
): boolean =>
  proof !== null &&
  proof.roomId === context.roomId &&
  proof.producerId === context.producerId &&
  nowMonotonicMs < proof.expiresAtMonotonicMs;

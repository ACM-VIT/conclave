import { randomBytes } from "node:crypto";
import type { Consumer, Producer } from "mediasoup/types";
import type {
  WebcamReceiverCapacityProofBasis,
  WebcamReceiverCapacityProofNotification,
  WebcamReceiverCapacityProofReason,
  WebcamReceiverCapacityReplacementOffer,
} from "../types.js";

export const WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS = 6_000;
export const WEBCAM_RECEIVER_CAPACITY_RENEW_MS = 2_000;
export const WEBCAM_RECEIVER_CAPACITY_VALID_MS = 5_000;
export const WEBCAM_RECEIVER_CAPACITY_TRANSITION_CONSUMER_GRACE_MS = 5_000;
export const WEBCAM_RECEIVER_CAPACITY_TRANSITION_MAX_MS = 15_000;
export const WEBCAM_RECEIVER_CAPACITY_MIN_SCORE = 9;
export const WEBCAM_RECEIVER_CAPACITY_NONCE_HISTORY_MAX = 1_024;

export type WebcamReceiverCapacityClientSnapshot = {
  id: string;
  isObserver: boolean;
  connected?: boolean;
  transportConnected?: boolean;
  consumer: Consumer | null;
};

export type WebcamReceiverCapacityEvaluationInput = {
  producerId: string;
  ownerClientId: string | null;
  producer: Producer | null;
  producerIsCurrent: boolean;
  clients: readonly WebcamReceiverCapacityClientSnapshot[];
  screenShareActive?: boolean;
  roomQuality?: "low" | "standard";
};

export type WebcamReceiverCapacityEvaluation = {
  qualified: boolean;
  reason: WebcamReceiverCapacityProofReason;
  ownerClientId: string | null;
  basis?: Exclude<
    WebcamReceiverCapacityProofBasis,
    "single-layer-transition"
  >;
  consumerCount?: number;
  maxSpatialLayer?: number;
  maxTemporalLayer?: number;
  currentSpatialLayer?: number;
  currentTemporalLayer?: number;
  score?: number;
};

export type WebcamReceiverCapacityTransitionBinding = {
  ownerClientId: string;
  ownerSocketId: string;
  producerTransportId: string;
};

export type WebcamReceiverCapacityTransitionReservation = {
  nonce: string;
  predecessorProducerId: string;
  predecessorGeneration: number;
  ownerClientId: string;
  ownerSocketId: string;
  producerTransportId: string;
  expiresAt: number;
};

export type ReserveWebcamReceiverCapacityTransitionInput =
  WebcamReceiverCapacityTransitionBinding & {
    predecessorProducerId: string;
    nonce: string;
  };

const disqualified = (
  reason: WebcamReceiverCapacityProofReason,
  ownerClientId: string | null,
  details: Omit<
    WebcamReceiverCapacityEvaluation,
    "qualified" | "reason" | "ownerClientId"
  > = {},
): WebcamReceiverCapacityEvaluation => ({
  qualified: false,
  reason,
  ownerClientId,
  ...details,
});

const AUXILIARY_VIDEO_CODEC_MIME_TYPES = new Set([
  "video/rtx",
  "video/red",
  "video/ulpfec",
  "video/flexfec-03",
]);

const hasOnlyVp8MediaCodec = (producer: Producer): boolean => {
  const mediaCodecs = producer.rtpParameters.codecs.filter(
    (codec) =>
      !AUXILIARY_VIDEO_CODEC_MIME_TYPES.has(codec.mimeType.toLowerCase()),
  );
  return (
    mediaCodecs.length === 1 &&
    mediaCodecs[0]?.mimeType.toLowerCase() === "video/vp8"
  );
};

const parseMaxTemporalLayer = (producer: Producer): number | null => {
  const encodings = producer.rtpParameters.encodings ?? [];
  const highestEncoding = encodings[encodings.length - 1];
  const scalabilityMode = highestEncoding?.scalabilityMode;
  if (typeof scalabilityMode !== "string") return null;
  const match = /^L\d+T(\d+)/i.exec(scalabilityMode);
  const temporalLayerCount = Number(match?.[1]);
  return Number.isInteger(temporalLayerCount) && temporalLayerCount > 0
    ? temporalLayerCount - 1
    : null;
};

export const isVp8SimulcastProducer = (producer: Producer): boolean =>
  producer.kind === "video" &&
  producer.type === "simulcast" &&
  (producer.rtpParameters.encodings?.length ?? 0) > 1 &&
  hasOnlyVp8MediaCodec(producer);

export const isVp8SingleLayerProducer = (producer: Producer): boolean =>
  producer.kind === "video" &&
  producer.type === "simple" &&
  (producer.rtpParameters.encodings?.length ?? 0) === 1 &&
  hasOnlyVp8MediaCodec(producer);

const hasFullLayers = (
  layers: { spatialLayer: number; temporalLayer?: number } | undefined,
  maxSpatialLayer: number,
  maxTemporalLayer: number,
): boolean =>
  layers?.spatialLayer === maxSpatialLayer &&
  layers.temporalLayer === maxTemporalLayer;

/**
 * Evaluates only server-owned mediasoup state. Client-reported network quality
 * or publisher uplink health is intentionally not accepted as receiver proof.
 */
export const evaluateWebcamReceiverCapacity = (
  input: WebcamReceiverCapacityEvaluationInput,
): WebcamReceiverCapacityEvaluation => {
  const { ownerClientId, producer } = input;
  if (!ownerClientId) {
    return disqualified("owner_missing", null);
  }
  if (!producer) {
    return disqualified("producer_missing", ownerClientId);
  }
  if (!input.producerIsCurrent || producer.id !== input.producerId) {
    return disqualified("producer_not_current", ownerClientId);
  }
  if (producer.closed || producer.paused) {
    return disqualified("producer_paused", ownerClientId);
  }

  const basis: Exclude<
    WebcamReceiverCapacityProofBasis,
    "single-layer-transition"
  > | null = isVp8SimulcastProducer(producer)
    ? "simulcast-full-layer"
    : isVp8SingleLayerProducer(producer)
      ? "single-layer"
      : null;
  if (!basis) {
    return disqualified(
      producer.type === "simple"
        ? "producer_not_vp8_single_layer"
        : "producer_not_vp8_simulcast",
      ownerClientId,
    );
  }

  const owner = input.clients.find((client) => client.id === ownerClientId);
  if (!owner || owner.isObserver) {
    return disqualified("owner_missing", ownerClientId, { basis });
  }
  if (owner.connected === false) {
    return disqualified("owner_disconnected", ownerClientId, { basis });
  }
  if (owner.transportConnected === false) {
    return disqualified("transport_disconnected", ownerClientId, { basis });
  }
  if (input.screenShareActive) {
    return disqualified("screen_share_active", ownerClientId, { basis });
  }
  if (input.roomQuality === "low") {
    return disqualified("room_quality_low", ownerClientId, { basis });
  }

  // Count connected receiver candidates, not merely existing consumers. This
  // revokes before a newly joined third participant can begin consuming.
  const receivers = input.clients.filter(
    (client) => client.id !== ownerClientId,
  );
  if (receivers.length !== 1) {
    return disqualified("receiver_count", ownerClientId, { basis });
  }
  const receiver = receivers[0];
  if (receiver.isObserver) {
    return disqualified("receiver_observer", ownerClientId, { basis });
  }
  if (receiver.connected === false) {
    return disqualified("receiver_disconnected", ownerClientId, { basis });
  }
  if (receiver.transportConnected === false) {
    return disqualified("transport_disconnected", ownerClientId, { basis });
  }

  const liveConsumers = input.clients
    .map((client) => client.consumer)
    .filter(
      (consumer): consumer is Consumer =>
        Boolean(
          consumer &&
            !consumer.closed &&
            consumer.producerId === input.producerId,
        ),
    );
  if (liveConsumers.length !== 1) {
    return disqualified("consumer_count", ownerClientId, {
      basis,
      consumerCount: liveConsumers.length,
    });
  }
  const consumer = receiver.consumer;
  if (
    !consumer ||
    consumer.closed ||
    consumer.producerId !== input.producerId ||
    liveConsumers[0]?.id !== consumer.id
  ) {
    return disqualified("consumer_missing", ownerClientId, {
      basis,
      consumerCount: liveConsumers.length,
    });
  }
  const consumerTypeMatches =
    basis === "single-layer"
      ? consumer.kind === "video" && consumer.type === "simple"
      : consumer.kind === "video" && consumer.type === "simulcast";
  if (!consumerTypeMatches) {
    return disqualified(
      basis === "single-layer" ? "consumer_not_simple" : "consumer_not_simulcast",
      ownerClientId,
      { basis, consumerCount: 1 },
    );
  }
  if (consumer.paused || consumer.producerPaused) {
    return disqualified("consumer_paused", ownerClientId, {
      basis,
      consumerCount: 1,
    });
  }

  if (basis === "single-layer") {
    const consumerScore = consumer.score;
    if (
      consumerScore.score < WEBCAM_RECEIVER_CAPACITY_MIN_SCORE ||
      consumerScore.producerScore < WEBCAM_RECEIVER_CAPACITY_MIN_SCORE
    ) {
      return disqualified("consumer_score_low", ownerClientId, {
        basis,
        consumerCount: 1,
        score: consumerScore.score,
      });
    }
    const producerScores = producer.score;
    if (
      producerScores.length !== 1 ||
      producerScores[0].score < WEBCAM_RECEIVER_CAPACITY_MIN_SCORE
    ) {
      return disqualified("producer_score_low", ownerClientId, {
        basis,
        consumerCount: 1,
        score: consumerScore.score,
      });
    }
    return {
      qualified: true,
      reason: "qualified",
      ownerClientId,
      basis,
      consumerCount: 1,
      score: consumerScore.score,
    };
  }

  const encodings = producer.rtpParameters.encodings ?? [];
  const maxSpatialLayer = encodings.length - 1;
  const maxTemporalLayer = parseMaxTemporalLayer(producer);
  if (maxTemporalLayer === null) {
    return disqualified("producer_not_vp8_simulcast", ownerClientId, {
      basis,
      consumerCount: 1,
      maxSpatialLayer,
    });
  }
  const currentLayers = consumer.currentLayers;
  const layerDetails = {
    basis,
    consumerCount: 1,
    maxSpatialLayer,
    maxTemporalLayer,
    currentSpatialLayer: currentLayers?.spatialLayer,
    currentTemporalLayer: currentLayers?.temporalLayer,
  };
  if (!hasFullLayers(currentLayers, maxSpatialLayer, maxTemporalLayer)) {
    return disqualified(
      "consumer_not_full_layer",
      ownerClientId,
      layerDetails,
    );
  }
  if (
    consumer.preferredLayers &&
    !hasFullLayers(
      consumer.preferredLayers,
      maxSpatialLayer,
      maxTemporalLayer,
    )
  ) {
    return disqualified(
      "consumer_prefers_lower_layer",
      ownerClientId,
      layerDetails,
    );
  }

  const score = consumer.score;
  const selectedProducerScore = score.producerScores[maxSpatialLayer];
  const scoreDetails = { ...layerDetails, score: score.score };
  if (
    score.score < WEBCAM_RECEIVER_CAPACITY_MIN_SCORE ||
    score.producerScore < WEBCAM_RECEIVER_CAPACITY_MIN_SCORE ||
    typeof selectedProducerScore !== "number" ||
    selectedProducerScore < WEBCAM_RECEIVER_CAPACITY_MIN_SCORE
  ) {
    return disqualified("consumer_score_low", ownerClientId, scoreDetails);
  }

  return {
    qualified: true,
    reason: "qualified",
    ownerClientId,
    ...scoreDetails,
  };
};

type ReplacementOfferState = WebcamReceiverCapacityTransitionBinding & {
  nonce: string;
  expiresAt: number;
};

type TransitionState = {
  predecessorProducerId: string;
  nonce: string;
  startedAt: number;
  consumerAttachDeadline: number;
  hardDeadline: number;
  consumerSeen: boolean;
};

type CoordinatorState = {
  generation: number;
  timerToken: number;
  timer: NodeJS.Timeout | null;
  timerDueAt: number | null;
  revision: number;
  qualifyingSince: number | null;
  eligible: boolean;
  lastEmittedAt: number | null;
  ownerClientId: string | null;
  basis: WebcamReceiverCapacityProofBasis;
  evaluation: WebcamReceiverCapacityEvaluation;
  replacementOffer: ReplacementOfferState | null;
  reservedNonce: string | null;
  transition: TransitionState | null;
};

export type WebcamReceiverCapacityProofCoordinatorOptions = {
  roomId: string;
  evaluate: (producerId: string) => WebcamReceiverCapacityEvaluation;
  emit: (
    ownerClientId: string,
    proof: WebcamReceiverCapacityProofNotification,
  ) => void;
  getTransitionBinding?: (
    producerId: string,
  ) => WebcamReceiverCapacityTransitionBinding | null;
  createNonce?: () => string;
  now?: () => number;
  onError?: (error: unknown) => void;
};

const emptyEvaluation = (
  reason: WebcamReceiverCapacityProofReason,
): WebcamReceiverCapacityEvaluation => ({
  qualified: false,
  reason,
  ownerClientId: null,
});

const bindingsMatch = (
  left: WebcamReceiverCapacityTransitionBinding,
  right: WebcamReceiverCapacityTransitionBinding,
): boolean =>
  left.ownerClientId === right.ownerClientId &&
  left.ownerSocketId === right.ownerSocketId &&
  left.producerTransportId === right.producerTransportId;

export class WebcamReceiverCapacityProofCoordinator {
  private readonly states = new Map<string, CoordinatorState>();
  private readonly reservations = new Map<
    string,
    WebcamReceiverCapacityTransitionReservation
  >();
  private readonly validatedReservations = new Set<string>();
  private readonly issuedNonces = new Set<string>();
  private readonly issuedNonceOrder: string[] = [];
  private nextGeneration = 0;
  private closed = false;

  constructor(
    private readonly options: WebcamReceiverCapacityProofCoordinatorOptions,
  ) {}

  refresh(producerId: string): void {
    if (this.closed) return;
    const state = this.getOrCreateState(producerId);
    const now = this.now();
    const evaluation = this.safeEvaluate(producerId);
    state.evaluation = evaluation;
    if (evaluation.ownerClientId) {
      state.ownerClientId = evaluation.ownerClientId;
    }

    if (state.transition) {
      this.refreshTransition(producerId, state, evaluation, now);
      return;
    }
    this.expireReservationIfNeeded(state, now);

    if (!evaluation.qualified) {
      this.disqualify(producerId, state, evaluation.reason);
      return;
    }

    state.basis = evaluation.basis ?? state.basis;
    if (state.qualifyingSince === null) {
      state.qualifyingSince = now;
    }
    const qualificationDueAt =
      state.qualifyingSince + WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS;
    if (now < qualificationDueAt) {
      this.schedule(producerId, state, qualificationDueAt);
      return;
    }

    const renewalDueAt =
      (state.lastEmittedAt ?? Number.NEGATIVE_INFINITY) +
      WEBCAM_RECEIVER_CAPACITY_RENEW_MS;
    if (!state.eligible || now >= renewalDueAt) {
      state.eligible = true;
      state.lastEmittedAt = now;
      this.emit(
        producerId,
        state,
        "qualified",
        WEBCAM_RECEIVER_CAPACITY_VALID_MS,
      );
    }
    this.schedule(
      producerId,
      state,
      (state.lastEmittedAt ?? now) + WEBCAM_RECEIVER_CAPACITY_RENEW_MS,
    );
  }

  refreshAll(producerIds: Iterable<string>): void {
    if (this.closed) return;
    const activeProducerIds = new Set(producerIds);
    for (const producerId of Array.from(this.states.keys())) {
      if (!activeProducerIds.has(producerId)) {
        this.remove(producerId, "producer_removed");
      }
    }
    for (const producerId of activeProducerIds) {
      this.refresh(producerId);
    }
  }

  reserveTransition(
    input: ReserveWebcamReceiverCapacityTransitionInput,
  ): WebcamReceiverCapacityTransitionReservation | null {
    if (this.closed) return null;
    const state = this.states.get(input.predecessorProducerId);
    const now = this.now();
    const offer = state?.replacementOffer;
    if (
      !state ||
      !state.eligible ||
      state.basis !== "simulcast-full-layer" ||
      state.transition ||
      state.reservedNonce ||
      !offer ||
      offer.nonce !== input.nonce ||
      now >= offer.expiresAt ||
      !bindingsMatch(offer, input)
    ) {
      return null;
    }

    const currentBinding =
      this.options.getTransitionBinding?.(input.predecessorProducerId) ?? null;
    const evaluation = this.safeEvaluate(input.predecessorProducerId);
    if (
      !currentBinding ||
      !bindingsMatch(currentBinding, input) ||
      !evaluation.qualified ||
      evaluation.basis !== "simulcast-full-layer" ||
      evaluation.ownerClientId !== input.ownerClientId
    ) {
      const reason =
        !currentBinding ||
        !bindingsMatch(currentBinding, input) ||
        evaluation.qualified
          ? "transition_invalid"
          : evaluation.reason;
      this.disqualify(
        input.predecessorProducerId,
        state,
        reason,
      );
      return null;
    }
    state.evaluation = evaluation;

    const reservation: WebcamReceiverCapacityTransitionReservation = {
      nonce: input.nonce,
      predecessorProducerId: input.predecessorProducerId,
      predecessorGeneration: state.generation,
      ownerClientId: input.ownerClientId,
      ownerSocketId: input.ownerSocketId,
      producerTransportId: input.producerTransportId,
      expiresAt: offer.expiresAt,
    };
    state.replacementOffer = null;
    state.reservedNonce = reservation.nonce;
    this.reservations.set(reservation.nonce, reservation);
    return reservation;
  }

  validateTransition(
    reservation: WebcamReceiverCapacityTransitionReservation,
  ): boolean {
    if (this.closed || this.reservations.get(reservation.nonce) !== reservation) {
      return false;
    }
    const state = this.states.get(reservation.predecessorProducerId);
    if (
      !state ||
      state.generation !== reservation.predecessorGeneration ||
      state.reservedNonce !== reservation.nonce ||
      !state.eligible ||
      state.basis !== "simulcast-full-layer" ||
      state.transition ||
      this.now() >= reservation.expiresAt
    ) {
      return false;
    }
    const binding =
      this.options.getTransitionBinding?.(
        reservation.predecessorProducerId,
      ) ?? null;
    const evaluation = this.safeEvaluate(reservation.predecessorProducerId);
    state.evaluation = evaluation;
    if (
      !binding ||
      !bindingsMatch(binding, reservation) ||
      !evaluation.qualified ||
      evaluation.basis !== "simulcast-full-layer" ||
      evaluation.ownerClientId !== reservation.ownerClientId
    ) {
      this.disqualify(
        reservation.predecessorProducerId,
        state,
        !binding || !bindingsMatch(binding, reservation) || evaluation.qualified
          ? "transition_invalid"
          : evaluation.reason,
      );
      return false;
    }
    this.validatedReservations.add(reservation.nonce);
    return true;
  }

  cancelTransition(
    reservation: WebcamReceiverCapacityTransitionReservation,
  ): void {
    if (this.reservations.get(reservation.nonce) !== reservation) return;
    this.reservations.delete(reservation.nonce);
    this.validatedReservations.delete(reservation.nonce);
    const state = this.states.get(reservation.predecessorProducerId);
    if (
      state?.generation === reservation.predecessorGeneration &&
      state.reservedNonce === reservation.nonce
    ) {
      state.reservedNonce = null;
    }
  }

  transferTransition(
    reservation: WebcamReceiverCapacityTransitionReservation,
    successorProducerId: string,
  ): boolean {
    if (
      this.closed ||
      this.reservations.get(reservation.nonce) !== reservation ||
      !this.validatedReservations.has(reservation.nonce) ||
      successorProducerId === reservation.predecessorProducerId ||
      this.now() >= reservation.expiresAt
    ) {
      return false;
    }
    const predecessor = this.states.get(reservation.predecessorProducerId);
    if (
      !predecessor ||
      predecessor.generation !== reservation.predecessorGeneration ||
      predecessor.reservedNonce !== reservation.nonce ||
      !predecessor.eligible ||
      predecessor.basis !== "simulcast-full-layer"
    ) {
      return false;
    }

    const now = this.now();
    this.reservations.delete(reservation.nonce);
    this.validatedReservations.delete(reservation.nonce);
    predecessor.reservedNonce = null;
    predecessor.replacementOffer = null;
    this.clearTimer(predecessor);
    predecessor.eligible = false;
    this.emit(
      reservation.predecessorProducerId,
      predecessor,
      "producer_replaced",
      0,
    );
    this.states.delete(reservation.predecessorProducerId);

    const successor = this.getOrCreateState(successorProducerId);
    this.clearTimer(successor);
    successor.ownerClientId = reservation.ownerClientId;
    successor.basis = "single-layer-transition";
    successor.evaluation = this.safeEvaluate(successorProducerId);
    successor.qualifyingSince = null;
    successor.eligible = true;
    successor.lastEmittedAt = now;
    successor.replacementOffer = null;
    successor.reservedNonce = null;
    successor.transition = {
      predecessorProducerId: reservation.predecessorProducerId,
      nonce: reservation.nonce,
      startedAt: now,
      consumerAttachDeadline:
        now + WEBCAM_RECEIVER_CAPACITY_TRANSITION_CONSUMER_GRACE_MS,
      hardDeadline: now + WEBCAM_RECEIVER_CAPACITY_TRANSITION_MAX_MS,
      consumerSeen: false,
    };
    this.emit(
      successorProducerId,
      successor,
      "transition_grace",
      WEBCAM_RECEIVER_CAPACITY_VALID_MS,
    );
    this.schedule(
      successorProducerId,
      successor,
      now + WEBCAM_RECEIVER_CAPACITY_RENEW_MS,
    );
    return true;
  }

  remove(
    producerId: string,
    reason: WebcamReceiverCapacityProofReason = "producer_removed",
  ): void {
    const state = this.states.get(producerId);
    if (!state) return;
    this.invalidateReservation(state);
    this.clearTimer(state);
    state.replacementOffer = null;
    if (!this.closed && state.eligible) {
      state.eligible = false;
      this.emit(producerId, state, reason, 0);
    }
    this.states.delete(producerId);
  }

  close(): void {
    if (this.closed) return;
    // Fence re-entrant refreshes before emitting final revocations.
    this.closed = true;
    this.reservations.clear();
    this.validatedReservations.clear();
    this.issuedNonces.clear();
    this.issuedNonceOrder.length = 0;
    for (const [producerId, state] of this.states) {
      this.clearTimer(state);
      state.replacementOffer = null;
      state.reservedNonce = null;
      if (state.eligible) {
        state.eligible = false;
        this.emit(producerId, state, "room_closed", 0);
      }
    }
    this.states.clear();
  }

  private refreshTransition(
    producerId: string,
    state: CoordinatorState,
    evaluation: WebcamReceiverCapacityEvaluation,
    now: number,
  ): void {
    const transition = state.transition;
    if (!transition) return;
    if (now >= transition.hardDeadline) {
      this.endTransition(producerId, state, "transition_timeout");
      return;
    }

    if (evaluation.qualified && evaluation.basis === "single-layer") {
      transition.consumerSeen = true;
      if (state.qualifyingSince === null) {
        state.qualifyingSince = now;
      }
      const qualificationDueAt =
        state.qualifyingSince + WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS;
      if (now >= qualificationDueAt) {
        state.basis = "single-layer";
        state.transition = null;
        state.eligible = true;
        state.lastEmittedAt = now;
        this.emit(
          producerId,
          state,
          "qualified",
          WEBCAM_RECEIVER_CAPACITY_VALID_MS,
        );
        this.schedule(
          producerId,
          state,
          now + WEBCAM_RECEIVER_CAPACITY_RENEW_MS,
        );
        return;
      }
      this.renewTransitionIfDue(producerId, state, now);
      this.schedule(
        producerId,
        state,
        Math.min(
          qualificationDueAt,
          transition.hardDeadline,
          (state.lastEmittedAt ?? now) +
            WEBCAM_RECEIVER_CAPACITY_RENEW_MS,
        ),
      );
      return;
    }

    const awaitingInitialConsumerSetup =
      !transition.consumerSeen &&
      ((evaluation.reason === "consumer_count" &&
        evaluation.consumerCount === 0) ||
        ((evaluation.reason === "consumer_paused" ||
          evaluation.reason === "consumer_score_low" ||
          evaluation.reason === "producer_score_low") &&
          evaluation.consumerCount === 1)) &&
      now < transition.consumerAttachDeadline;
    if (!awaitingInitialConsumerSetup) {
      this.endTransition(
        producerId,
        state,
        now >= transition.consumerAttachDeadline &&
          (evaluation.reason === "consumer_count" ||
            evaluation.reason === "consumer_paused" ||
            evaluation.reason === "consumer_score_low" ||
            evaluation.reason === "producer_score_low")
          ? "transition_timeout"
          : evaluation.reason,
      );
      return;
    }

    state.qualifyingSince = null;
    this.renewTransitionIfDue(producerId, state, now);
    this.schedule(
      producerId,
      state,
      Math.min(
        transition.consumerAttachDeadline,
        transition.hardDeadline,
        (state.lastEmittedAt ?? now) + WEBCAM_RECEIVER_CAPACITY_RENEW_MS,
      ),
    );
  }

  private renewTransitionIfDue(
    producerId: string,
    state: CoordinatorState,
    now: number,
  ): void {
    const renewalDueAt =
      (state.lastEmittedAt ?? Number.NEGATIVE_INFINITY) +
      WEBCAM_RECEIVER_CAPACITY_RENEW_MS;
    if (now < renewalDueAt) return;
    state.eligible = true;
    state.lastEmittedAt = now;
    this.emit(
      producerId,
      state,
      "transition_grace",
      WEBCAM_RECEIVER_CAPACITY_VALID_MS,
    );
  }

  private endTransition(
    producerId: string,
    state: CoordinatorState,
    reason: WebcamReceiverCapacityProofReason,
  ): void {
    this.clearTimer(state);
    state.qualifyingSince = null;
    state.transition = null;
    state.basis = "single-layer";
    state.replacementOffer = null;
    if (state.eligible) {
      state.eligible = false;
      this.emit(producerId, state, reason, 0);
    }
    state.lastEmittedAt = null;
  }

  private disqualify(
    producerId: string,
    state: CoordinatorState,
    reason: WebcamReceiverCapacityProofReason,
  ): void {
    state.qualifyingSince = null;
    state.lastEmittedAt = null;
    state.replacementOffer = null;
    this.invalidateReservation(state);
    this.clearTimer(state);
    if (state.eligible) {
      state.eligible = false;
      this.emit(producerId, state, reason, 0);
    }
  }

  private getOrCreateState(producerId: string): CoordinatorState {
    const existing = this.states.get(producerId);
    if (existing) return existing;
    const state: CoordinatorState = {
      generation: ++this.nextGeneration,
      timerToken: 0,
      timer: null,
      timerDueAt: null,
      revision: 0,
      qualifyingSince: null,
      eligible: false,
      lastEmittedAt: null,
      ownerClientId: null,
      basis: "simulcast-full-layer",
      evaluation: emptyEvaluation("producer_missing"),
      replacementOffer: null,
      reservedNonce: null,
      transition: null,
    };
    this.states.set(producerId, state);
    return state;
  }

  private safeEvaluate(producerId: string): WebcamReceiverCapacityEvaluation {
    try {
      return this.options.evaluate(producerId);
    } catch (error) {
      this.options.onError?.(error);
      return emptyEvaluation("evaluation_error");
    }
  }

  private ensureReplacementOffer(
    producerId: string,
    state: CoordinatorState,
  ): WebcamReceiverCapacityReplacementOffer | null {
    if (
      state.basis !== "simulcast-full-layer" ||
      state.transition ||
      state.reservedNonce
    ) {
      return null;
    }
    const binding = this.options.getTransitionBinding?.(producerId) ?? null;
    if (!binding || binding.ownerClientId !== state.ownerClientId) {
      state.replacementOffer = null;
      return null;
    }
    const now = this.now();
    const existing = state.replacementOffer;
    if (!existing || !bindingsMatch(existing, binding)) {
      const requestedNonce =
        this.options.createNonce?.() ?? randomBytes(16).toString("base64url");
      let nonce = requestedNonce;
      while (this.issuedNonces.has(nonce) || this.isNonceInUse(nonce)) {
        nonce = randomBytes(16).toString("base64url");
      }
      this.rememberIssuedNonce(nonce);
      state.replacementOffer = {
        ...binding,
        nonce,
        expiresAt: now + WEBCAM_RECEIVER_CAPACITY_VALID_MS,
      };
    } else {
      existing.expiresAt = now + WEBCAM_RECEIVER_CAPACITY_VALID_MS;
    }
    const offer = state.replacementOffer;
    if (!offer) return null;
    return {
      nonce: offer.nonce,
      validForMs: WEBCAM_RECEIVER_CAPACITY_VALID_MS,
      target: "vp8-single-layer",
    };
  }

  private invalidateReservation(state: CoordinatorState): void {
    if (!state.reservedNonce) return;
    this.reservations.delete(state.reservedNonce);
    this.validatedReservations.delete(state.reservedNonce);
    state.reservedNonce = null;
  }

  private isNonceInUse(nonce: string): boolean {
    if (
      this.reservations.has(nonce) ||
      this.validatedReservations.has(nonce)
    ) {
      return true;
    }
    for (const state of this.states.values()) {
      if (
        state.replacementOffer?.nonce === nonce ||
        state.reservedNonce === nonce ||
        state.transition?.nonce === nonce
      ) {
        return true;
      }
    }
    return false;
  }

  private rememberIssuedNonce(nonce: string): void {
    this.issuedNonces.add(nonce);
    this.issuedNonceOrder.push(nonce);
    while (
      this.issuedNonceOrder.length >
      WEBCAM_RECEIVER_CAPACITY_NONCE_HISTORY_MAX
    ) {
      const oldest = this.issuedNonceOrder.shift();
      if (oldest !== undefined) {
        this.issuedNonces.delete(oldest);
      }
    }
  }

  private expireReservationIfNeeded(
    state: CoordinatorState,
    now: number,
  ): void {
    if (!state.reservedNonce) return;
    const reservation = this.reservations.get(state.reservedNonce);
    if (reservation && now < reservation.expiresAt) return;
    if (reservation) {
      this.reservations.delete(reservation.nonce);
      this.validatedReservations.delete(reservation.nonce);
    }
    state.reservedNonce = null;
  }

  private schedule(
    producerId: string,
    state: CoordinatorState,
    dueAt: number,
  ): void {
    if (
      state.timer &&
      state.timerDueAt !== null &&
      state.timerDueAt <= dueAt
    ) {
      return;
    }
    this.clearTimer(state);
    const timerToken = ++state.timerToken;
    const generation = state.generation;
    const now = this.now();
    state.timerDueAt = dueAt;
    state.timer = setTimeout(() => {
      const current = this.states.get(producerId);
      if (
        this.closed ||
        current !== state ||
        current.generation !== generation ||
        current.timerToken !== timerToken
      ) {
        return;
      }
      current.timer = null;
      current.timerDueAt = null;
      this.refresh(producerId);
    }, Math.max(0, dueAt - now));
    state.timer.unref?.();
  }

  private clearTimer(state: CoordinatorState): void {
    state.timerToken += 1;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = null;
    state.timerDueAt = null;
  }

  private emit(
    producerId: string,
    state: CoordinatorState,
    reason: WebcamReceiverCapacityProofReason,
    validForMs: number,
  ): void {
    const ownerClientId = state.ownerClientId;
    if (!ownerClientId) return;
    state.revision += 1;
    const evaluation = state.evaluation;
    const eligible = validForMs > 0;
    const replacementOffer =
      eligible && state.basis === "simulcast-full-layer"
        ? this.ensureReplacementOffer(producerId, state)
        : null;
    try {
      this.options.emit(ownerClientId, {
        roomId: this.options.roomId,
        producerId,
        revision: state.revision,
        eligible,
        validForMs: Math.min(
          WEBCAM_RECEIVER_CAPACITY_VALID_MS,
          Math.max(0, validForMs),
        ),
        reason,
        basis: state.basis,
        ...(replacementOffer ? { replacementOffer } : {}),
        ...(state.transition
          ? {
              replacesProducerId: state.transition.predecessorProducerId,
              transitionNonce: state.transition.nonce,
            }
          : {}),
        ...(evaluation.maxSpatialLayer === undefined
          ? {}
          : { maxSpatialLayer: evaluation.maxSpatialLayer }),
        ...(evaluation.maxTemporalLayer === undefined
          ? {}
          : { maxTemporalLayer: evaluation.maxTemporalLayer }),
        ...(evaluation.currentSpatialLayer === undefined
          ? {}
          : { currentSpatialLayer: evaluation.currentSpatialLayer }),
        ...(evaluation.currentTemporalLayer === undefined
          ? {}
          : { currentTemporalLayer: evaluation.currentTemporalLayer }),
        ...(evaluation.score === undefined ? {} : { score: evaluation.score }),
      });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

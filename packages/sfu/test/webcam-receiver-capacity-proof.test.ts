import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Consumer, Producer, Router } from "mediasoup/types";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import {
  evaluateWebcamReceiverCapacity,
  WEBCAM_RECEIVER_CAPACITY_NONCE_HISTORY_MAX,
  WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS,
  WEBCAM_RECEIVER_CAPACITY_RENEW_MS,
  WEBCAM_RECEIVER_CAPACITY_TRANSITION_CONSUMER_GRACE_MS,
  WEBCAM_RECEIVER_CAPACITY_VALID_MS,
  WebcamReceiverCapacityProofCoordinator,
  type WebcamReceiverCapacityEvaluation,
  type WebcamReceiverCapacityEvaluationInput,
} from "../server/webcamReceiverCapacityProof.js";
import type { WebcamReceiverCapacityProofNotification } from "../types.js";

const makeProducer = (
  overrides: Record<string, unknown> = {},
): Producer =>
  ({
    id: "producer",
    kind: "video",
    type: "simulcast",
    appData: { type: "webcam" },
    closed: false,
    paused: false,
    score: [{ encodingIdx: 0, ssrc: 1, score: 10 }],
    rtpParameters: {
      codecs: [{ mimeType: "video/VP8" }],
      encodings: [
        { rid: "q", scalabilityMode: "L1T3" },
        { rid: "h", scalabilityMode: "L1T3" },
        { rid: "f", scalabilityMode: "L1T3" },
      ],
    },
    ...overrides,
  }) as unknown as Producer;

const makeConsumer = (
  overrides: Record<string, unknown> = {},
): Consumer =>
  ({
    id: "consumer",
    producerId: "producer",
    kind: "video",
    type: "simulcast",
    closed: false,
    paused: false,
    producerPaused: false,
    preferredLayers: { spatialLayer: 2, temporalLayer: 2 },
    currentLayers: { spatialLayer: 2, temporalLayer: 2 },
    score: {
      score: 10,
      producerScore: 10,
      // Lower streams become inactive during the optimization. Only the
      // selected full-layer producer score must remain healthy.
      producerScores: [0, 0, 10],
    },
    ...overrides,
  }) as unknown as Consumer;

const makeEvaluationInput = (
  options: {
    producer?: Producer | null;
    consumer?: Consumer | null;
    producerIsCurrent?: boolean;
    receiverObserver?: boolean;
    includeThirdClient?: boolean;
  } = {},
): WebcamReceiverCapacityEvaluationInput => ({
  producerId: "producer",
  ownerClientId: "owner",
  producer: options.producer === undefined ? makeProducer() : options.producer,
  producerIsCurrent: options.producerIsCurrent ?? true,
  clients: [
    { id: "owner", isObserver: false, consumer: null },
    {
      id: "receiver",
      isObserver: options.receiverObserver ?? false,
      consumer:
        options.consumer === undefined ? makeConsumer() : options.consumer,
    },
    ...(options.includeThirdClient
      ? [{ id: "joining", isObserver: false, consumer: null }]
      : []),
  ],
});

const qualifiedEvaluation = (): WebcamReceiverCapacityEvaluation => ({
  qualified: true,
  reason: "qualified",
  ownerClientId: "owner",
  basis: "simulcast-full-layer",
  consumerCount: 1,
  maxSpatialLayer: 2,
  maxTemporalLayer: 2,
  currentSpatialLayer: 2,
  currentTemporalLayer: 2,
  score: 10,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("webcam receiver capacity evaluator", () => {
  it("qualifies one healthy full-layer VP8 receiver and tolerates inactive lower scores", () => {
    expect(evaluateWebcamReceiverCapacity(makeEvaluationInput())).toEqual({
      qualified: true,
      reason: "qualified",
      ownerClientId: "owner",
      basis: "simulcast-full-layer",
      consumerCount: 1,
      maxSpatialLayer: 2,
      maxTemporalLayer: 2,
      currentSpatialLayer: 2,
      currentTemporalLayer: 2,
      score: 10,
    });
  });

  it("allows an absent preferred layer only when mediasoup is currently on the full layer", () => {
    const consumer = makeConsumer({ preferredLayers: undefined });
    expect(
      evaluateWebcamReceiverCapacity(
        makeEvaluationInput({ consumer }),
      ).qualified,
    ).toBe(true);
  });

  it("qualifies a healthy VP8 simple producer without pretending it has selectable layers", () => {
    const producer = makeProducer({
      type: "simple",
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8" }],
        encodings: [{ ssrc: 1 }],
      },
      score: [{ encodingIdx: 0, ssrc: 1, score: 10 }],
    });
    const consumer = makeConsumer({
      type: "simple",
      preferredLayers: undefined,
      currentLayers: undefined,
      score: { score: 10, producerScore: 10, producerScores: [] },
    });

    expect(
      evaluateWebcamReceiverCapacity(
        makeEvaluationInput({ producer, consumer }),
      ),
    ).toEqual({
      qualified: true,
      reason: "qualified",
      ownerClientId: "owner",
      basis: "single-layer",
      consumerCount: 1,
      score: 10,
    });
  });

  it.each([
    [
      "a non-VP8 simple producer",
      makeProducer({
        type: "simple",
        rtpParameters: {
          codecs: [{ mimeType: "video/H264" }],
          encodings: [{ ssrc: 1 }],
        },
      }),
      makeConsumer({ type: "simple" }),
      "producer_not_vp8_single_layer",
    ],
    [
      "a non-simple consumer",
      makeProducer({
        type: "simple",
        rtpParameters: {
          codecs: [{ mimeType: "video/VP8" }],
          encodings: [{ ssrc: 1 }],
        },
      }),
      makeConsumer({ type: "simulcast" }),
      "consumer_not_simple",
    ],
    [
      "a low single producer score",
      makeProducer({
        type: "simple",
        rtpParameters: {
          codecs: [{ mimeType: "video/VP8" }],
          encodings: [{ ssrc: 1 }],
        },
        score: [{ encodingIdx: 0, ssrc: 1, score: 8 }],
      }),
      makeConsumer({
        type: "simple",
        score: { score: 10, producerScore: 10, producerScores: [] },
      }),
      "producer_score_low",
    ],
  ])("rejects %s", (_label, producer, consumer, reason) => {
    expect(
      evaluateWebcamReceiverCapacity(
        makeEvaluationInput({ producer, consumer }),
      ).reason,
    ).toBe(reason);
  });

  it.each([
    [
      "an owner disconnect",
      { ownerConnected: false },
      "owner_disconnected",
    ],
    [
      "a receiver disconnect",
      { receiverConnected: false },
      "receiver_disconnected",
    ],
    ["an active screen share", { screenShareActive: true }, "screen_share_active"],
    ["room-wide low quality", { roomQuality: "low" }, "room_quality_low"],
  ])("rejects %s", (_label, patch, reason) => {
    const input = makeEvaluationInput();
    input.clients = input.clients.map((client) => ({
      ...client,
      connected:
        client.id === "owner"
          ? (patch as { ownerConnected?: boolean }).ownerConnected
          : (patch as { receiverConnected?: boolean }).receiverConnected,
    }));
    input.screenShareActive = (patch as { screenShareActive?: boolean })
      .screenShareActive;
    input.roomQuality = (patch as { roomQuality?: "low" }).roomQuality;
    expect(evaluateWebcamReceiverCapacity(input).reason).toBe(reason);
  });

  it.each([
    [
      "a connected third client before it consumes",
      makeEvaluationInput({ includeThirdClient: true }),
      "receiver_count",
    ],
    [
      "an observer receiver",
      makeEvaluationInput({ receiverObserver: true }),
      "receiver_observer",
    ],
    [
      "a stale producer",
      makeEvaluationInput({ producerIsCurrent: false }),
      "producer_not_current",
    ],
    [
      "a non-VP8 producer",
      makeEvaluationInput({
        producer: makeProducer({
          rtpParameters: {
            codecs: [{ mimeType: "video/H264" }],
            encodings: [
              { rid: "q", scalabilityMode: "L1T3" },
              { rid: "h", scalabilityMode: "L1T3" },
              { rid: "f", scalabilityMode: "L1T3" },
            ],
          },
        }),
      }),
      "producer_not_vp8_simulcast",
    ],
    [
      "a paused producer",
      makeEvaluationInput({ producer: makeProducer({ paused: true }) }),
      "producer_paused",
    ],
    [
      "a simple consumer",
      makeEvaluationInput({ consumer: makeConsumer({ type: "simple" }) }),
      "consumer_not_simulcast",
    ],
    [
      "a paused consumer",
      makeEvaluationInput({ consumer: makeConsumer({ paused: true }) }),
      "consumer_paused",
    ],
    [
      "a producer-paused consumer",
      makeEvaluationInput({ consumer: makeConsumer({ producerPaused: true }) }),
      "consumer_paused",
    ],
    [
      "a lower current spatial layer",
      makeEvaluationInput({
        consumer: makeConsumer({
          currentLayers: { spatialLayer: 1, temporalLayer: 2 },
        }),
      }),
      "consumer_not_full_layer",
    ],
    [
      "a lower current temporal layer",
      makeEvaluationInput({
        consumer: makeConsumer({
          currentLayers: { spatialLayer: 2, temporalLayer: 1 },
        }),
      }),
      "consumer_not_full_layer",
    ],
    [
      "a lower preferred layer",
      makeEvaluationInput({
        consumer: makeConsumer({
          preferredLayers: { spatialLayer: 1, temporalLayer: 2 },
        }),
      }),
      "consumer_prefers_lower_layer",
    ],
    [
      "a low consumer score",
      makeEvaluationInput({
        consumer: makeConsumer({
          score: { score: 8, producerScore: 10, producerScores: [0, 0, 10] },
        }),
      }),
      "consumer_score_low",
    ],
    [
      "a low selected producer score",
      makeEvaluationInput({
        consumer: makeConsumer({
          score: { score: 10, producerScore: 10, producerScores: [10, 10, 8] },
        }),
      }),
      "consumer_score_low",
    ],
  ])("rejects %s", (_label, input, reason) => {
    expect(evaluateWebcamReceiverCapacity(input).reason).toBe(reason);
  });
});

describe("webcam receiver capacity proof coordinator", () => {
  it("requires six continuous seconds, renews every two, and revokes immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let evaluation = qualifiedEvaluation();
    const emitted: WebcamReceiverCapacityProofNotification[] = [];
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: () => evaluation,
      emit: (_ownerClientId, proof) => emitted.push(proof),
    });

    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(
      WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS - 1,
    );
    expect(emitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([
      expect.objectContaining({
        eligible: true,
        revision: 1,
        validForMs: WEBCAM_RECEIVER_CAPACITY_VALID_MS,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_RENEW_MS);
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({ eligible: true, revision: 2 }),
    );

    evaluation = {
      ...evaluation,
      qualified: false,
      reason: "consumer_score_low",
      score: 8,
    };
    coordinator.refresh("producer");
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        eligible: false,
        revision: 3,
        validForMs: 0,
        reason: "consumer_score_low",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    coordinator.close();
  });

  it("does not let frequent healthy events postpone the qualification deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const emit = vi.fn();
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: qualifiedEvaluation,
      emit,
    });

    coordinator.refresh("producer");
    for (let second = 1; second < 6; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      coordinator.refresh("producer");
    }
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emit).toHaveBeenCalledOnce();
    coordinator.close();
  });

  it("prevents a removed producer timer from granting a replacement generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const emit = vi.fn();
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: qualifiedEvaluation,
      emit,
    });

    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(3_000);
    coordinator.remove("producer");
    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(emit).toHaveBeenCalledOnce();
    coordinator.close();
  });

  it("clears renewal timers and emits a final fail-closed revoke on room close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const emitted: WebcamReceiverCapacityProofNotification[] = [];
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: qualifiedEvaluation,
      emit: (_ownerClientId, proof) => emitted.push(proof),
    });
    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);

    coordinator.close();
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        eligible: false,
        validForMs: 0,
        reason: "room_closed",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a one-use bound nonce and rejects replay or a topology race", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let evaluation = qualifiedEvaluation();
    const emitted: WebcamReceiverCapacityProofNotification[] = [];
    const binding = {
      ownerClientId: "owner",
      ownerSocketId: "socket-a",
      producerTransportId: "transport-a",
    };
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: () => evaluation,
      emit: (_ownerClientId, proof) => emitted.push(proof),
      getTransitionBinding: () => binding,
      createNonce: () => "nonce_nonce_nonce_nonce_1",
    });
    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);
    const offer = emitted.at(-1)?.replacementOffer;
    expect(offer).toEqual({
      nonce: "nonce_nonce_nonce_nonce_1",
      validForMs: WEBCAM_RECEIVER_CAPACITY_VALID_MS,
      target: "vp8-single-layer",
    });

    expect(
      coordinator.reserveTransition({
        predecessorProducerId: "producer",
        nonce: offer!.nonce,
        ...binding,
        ownerSocketId: "wrong-socket",
      }),
    ).toBeNull();
    const reservation = coordinator.reserveTransition({
      predecessorProducerId: "producer",
      nonce: offer!.nonce,
      ...binding,
    });
    expect(reservation).not.toBeNull();
    expect(
      coordinator.reserveTransition({
        predecessorProducerId: "producer",
        nonce: offer!.nonce,
        ...binding,
      }),
    ).toBeNull();
    expect(
      coordinator.transferTransition(reservation!, "successor"),
    ).toBe(false);

    evaluation = {
      qualified: false,
      reason: "receiver_count",
      ownerClientId: "owner",
      basis: "simulcast-full-layer",
    };
    coordinator.refresh("producer");
    expect(coordinator.validateTransition(reservation!)).toBe(false);
    expect(
      coordinator.transferTransition(reservation!, "successor"),
    ).toBe(false);
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        producerId: "producer",
        eligible: false,
        reason: "receiver_count",
      }),
    );
    coordinator.close();
  });

  it("bridges one successor through setup, then earns a steady simple proof", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const evaluations = new Map<string, WebcamReceiverCapacityEvaluation>([
      ["producer", qualifiedEvaluation()],
      [
        "successor",
        {
          qualified: false,
          reason: "consumer_count",
          ownerClientId: "owner",
          basis: "single-layer",
          consumerCount: 0,
        },
      ],
    ]);
    const emitted: WebcamReceiverCapacityProofNotification[] = [];
    const binding = {
      ownerClientId: "owner",
      ownerSocketId: "socket-a",
      producerTransportId: "transport-a",
    };
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: (producerId) =>
        evaluations.get(producerId) ?? {
          qualified: false,
          reason: "producer_missing",
          ownerClientId: null,
        },
      emit: (_ownerClientId, proof) => emitted.push(proof),
      getTransitionBinding: (producerId) =>
        producerId === "producer" ? binding : null,
      createNonce: () => "nonce_nonce_nonce_nonce_2",
    });
    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);
    const nonce = emitted.at(-1)!.replacementOffer!.nonce;
    const reservation = coordinator.reserveTransition({
      predecessorProducerId: "producer",
      nonce,
      ...binding,
    });
    expect(reservation).not.toBeNull();
    expect(coordinator.validateTransition(reservation!)).toBe(true);
    expect(
      coordinator.transferTransition(reservation!, "producer"),
    ).toBe(false);
    expect(
      coordinator.transferTransition(reservation!, "successor"),
    ).toBe(true);
    expect(emitted.slice(-2)).toEqual([
      expect.objectContaining({
        producerId: "producer",
        eligible: false,
        reason: "producer_replaced",
      }),
      expect.objectContaining({
        producerId: "successor",
        eligible: true,
        reason: "transition_grace",
        basis: "single-layer-transition",
        replacesProducerId: "producer",
        transitionNonce: nonce,
      }),
    ]);

    evaluations.set("successor", {
      qualified: false,
      reason: "consumer_paused",
      ownerClientId: "owner",
      basis: "single-layer",
      consumerCount: 1,
    });
    coordinator.refresh("successor");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        producerId: "successor",
        eligible: true,
        basis: "single-layer-transition",
      }),
    );

    evaluations.set("successor", {
      qualified: true,
      reason: "qualified",
      ownerClientId: "owner",
      basis: "single-layer",
      consumerCount: 1,
      score: 10,
    });
    coordinator.refresh("successor");
    await vi.advanceTimersByTimeAsync(
      WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS - 1,
    );
    expect(emitted.at(-1)?.basis).toBe("single-layer-transition");
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        producerId: "successor",
        eligible: true,
        reason: "qualified",
        basis: "single-layer",
      }),
    );
    expect(emitted.at(-1)?.replacementOffer).toBeUndefined();
    evaluations.set("successor", {
      qualified: false,
      reason: "consumer_paused",
      ownerClientId: "owner",
      basis: "single-layer",
      consumerCount: 1,
    });
    coordinator.refresh("successor");
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        producerId: "successor",
        eligible: false,
        reason: "consumer_paused",
        basis: "single-layer",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    coordinator.close();
  });

  it("revokes transition authority when the first consumer misses its setup deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pending: WebcamReceiverCapacityEvaluation = {
      qualified: false,
      reason: "consumer_count",
      ownerClientId: "owner",
      basis: "single-layer",
      consumerCount: 0,
    };
    const evaluations = new Map<string, WebcamReceiverCapacityEvaluation>([
      ["producer", qualifiedEvaluation()],
      ["successor", pending],
    ]);
    const emitted: WebcamReceiverCapacityProofNotification[] = [];
    const binding = {
      ownerClientId: "owner",
      ownerSocketId: "socket-a",
      producerTransportId: "transport-a",
    };
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: (producerId) => evaluations.get(producerId) ?? pending,
      emit: (_ownerClientId, proof) => emitted.push(proof),
      getTransitionBinding: () => binding,
      createNonce: () => "nonce_nonce_nonce_nonce_3",
    });
    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);
    const reservation = coordinator.reserveTransition({
      predecessorProducerId: "producer",
      nonce: emitted.at(-1)!.replacementOffer!.nonce,
      ...binding,
    });
    expect(coordinator.validateTransition(reservation!)).toBe(true);
    expect(coordinator.transferTransition(reservation!, "successor")).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(
      WEBCAM_RECEIVER_CAPACITY_TRANSITION_CONSUMER_GRACE_MS,
    );
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        producerId: "successor",
        eligible: false,
        reason: "transition_timeout",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    coordinator.close();
  });

  it("burns inherited authority immediately on a successor score drop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const evaluations = new Map<string, WebcamReceiverCapacityEvaluation>([
      ["producer", qualifiedEvaluation()],
      [
        "successor",
        {
          qualified: false,
          reason: "consumer_count",
          ownerClientId: "owner",
          basis: "single-layer",
          consumerCount: 0,
        },
      ],
    ]);
    const emitted: WebcamReceiverCapacityProofNotification[] = [];
    const binding = {
      ownerClientId: "owner",
      ownerSocketId: "socket-a",
      producerTransportId: "transport-a",
    };
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: (producerId) => evaluations.get(producerId)!,
      emit: (_ownerClientId, proof) => emitted.push(proof),
      getTransitionBinding: () => binding,
      createNonce: () => "nonce_nonce_nonce_nonce_5",
    });
    coordinator.refresh("producer");
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);
    const reservation = coordinator.reserveTransition({
      predecessorProducerId: "producer",
      nonce: emitted.at(-1)!.replacementOffer!.nonce,
      ...binding,
    });
    expect(coordinator.validateTransition(reservation!)).toBe(true);
    expect(coordinator.transferTransition(reservation!, "successor")).toBe(
      true,
    );
    evaluations.set("successor", {
      qualified: true,
      reason: "qualified",
      ownerClientId: "owner",
      basis: "single-layer",
      consumerCount: 1,
      score: 10,
    });
    coordinator.refresh("successor");
    await vi.advanceTimersByTimeAsync(1_000);
    evaluations.set("successor", {
      qualified: false,
      reason: "consumer_score_low",
      ownerClientId: "owner",
      basis: "single-layer",
      consumerCount: 1,
      score: 8,
    });
    coordinator.refresh("successor");
    expect(emitted.at(-1)).toEqual(
      expect.objectContaining({
        producerId: "successor",
        eligible: false,
        basis: "single-layer",
        reason: "consumer_score_low",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    coordinator.close();
  });

  it("bounds recent nonce history under long-room offer churn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let nextNonce = 0;
    const emit = vi.fn();
    const coordinator = new WebcamReceiverCapacityProofCoordinator({
      roomId: "room",
      evaluate: qualifiedEvaluation,
      emit,
      getTransitionBinding: (producerId) => ({
        ownerClientId: "owner",
        ownerSocketId: "socket-a",
        producerTransportId: `transport-${producerId}`,
      }),
      createNonce: () => `nonce_nonce_nonce_${nextNonce++}`,
    });
    const producerCount =
      WEBCAM_RECEIVER_CAPACITY_NONCE_HISTORY_MAX + 8;
    for (let index = 0; index < producerCount; index += 1) {
      coordinator.refresh(`producer-${index}`);
    }
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);
    expect(emit).toHaveBeenCalledTimes(producerCount);

    const internals = coordinator as unknown as {
      issuedNonces: Set<string>;
      issuedNonceOrder: string[];
    };
    expect(internals.issuedNonces.size).toBe(
      WEBCAM_RECEIVER_CAPACITY_NONCE_HISTORY_MAX,
    );
    expect(internals.issuedNonceOrder).toHaveLength(
      WEBCAM_RECEIVER_CAPACITY_NONCE_HISTORY_MAX,
    );
    coordinator.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

const fakeRouter = (): Router => {
  const state = { closed: false };
  return {
    get closed() {
      return state.closed;
    },
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close() {
      state.closed = true;
    },
  } as unknown as Router;
};

const makeEventProducer = (
  overrides: Record<string, unknown> = {},
): Producer => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const producer = makeProducer({
    ...overrides,
    on: events.on.bind(events),
    observer,
  }) as Producer & { closed: boolean; close: () => void };
  producer.close = () => {
    if (producer.closed) return;
    producer.closed = true;
    observer.emit("close");
  };
  return producer;
};

const makeEventConsumer = (
  overrides: Record<string, unknown> = {},
): Consumer => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const consumer = makeConsumer({
    ...overrides,
    priority: 100,
    on: events.on.bind(events),
    observer,
  }) as Consumer & { closed: boolean; close: () => void };
  consumer.close = () => {
    if (consumer.closed) return;
    consumer.closed = true;
    observer.emit("close");
  };
  return consumer;
};

describe("Room webcam receiver capacity proof integration", () => {
  it("grants only to the producer owner and revokes as soon as a third client connects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ownerEmit = vi.fn();
    const room = new Room({
      id: "room",
      clientId: "instance",
      router: fakeRouter(),
      workerPid: null,
    });
    const owner = new Client({
      id: "owner",
      socket: { emit: ownerEmit } as never,
    });
    const receiver = new Client({
      id: "receiver",
      socket: { emit: vi.fn() } as never,
    });
    const ownerTransport = {
      id: "owner-transport",
      closed: false,
      iceState: "connected",
      dtlsState: "connected",
      close: vi.fn(),
    };
    const receiverTransport = {
      id: "receiver-transport",
      closed: false,
      iceState: "connected",
      dtlsState: "connected",
      close: vi.fn(),
    };
    owner.producerTransport = ownerTransport as never;
    receiver.consumerTransport = receiverTransport as never;
    room.addClient(owner);
    room.addClient(receiver);

    const producer = makeEventProducer();
    owner.addProducer(producer);
    room.indexClientProducer(owner.id, producer, "webcam");
    receiver.addConsumer(makeEventConsumer(), {
      producerUserId: owner.id,
      type: "webcam",
    });
    room.refreshWebcamReceiverCapacityProof(producer.id);
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);

    const proofs = () =>
      ownerEmit.mock.calls
        .filter(([event]) => event === "webcamReceiverCapacityProof")
        .map(([, proof]) => proof as WebcamReceiverCapacityProofNotification);
    expect(proofs()).toEqual([
      expect.objectContaining({
        roomId: "room",
        producerId: producer.id,
        eligible: true,
      }),
    ]);

    receiverTransport.iceState = "new";
    room.refreshWebcamReceiverCapacityProof(producer.id);
    expect(proofs().at(-1)).toEqual(
      expect.objectContaining({
        producerId: producer.id,
        eligible: false,
        reason: "transport_disconnected",
      }),
    );
    receiverTransport.iceState = "connected";
    room.refreshWebcamReceiverCapacityProof(producer.id);
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);
    expect(proofs().at(-1)).toEqual(
      expect.objectContaining({
        producerId: producer.id,
        eligible: true,
      }),
    );

    receiverTransport.dtlsState = "connecting";
    room.refreshWebcamReceiverCapacityProof(producer.id);
    expect(proofs().at(-1)).toEqual(
      expect.objectContaining({
        producerId: producer.id,
        eligible: false,
        reason: "transport_disconnected",
      }),
    );
    receiverTransport.dtlsState = "connected";
    room.refreshWebcamReceiverCapacityProof(producer.id);
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);

    room.addClient(
      new Client({
        id: "joining-before-consume",
        socket: { emit: vi.fn() } as never,
      }),
    );
    expect(proofs().at(-1)).toEqual(
      expect.objectContaining({
        producerId: producer.id,
        eligible: false,
        reason: "receiver_count",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    room.close();
  });

  it("atomically transfers a qualified predecessor to one exact simple successor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ownerEmit = vi.fn();
    const room = new Room({
      id: "room",
      clientId: "instance",
      router: fakeRouter(),
      workerPid: null,
    });
    const owner = new Client({
      id: "owner",
      socket: {
        id: "owner-socket",
        connected: true,
        emit: ownerEmit,
      } as never,
    });
    const receiver = new Client({
      id: "receiver",
      socket: {
        id: "receiver-socket",
        connected: true,
        emit: vi.fn(),
      } as never,
    });
    owner.producerTransport = {
      id: "producer-transport",
      closed: false,
      iceState: "connected",
      dtlsState: "connected",
      close: vi.fn(),
    } as never;
    receiver.consumerTransport = {
      id: "consumer-transport",
      closed: false,
      iceState: "connected",
      dtlsState: "connected",
      close: vi.fn(),
    } as never;
    room.addClient(owner);
    room.addClient(receiver);

    const predecessor = makeEventProducer();
    owner.addProducer(predecessor);
    room.indexClientProducer(owner.id, predecessor, "webcam");
    receiver.addConsumer(makeEventConsumer(), {
      producerUserId: owner.id,
      type: "webcam",
    });
    room.refreshWebcamReceiverCapacityProof(predecessor.id);
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);

    const proofs = () =>
      ownerEmit.mock.calls
        .filter(([event]) => event === "webcamReceiverCapacityProof")
        .map(([, proof]) => proof as WebcamReceiverCapacityProofNotification);
    const offer = proofs().at(-1)!.replacementOffer!;
    expect(offer.target).toBe("vp8-single-layer");
    const reservation = room.reserveWebcamReceiverCapacityTransition(
      owner.id,
      predecessor.id,
      offer.nonce,
    );
    expect(reservation).not.toBeNull();
    expect(
      room.reserveWebcamReceiverCapacityTransition(
        owner.id,
        predecessor.id,
        offer.nonce,
      ),
    ).toBeNull();

    const successor = makeEventProducer({
      id: "successor",
      type: "simple",
      rtpParameters: {
        codecs: [{ mimeType: "video/VP8" }],
        encodings: [{ ssrc: 2 }],
      },
      score: [{ encodingIdx: 0, ssrc: 2, score: 0 }],
    });
    expect(
      room.commitWebcamReceiverCapacityTransition(
        owner.id,
        successor,
        reservation!,
      ),
    ).toBe(predecessor);
    expect(owner.getProducer("video", "webcam")).toBe(successor);
    expect(proofs().slice(-2)).toEqual([
      expect.objectContaining({
        producerId: predecessor.id,
        eligible: false,
        reason: "producer_replaced",
      }),
      expect.objectContaining({
        producerId: successor.id,
        eligible: true,
        basis: "single-layer-transition",
        replacesProducerId: predecessor.id,
        transitionNonce: offer.nonce,
      }),
    ]);

    const successorConsumer = makeEventConsumer({
      id: "successor-consumer",
      producerId: successor.id,
      type: "simple",
      paused: true,
      preferredLayers: undefined,
      currentLayers: undefined,
      score: { score: 0, producerScore: 0, producerScores: [] },
    });
    receiver.addConsumer(
      successorConsumer,
      { producerUserId: owner.id, type: "webcam" },
    );
    room.refreshWebcamReceiverCapacityProof(successor.id);
    expect(
      proofs().some(
        (proof) => proof.producerId === successor.id && !proof.eligible,
      ),
    ).toBe(false);

    const mutableConsumer = successorConsumer as unknown as {
      paused: boolean;
      score: { score: number; producerScore: number; producerScores: number[] };
    };
    mutableConsumer.paused = false;
    room.refreshWebcamReceiverCapacityProof(successor.id);
    expect(
      proofs().some(
        (proof) => proof.producerId === successor.id && !proof.eligible,
      ),
    ).toBe(false);

    mutableConsumer.score = {
      score: 10,
      producerScore: 10,
      producerScores: [],
    };
    room.refreshWebcamReceiverCapacityProof(successor.id);
    expect(
      proofs().some(
        (proof) => proof.producerId === successor.id && !proof.eligible,
      ),
    ).toBe(false);

    (successor as unknown as { score: Array<{ score: number }> }).score = [
      { score: 10 },
    ];
    room.refreshWebcamReceiverCapacityProof(successor.id);
    await vi.advanceTimersByTimeAsync(WEBCAM_RECEIVER_CAPACITY_QUALIFY_MS);
    expect(proofs().at(-1)).toEqual(
      expect.objectContaining({
        producerId: successor.id,
        eligible: true,
        basis: "single-layer",
        reason: "qualified",
      }),
    );
    expect(proofs().at(-1)?.replacementOffer).toBeUndefined();
    room.close();
  });
});

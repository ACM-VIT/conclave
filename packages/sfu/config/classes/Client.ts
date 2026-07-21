import type { Socket } from "socket.io";
import type {
  WebRtcTransport,
  Producer,
  Consumer,
  ConsumerLayers,
  ConsumerScore,
  MediaKind,
} from "mediasoup/types";
import {
  normalizeClientMediaCapabilities,
  type ClientMediaCapabilities,
  type NormalizedWebcamCodecCapabilities,
} from "../../server/webcamCodecPolicy.js";

export interface ClientOptions {
  id: string;
  socket: Socket;
  mode?: ClientMode;
  mediaCapabilities?: ClientMediaCapabilities;
}

export type ProducerType = "webcam" | "screen";
export type ClientMode =
  | "participant"
  | "webinar_attendee";

export type ProducerKey = `${MediaKind}-${ProducerType}`;

export type ConsumerTelemetrySnapshot = {
  consumerId: string;
  producerId: string;
  producerUserId?: string;
  kind: MediaKind;
  type?: ProducerType;
  paused: boolean;
  producerPaused: boolean;
  priority: number;
  score: ConsumerScore;
  preferredLayers?: ConsumerLayers;
  currentLayers?: ConsumerLayers;
  createdAt: number;
  updatedAt: number;
};

type ConsumerState = ConsumerTelemetrySnapshot;

type ConsumerGenerationMetadata = {
  producerUserId?: string;
  type?: ProducerType;
  createdAt: number;
};

export type DisplacedConsumerGeneration = {
  consumer: Consumer;
  retirementRevision: number;
};

export type ConsumerHandoffKey = {
  requestId: string;
  producerId: string;
  predecessorConsumerId: string;
};

export type ConsumerHandoffCompletion =
  | { ok: true; consumer: Consumer }
  | { ok: false; error: string; code?: string };

export type ConsumerHandoffReservation = {
  isOwner: boolean;
  completion: Promise<ConsumerHandoffCompletion>;
};

export type ConsumerHandoffAbortResult = {
  status: "aborted" | "already_aborted" | "absent";
  successorConsumerId?: string;
  predecessorRestored: boolean;
  safe: boolean;
};

type ConsumerHandoffRecord = ConsumerHandoffKey & {
  state: "pending" | "active" | "completed" | "aborted" | "failed";
  consumer?: Consumer;
  completion: Promise<ConsumerHandoffCompletion>;
  resolveCompletion: (completion: ConsumerHandoffCompletion) => void;
  completionSettled: boolean;
};

// Request ids are replay fences for the lifetime of one socket-owned Client.
// Keep terminal tombstones instead of recycling ids: accepting an old aborted
// id again would turn a delayed duplicate into a second consumer creation.
// The high, fail-closed ceiling is well above any legitimate reset cadence.
const MAX_CONSUMER_HANDOFF_RECORDS = 1_024;

function createProducerKey(
  kind: MediaKind,
  type: ProducerType,
): ProducerKey {
  return `${kind}-${type}`;
}

export class Client {
  public readonly id: string;
  public readonly socket: Socket;
  public readonly mode: ClientMode;
  public mediaCapabilities: NormalizedWebcamCodecCapabilities | null;

  public producerTransport: WebRtcTransport | null = null;
  public consumerTransport: WebRtcTransport | null = null;

  public producers: Map<ProducerKey, Producer> = new Map();
  private producerKeysById: Map<string, ProducerKey> = new Map();

  public consumers: Map<string, Consumer> = new Map();
  // `consumers` exposes the current generation per producer. Keep every live
  // generation addressable by id during an overlapping handoff so the client
  // can close the displaced server Consumer as soon as its successor is
  // attached instead of waiting for the safety timeout.
  private consumersById: Map<string, Consumer> = new Map();
  private consumerIdsByProducerId: Map<string, string[]> = new Map();
  private consumerGenerationMetadataById: Map<
    string,
    ConsumerGenerationMetadata
  > = new Map();
  private consumerRetirementRevisions: Map<string, number> = new Map();
  private consumerStates: Map<string, ConsumerState> = new Map();
  private consumerHandoffs: Map<string, ConsumerHandoffRecord> = new Map();

  public isMuted: boolean = false;
  public isCameraOff: boolean = false;

  constructor(options: ClientOptions) {
    this.id = options.id;
    this.socket = options.socket;
    if (options.mode) {
      this.mode = options.mode;
    } else {
      this.mode = "participant";
    }
    this.mediaCapabilities = normalizeClientMediaCapabilities(
      options.mediaCapabilities,
    );
  }

  updateMediaCapabilities(value: ClientMediaCapabilities | undefined): boolean {
    const next = normalizeClientMediaCapabilities(value);
    if (!next) return false;

    // Browser codec capabilities are stable for a loaded WebRTC handler. A
    // post-join update may refine an initially incomplete declaration, but it
    // must never remove support and churn the room codec policy.
    if (this.mediaCapabilities) {
      for (const capability of this.mediaCapabilities.receive) {
        if (!next.receive.has(capability)) return false;
      }
      for (const capability of this.mediaCapabilities.send) {
        if (!next.send.has(capability)) return false;
      }
    }

    this.mediaCapabilities = next;
    return true;
  }

  markWebcamCodecFailed(codec: "vp9"): boolean {
    const current = this.mediaCapabilities;
    if (!current || codec !== "vp9") return false;
    if (!current.send.has("vp9-p0-l2t1")) return false;

    const send = new Set(current.send);
    send.delete("vp9-p0-l2t1");
    this.mediaCapabilities = { ...current, send };
    return true;
  }

  get isWebinarAttendee(): boolean {
    return this.mode === "webinar_attendee";
  }

  get isObserver(): boolean {
    return this.isWebinarAttendee;
  }

  addProducer(producer: Producer): Producer | null {
    const type = (producer.appData.type as ProducerType) || "webcam";
    const key = createProducerKey(producer.kind, type);
    const previousProducer = this.producers.get(key);

    this.producers.set(key, producer);
    this.producerKeysById.set(producer.id, key);

    const cleanup = () => {
      this.producerKeysById.delete(producer.id);
      const activeProducer = this.producers.get(key);
      if (activeProducer?.id === producer.id) {
        this.producers.delete(key);
      }
    };

    producer.on("transportclose", cleanup);
    producer.observer.on("close", cleanup);

    const displacedProducer =
      previousProducer && previousProducer.id !== producer.id
        ? previousProducer
        : null;

    if (type === "webcam") {
      if (producer.kind === "audio") {
        this.isMuted = producer.paused;
      } else if (producer.kind === "video") {
        this.isCameraOff = producer.paused;
      }
    }

    return displacedProducer;
  }

  addConsumer(
    consumer: Consumer,
    metadata?: { producerUserId?: string; type?: ProducerType },
  ): DisplacedConsumerGeneration | null {
    const previousConsumer = this.consumers.get(consumer.producerId);
    const displacedConsumer =
      previousConsumer && previousConsumer.id !== consumer.id
        ? previousConsumer
        : null;
    this.consumers.set(consumer.producerId, consumer);
    this.consumersById.set(consumer.id, consumer);
    const now = Date.now();
    const generationMetadata = {
      producerUserId: metadata?.producerUserId,
      type: metadata?.type,
      createdAt: now,
    } satisfies ConsumerGenerationMetadata;
    this.consumerGenerationMetadataById.set(consumer.id, generationMetadata);
    const generationIds = this.consumerIdsByProducerId.get(
      consumer.producerId,
    ) ?? [];
    this.consumerIdsByProducerId.set(consumer.producerId, [
      ...generationIds.filter((consumerId) => consumerId !== consumer.id),
      consumer.id,
    ]);
    this.consumerStates.set(consumer.producerId, {
      consumerId: consumer.id,
      producerId: consumer.producerId,
      producerUserId: generationMetadata.producerUserId,
      kind: consumer.kind,
      type: generationMetadata.type,
      paused: consumer.paused,
      producerPaused: consumer.producerPaused,
      priority: consumer.priority,
      score: consumer.score,
      preferredLayers: consumer.preferredLayers,
      currentLayers: consumer.currentLayers,
      createdAt: now,
      updatedAt: now,
    });

    const retirementRevision = displacedConsumer
      ? (this.consumerRetirementRevisions.get(displacedConsumer.id) ?? 0) + 1
      : 0;
    if (displacedConsumer) {
      this.consumerRetirementRevisions.set(
        displacedConsumer.id,
        retirementRevision,
      );
    }

    const cleanup = () => {
      this.consumersById.delete(consumer.id);
      this.consumerGenerationMetadataById.delete(consumer.id);
      this.consumerRetirementRevisions.delete(consumer.id);
      const remainingGenerationIds = (
        this.consumerIdsByProducerId.get(consumer.producerId) ?? []
      ).filter((consumerId) => consumerId !== consumer.id);
      if (remainingGenerationIds.length > 0) {
        this.consumerIdsByProducerId.set(
          consumer.producerId,
          remainingGenerationIds,
        );
      } else {
        this.consumerIdsByProducerId.delete(consumer.producerId);
      }

      const activeConsumer = this.consumers.get(consumer.producerId);
      if (activeConsumer?.id === consumer.id) {
        this.consumers.delete(consumer.producerId);
        this.consumerStates.delete(consumer.producerId);

        // A successor is provisional until its predecessor is retired. If the
        // successor closes during that overlap, restore the newest live
        // predecessor so controls and telemetry immediately bind to flowing
        // media again instead of leaving the receiver with no current entry.
        for (
          let index = remainingGenerationIds.length - 1;
          index >= 0;
          index -= 1
        ) {
          const predecessorId = remainingGenerationIds[index];
          const predecessor = this.consumersById.get(predecessorId);
          if (!predecessor || predecessor.closed) continue;

          const predecessorMetadata =
            this.consumerGenerationMetadataById.get(predecessorId);
          const restoredAt = Date.now();
          this.consumers.set(consumer.producerId, predecessor);
          this.consumerStates.set(consumer.producerId, {
            consumerId: predecessor.id,
            producerId: predecessor.producerId,
            producerUserId: predecessorMetadata?.producerUserId,
            kind: predecessor.kind,
            type: predecessorMetadata?.type,
            paused: predecessor.paused,
            producerPaused: predecessor.producerPaused,
            priority: predecessor.priority,
            score: predecessor.score,
            preferredLayers: predecessor.preferredLayers,
            currentLayers: predecessor.currentLayers,
            createdAt: predecessorMetadata?.createdAt ?? restoredAt,
            updatedAt: restoredAt,
          });
          // Invalidate any retirement timer created by the predecessor's old
          // displacement. A later displacement receives a fresh revision.
          this.consumerRetirementRevisions.set(
            predecessor.id,
            (this.consumerRetirementRevisions.get(predecessor.id) ?? 0) + 1,
          );
          break;
        }
      }
    };

    consumer.on("transportclose", cleanup);
    consumer.on("producerclose", cleanup);
    consumer.observer.on("close", cleanup);

    return displacedConsumer
      ? { consumer: displacedConsumer, retirementRevision }
      : null;
  }

  getProducer(
    kind: MediaKind,
    type: ProducerType = "webcam",
  ): Producer | undefined {
    return this.producers.get(createProducerKey(kind, type));
  }

  getConsumer(producerId: string): Consumer | undefined {
    return this.consumers.get(producerId);
  }

  getConsumerById(consumerId: string): Consumer | undefined {
    return this.consumersById.get(consumerId);
  }

  /**
   * Reserve a cryptographically named planned handoff before the first async
   * consumer-creation step. A duplicate request with the same exact key joins
   * the original completion; a request-id collision with different ownership
   * is rejected. Only a server-current exact predecessor may start a new one.
   */
  reserveConsumerHandoff(key: ConsumerHandoffKey): ConsumerHandoffReservation {
    const existing = this.consumerHandoffs.get(key.requestId);
    if (existing) {
      this.assertConsumerHandoffKey(existing, key);
      return { isOwner: false, completion: existing.completion };
    }

    if (
      Array.from(this.consumerHandoffs.values()).some(
        (record) =>
          record.producerId === key.producerId &&
          (record.state === "pending" || record.state === "active"),
      )
    ) {
      throw new Error("Planned consumer handoff already in progress");
    }

    const predecessor = this.consumersById.get(key.predecessorConsumerId);
    if (
      !predecessor ||
      predecessor.closed ||
      predecessor.producerId !== key.producerId ||
      this.consumers.get(key.producerId) !== predecessor
    ) {
      throw new Error("Planned consumer handoff predecessor is not current");
    }

    if (this.consumerHandoffs.size >= MAX_CONSUMER_HANDOFF_RECORDS) {
      throw new Error("Too many planned consumer handoff requests");
    }

    let resolveCompletion!: (completion: ConsumerHandoffCompletion) => void;
    const completion = new Promise<ConsumerHandoffCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: ConsumerHandoffRecord = {
      ...key,
      state: "pending",
      completion,
      resolveCompletion,
      completionSettled: false,
    };
    this.consumerHandoffs.set(key.requestId, record);
    return { isOwner: true, completion };
  }

  /** Bind the one created server Consumer to its pre-reserved request. */
  attachConsumerHandoff(
    requestId: string,
    consumer: Consumer,
  ): boolean {
    const record = this.consumerHandoffs.get(requestId);
    if (!record || record.state !== "pending") {
      return false;
    }
    if (consumer.producerId !== record.producerId) {
      this.failConsumerHandoff(
        requestId,
        "Planned consumer handoff producer changed during setup",
      );
      return false;
    }
    record.consumer = consumer;
    record.state = "active";
    return true;
  }

  isConsumerHandoffActive(requestId: string, consumer: Consumer): boolean {
    const record = this.consumerHandoffs.get(requestId);
    return (
      record?.state === "active" &&
      record.consumer === consumer &&
      !consumer.closed
    );
  }

  completeConsumerHandoff(requestId: string, consumer: Consumer): boolean {
    const record = this.consumerHandoffs.get(requestId);
    if (
      !record ||
      record.state !== "active" ||
      record.consumer !== consumer ||
      consumer.closed
    ) {
      return false;
    }
    record.state = "completed";
    this.settleConsumerHandoff(record, { ok: true, consumer });
    return true;
  }

  failConsumerHandoff(
    requestId: string,
    error: string,
    code?: string,
  ): void {
    const record = this.consumerHandoffs.get(requestId);
    if (!record || record.state === "aborted" || record.state === "completed") {
      return;
    }
    record.state = "failed";
    this.settleConsumerHandoff(record, {
      ok: false,
      error,
      ...(code ? { code } : {}),
    });
  }

  /**
   * Abort one exact request. Pending creation is fenced by the terminal state;
   * an already-created successor is synchronously closed, which restores the
   * newest live predecessor through the normal generation cleanup callback.
   */
  abortConsumerHandoff(key: ConsumerHandoffKey): ConsumerHandoffAbortResult {
    const record = this.consumerHandoffs.get(key.requestId);
    if (!record) {
      const predecessorRestored =
        this.consumers.get(key.producerId)?.id === key.predecessorConsumerId;
      const otherHandoffInFlight = Array.from(
        this.consumerHandoffs.values(),
      ).some(
        (candidate) =>
          candidate.producerId === key.producerId &&
          (candidate.state === "pending" || candidate.state === "active"),
      );
      return {
        status: "absent",
        predecessorRestored,
        safe: predecessorRestored && !otherHandoffInFlight,
      };
    }
    this.assertConsumerHandoffKey(record, key);

    const wasAlreadyAborted = record.state === "aborted";
    const successor = record.consumer;
    if (!wasAlreadyAborted) {
      record.state = "aborted";
      this.settleConsumerHandoff(record, {
        ok: false,
        error: "Planned consumer handoff aborted",
        code: "aborted",
      });

      // An ACK-lost client cannot name the successor, so the reservation is
      // its authority. Mutate media only when the reservation still owns the
      // exact live producer generation and its exact predecessor remains
      // available for synchronous restoration.
      const current = this.consumers.get(key.producerId);
      const predecessor = this.consumersById.get(key.predecessorConsumerId);
      const ownsSuccessor =
        successor !== undefined &&
        !successor.closed &&
        successor.producerId === key.producerId &&
        this.consumersById.get(successor.id) === successor &&
        current === successor;
      const ownsPredecessor =
        predecessor !== undefined &&
        !predecessor.closed &&
        predecessor.producerId === key.producerId;
      if (ownsSuccessor && ownsPredecessor) {
        try {
          successor.close();
        } catch {}
      }
    }

    const current = this.consumers.get(key.producerId);
    const predecessorRestored = current?.id === key.predecessorConsumerId;
    return {
      status: wasAlreadyAborted ? "already_aborted" : "aborted",
      ...(successor ? { successorConsumerId: successor.id } : {}),
      predecessorRestored,
      safe: predecessorRestored,
    };
  }

  private assertConsumerHandoffKey(
    record: ConsumerHandoffRecord,
    key: ConsumerHandoffKey,
  ): void {
    if (
      record.producerId !== key.producerId ||
      record.predecessorConsumerId !== key.predecessorConsumerId
    ) {
      throw new Error("Planned consumer handoff request ownership mismatch");
    }
  }

  private settleConsumerHandoff(
    record: ConsumerHandoffRecord,
    completion: ConsumerHandoffCompletion,
  ): void {
    if (record.completionSettled) return;
    record.completionSettled = true;
    record.resolveCompletion(completion);
  }

  private abortAllConsumerHandoffs(): void {
    for (const record of this.consumerHandoffs.values()) {
      if (record.state === "aborted") continue;
      record.state = "aborted";
      this.settleConsumerHandoff(record, {
        ok: false,
        error: "Planned consumer handoff owner disconnected",
        code: "disconnected",
      });
    }
  }

  /**
   * Capture every still-live predecessor behind the supplied current
   * generation. Capturing refreshes their retirement revisions, so timers
   * from an earlier overlapping setup cannot retire them inside this
   * generation's verification window.
   */
  captureDisplacedConsumerRetirements(
    currentConsumer: Consumer,
  ): DisplacedConsumerGeneration[] {
    if (this.consumers.get(currentConsumer.producerId) !== currentConsumer) {
      return [];
    }

    const retirements: DisplacedConsumerGeneration[] = [];
    for (const consumerId of this.consumerIdsByProducerId.get(
      currentConsumer.producerId,
    ) ?? []) {
      if (consumerId === currentConsumer.id) continue;
      const consumer = this.consumersById.get(consumerId);
      if (!consumer || consumer.closed) continue;
      const retirementRevision =
        (this.consumerRetirementRevisions.get(consumer.id) ?? 0) + 1;
      this.consumerRetirementRevisions.set(
        consumer.id,
        retirementRevision,
      );
      retirements.push({ consumer, retirementRevision });
    }
    return retirements;
  }

  /**
   * Retire a predecessor only if this is still the same displacement epoch.
   * Restoration invalidates the old epoch, preventing an old timer from
   * closing a predecessor after it was restored and displaced again.
   */
  retireDisplacedConsumer(
    displaced: DisplacedConsumerGeneration,
  ): boolean {
    const { consumer, retirementRevision } = displaced;
    if (
      consumer.closed ||
      this.consumersById.get(consumer.id) !== consumer ||
      this.consumers.get(consumer.producerId) === consumer ||
      this.consumerRetirementRevisions.get(consumer.id) !== retirementRevision
    ) {
      return false;
    }

    consumer.close();
    return true;
  }

  updateConsumerTelemetry(
    consumer: Consumer,
    patch: Partial<
      Pick<
        ConsumerState,
        | "paused"
        | "producerPaused"
        | "priority"
        | "score"
        | "preferredLayers"
        | "currentLayers"
      >
    > = {},
  ): ConsumerTelemetrySnapshot | null {
    const existing = this.consumerStates.get(consumer.producerId);
    if (!existing || existing.consumerId !== consumer.id) {
      return null;
    }

    const next: ConsumerState = {
      ...existing,
      paused: patch.paused ?? consumer.paused,
      producerPaused: patch.producerPaused ?? consumer.producerPaused,
      priority: patch.priority ?? consumer.priority,
      score: patch.score ?? consumer.score,
      preferredLayers: patch.preferredLayers ?? consumer.preferredLayers,
      currentLayers: patch.currentLayers ?? consumer.currentLayers,
      updatedAt: Date.now(),
    };
    this.consumerStates.set(consumer.producerId, next);
    return { ...next };
  }

  async toggleMute(paused: boolean): Promise<void> {
    const audioProducer = this.getProducer("audio", "webcam");
    if (audioProducer) {
      if (paused) {
        await audioProducer.pause();
      } else {
        await audioProducer.resume();
      }
      this.isMuted = paused;
    }
  }

  async toggleCamera(paused: boolean): Promise<void> {
    const videoProducer = this.getProducer("video", "webcam");
    if (videoProducer) {
      if (paused) {
        await videoProducer.pause();
      } else {
        await videoProducer.resume();
      }
      this.isCameraOff = paused;
    }
  }

  closeConsumers(): void {
    // Fence every pending async creation before closing current generations.
    // A creation that completes after teardown cannot attach because its
    // reservation has been removed below.
    this.abortAllConsumerHandoffs();
    for (const consumer of this.consumersById.values()) {
      try {
        consumer.close();
      } catch {}
    }
    this.consumers.clear();
    this.consumersById.clear();
    this.consumerIdsByProducerId.clear();
    this.consumerGenerationMetadataById.clear();
    this.consumerRetirementRevisions.clear();
    this.consumerStates.clear();
    this.consumerHandoffs.clear();
  }

  close(): void {
    this.closeConsumers();

    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();
    this.producerKeysById.clear();

    if (this.producerTransport) {
      this.producerTransport.close();
      this.producerTransport = null;
    }

    if (this.consumerTransport) {
      this.consumerTransport.close();
      this.consumerTransport = null;
    }
  }

  getProducerInfos(): {
    producerId: string;
    kind: MediaKind;
    type: ProducerType;
    paused: boolean;
  }[] {
    const infos: {
      producerId: string;
      kind: MediaKind;
      type: ProducerType;
      paused: boolean;
    }[] = [];
    for (const [key, producer] of this.producers) {
      const [kind, type] = key.split("-") as [MediaKind, ProducerType];
      infos.push({
        producerId: producer.id,
        kind,
        type,
        paused: producer.paused,
      });
    }
    return infos;
  }

  getConsumerTelemetrySnapshot(): ConsumerTelemetrySnapshot[] {
    return Array.from(this.consumerStates.values()).map((state) => ({ ...state }));
  }

  removeProducerById(
    producerId: string,
  ): { kind: MediaKind; type: ProducerType } | null {
    const key = this.producerKeysById.get(producerId);
    if (!key) {
      return null;
    }
    const producer = this.producers.get(key);
    if (!producer || producer.id !== producerId) {
      this.producerKeysById.delete(producerId);
      return null;
    }
    producer.close();
    this.producers.delete(key);
    this.producerKeysById.delete(producerId);
    const [kind, type] = key.split("-") as [MediaKind, ProducerType];
    return { kind, type };
  }
}

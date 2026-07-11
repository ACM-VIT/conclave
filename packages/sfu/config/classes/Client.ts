import type { Socket } from "socket.io";
import type {
  WebRtcTransport,
  Producer,
  Consumer,
  ConsumerLayers,
  ConsumerScore,
  MediaKind,
} from "mediasoup/types";

export interface ClientOptions {
  id: string;
  socket: Socket;
  mode?: ClientMode;
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

  public producerTransport: WebRtcTransport | null = null;
  public consumerTransport: WebRtcTransport | null = null;

  public producers: Map<ProducerKey, Producer> = new Map();
  private producerKeysById: Map<string, ProducerKey> = new Map();

  public consumers: Map<string, Consumer> = new Map();
  private consumerProducerIdsById: Map<string, string> = new Map();
  private consumerStates: Map<string, ConsumerState> = new Map();

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
  ): Consumer | null {
    const previousConsumer = this.consumers.get(consumer.producerId);
    const displacedConsumer =
      previousConsumer && previousConsumer.id !== consumer.id
        ? previousConsumer
        : null;
    if (displacedConsumer) {
      this.consumerProducerIdsById.delete(displacedConsumer.id);
    }

    this.consumers.set(consumer.producerId, consumer);
    this.consumerProducerIdsById.set(consumer.id, consumer.producerId);
    const now = Date.now();
    this.consumerStates.set(consumer.producerId, {
      consumerId: consumer.id,
      producerId: consumer.producerId,
      producerUserId: metadata?.producerUserId,
      kind: consumer.kind,
      type: metadata?.type,
      paused: consumer.paused,
      producerPaused: consumer.producerPaused,
      priority: consumer.priority,
      score: consumer.score,
      preferredLayers: consumer.preferredLayers,
      currentLayers: consumer.currentLayers,
      createdAt: now,
      updatedAt: now,
    });

    const cleanup = () => {
      this.consumerProducerIdsById.delete(consumer.id);
      const activeConsumer = this.consumers.get(consumer.producerId);
      if (activeConsumer?.id === consumer.id) {
        this.consumers.delete(consumer.producerId);
        this.consumerStates.delete(consumer.producerId);
      }
    };

    consumer.on("transportclose", cleanup);
    consumer.on("producerclose", cleanup);
    consumer.observer.on("close", cleanup);

    return displacedConsumer;
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
    const producerId = this.consumerProducerIdsById.get(consumerId);
    if (!producerId) return undefined;
    const consumer = this.consumers.get(producerId);
    return consumer?.id === consumerId ? consumer : undefined;
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
    for (const consumer of this.consumers.values()) {
      try {
        consumer.close();
      } catch {}
    }
    this.consumers.clear();
    this.consumerProducerIdsById.clear();
    this.consumerStates.clear();
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

import type { Socket } from "socket.io";
import type {
  WebRtcTransport,
  Producer,
  Consumer,
  MediaKind,
} from "mediasoup/types";

export interface ClientOptions {
  id: string;
  socket: Socket;
  mode?: ClientMode;
  isGhost?: boolean;
}

export type ProducerType = "webcam" | "screen";
export type ClientMode = "participant" | "ghost" | "webinar_attendee";

export type ProducerKey = `${MediaKind}-${ProducerType}`;

export function createProducerKey(
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

  public consumers: Map<string, Consumer> = new Map();

  public isMuted: boolean = false;
  public isCameraOff: boolean = false;

  constructor(options: ClientOptions) {
    this.id = options.id;
    this.socket = options.socket;
    if (options.mode) {
      this.mode = options.mode;
    } else if (options.isGhost) {
      this.mode = "ghost";
    } else {
      this.mode = "participant";
    }
  }

  get isGhost(): boolean {
    return this.mode === "ghost";
  }

  get isWebinarAttendee(): boolean {
    return this.mode === "webinar_attendee";
  }

  get isObserver(): boolean {
    return this.isGhost || this.isWebinarAttendee;
  }

  addProducer(producer: Producer): void {
    const type = (producer.appData.type as ProducerType) || "webcam";
    const key = createProducerKey(producer.kind, type);
    const previousProducer = this.producers.get(key);

    this.producers.set(key, producer);

    const cleanup = () => {
      const activeProducer = this.producers.get(key);
      if (activeProducer?.id === producer.id) {
        this.producers.delete(key);
      }
    };

    producer.on("transportclose", cleanup);
    producer.observer.on("close", cleanup);

    if (previousProducer && previousProducer.id !== producer.id) {
      try {
        previousProducer.close();
      } catch {}
    }

    if (type === "webcam") {
      if (producer.kind === "audio") {
        this.isMuted = producer.paused;
      } else if (producer.kind === "video") {
        this.isCameraOff = producer.paused;
      }
    }
  }

  addConsumer(consumer: Consumer): void {
    const previousConsumer = this.consumers.get(consumer.producerId);
    if (previousConsumer && previousConsumer.id !== consumer.id) {
      try {
        previousConsumer.close();
      } catch {}
    }

    this.consumers.set(consumer.producerId, consumer);

    const cleanup = () => {
      const activeConsumer = this.consumers.get(consumer.producerId);
      if (activeConsumer?.id === consumer.id) {
        this.consumers.delete(consumer.producerId);
      }
    };

    consumer.on("transportclose", cleanup);
    consumer.on("producerclose", cleanup);
    consumer.observer.on("close", cleanup);
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

  close(): void {
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();

    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();

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

  removeProducerById(
    producerId: string,
  ): { kind: MediaKind; type: ProducerType } | null {
    for (const [key, producer] of this.producers) {
      if (producer.id === producerId) {
        producer.close();
        this.producers.delete(key);
        const [kind, type] = key.split("-") as [MediaKind, ProducerType];
        return { kind, type };
      }
    }
    return null;
  }
}

export default Client;

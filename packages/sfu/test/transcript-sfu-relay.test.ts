import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Consumer, DirectTransport, Producer } from "mediasoup/types";
import OpusScript from "opusscript";
import type {
  TranscriptAudioProducerEntry,
  Room,
} from "../config/classes/Room.js";
import type { TranscriptSpeaker } from "../types.js";
import { SfuTranscriptRelay } from "../server/transcript/sfuTranscriptRelay.js";
import type { TranscriptWorkerRelayConnection } from "../server/transcript/workerClient.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960;
const RTP_PAYLOAD_TYPE = 120;

type WorkerEvent =
  | { type: "connect" }
  | { type: "chunk"; speaker: TranscriptSpeaker; bytes: number }
  | { type: "commit"; speaker: TranscriptSpeaker }
  | { type: "clear"; speaker: TranscriptSpeaker }
  | { type: "close" };

class FakeConsumer extends EventEmitter {
  readonly observer = new EventEmitter();
  closed = false;

  constructor(readonly producerId: string) {
    super();
  }

  close(): void {
    this.closed = true;
  }

  emitRtp(packet: Buffer): void {
    this.emit("rtp", packet);
  }

  emitProducerPause(): void {
    this.emit("producerpause");
  }
}

class FakeDirectTransport {
  readonly consumers = new Map<string, FakeConsumer>();
  readonly consumeCalls: string[] = [];
  closed = false;

  async consume(options: { producerId: string }): Promise<Consumer> {
    this.consumeCalls.push(options.producerId);
    const consumer = new FakeConsumer(options.producerId);
    this.consumers.set(options.producerId, consumer);
    return consumer as unknown as Consumer;
  }

  close(): void {
    this.closed = true;
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
  }
}

class FakeWorkerClient implements TranscriptWorkerRelayConnection {
  connected = false;
  closed = false;

  constructor(
    readonly events: WorkerEvent[],
    private readonly options: { onClose?: (message: string) => void } = {},
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
    this.events.push({ type: "connect" });
  }

  sendAudioChunk(audio: string, speaker: TranscriptSpeaker): boolean {
    this.events.push({
      type: "chunk",
      speaker,
      bytes: Buffer.from(audio, "base64").length,
    });
    return true;
  }

  commitAudio(speaker: TranscriptSpeaker): boolean {
    this.events.push({ type: "commit", speaker });
    return true;
  }

  clearAudio(speaker: TranscriptSpeaker): boolean {
    this.events.push({ type: "clear", speaker });
    return true;
  }

  async prepareHandoff(): Promise<boolean> {
    return true;
  }

  close(): void {
    this.closed = true;
    this.events.push({ type: "close" });
  }

  simulateClose(): void {
    this.options.onClose?.("worker socket closed in test");
  }
}

const fakeProducer = (
  id: string,
  options: { closed?: boolean; paused?: boolean } = {},
): Producer =>
  ({
    id,
    kind: "audio",
    closed: options.closed ?? false,
    paused: options.paused ?? false,
  }) as unknown as Producer;

const producerEntry = (
  producerId: string,
  userId: string,
  displayName: string,
  options: { closed?: boolean; paused?: boolean } = {},
): TranscriptAudioProducerEntry => ({
  producer: fakeProducer(producerId, options),
  producerId,
  userId,
  displayName,
  type: "webcam",
  paused: options.paused ?? false,
});

const createHarness = (entries: TranscriptAudioProducerEntry[]) => {
  const directTransport = new FakeDirectTransport();
  const room = {
    id: "room-a",
    router: {
      closed: false,
      rtpCapabilities: { codecs: [] },
      createDirectTransport: async () =>
        directTransport as unknown as DirectTransport,
    },
    getTranscriptAudioProducerEntries: () => entries,
  } as unknown as Room;
  const workerEvents: WorkerEvent[] = [];
  let workerClient: FakeWorkerClient | null = null;
  const relay = new SfuTranscriptRelay({
    room,
    workerUrl: "http://transcript-worker.test",
    workerToken: "relay-token",
    controllerUserId: "u1",
    controllerDisplayName: "Ada",
    createWorkerClient: (options) => {
      workerClient = new FakeWorkerClient(workerEvents, options);
      return workerClient;
    },
  });
  return { directTransport, relay, workerClient: () => workerClient!, workerEvents };
};

const pcmFrame = (frequencyHz: number, amplitude: number): Buffer => {
  const buffer = Buffer.alloc(FRAME_SIZE * CHANNELS * 2);
  for (let frame = 0; frame < FRAME_SIZE; frame += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * frame) / SAMPLE_RATE) * amplitude,
    );
    buffer.writeInt16LE(sample, frame * 4);
    buffer.writeInt16LE(sample, frame * 4 + 2);
  }
  return buffer;
};

const encodeOpusFrames = (
  count: number,
  options: { frequencyHz: number; amplitude: number; ssrc: number },
): Buffer[] => {
  const encoder = new OpusScript(
    SAMPLE_RATE,
    CHANNELS,
    OpusScript.Application.AUDIO,
  );
  try {
    return Array.from({ length: count }, (_, index) =>
      wrapRtp(
        encoder.encode(pcmFrame(options.frequencyHz, options.amplitude), FRAME_SIZE),
        {
          sequence: index,
          timestamp: index * FRAME_SIZE,
          ssrc: options.ssrc,
        },
      ),
    );
  } finally {
    encoder.delete();
  }
};

const wrapRtp = (
  payload: Buffer,
  options: { sequence: number; timestamp: number; ssrc: number },
): Buffer => {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = RTP_PAYLOAD_TYPE;
  header.writeUInt16BE(options.sequence % 65536, 2);
  header.writeUInt32BE(options.timestamp >>> 0, 4);
  header.writeUInt32BE(options.ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("SfuTranscriptRelay realistic audio flow", () => {
  it("separates two overlapping speakers from interleaved real Opus RTP packets", async () => {
    vi.useFakeTimers();
    const ada = producerEntry("producer-a", "u1", "Ada");
    const grace = producerEntry("producer-b", "u2", "Grace");
    const { directTransport, relay, workerEvents } = createHarness([ada, grace]);
    await relay.start();

    const adaConsumer = directTransport.consumers.get("producer-a")!;
    const graceConsumer = directTransport.consumers.get("producer-b")!;
    const adaPackets = encodeOpusFrames(13, {
      frequencyHz: 440,
      amplitude: 9000,
      ssrc: 101,
    });
    const gracePackets = encodeOpusFrames(13, {
      frequencyHz: 660,
      amplitude: 9000,
      ssrc: 202,
    });

    for (let index = 0; index < adaPackets.length; index += 1) {
      adaConsumer.emitRtp(adaPackets[index]!);
      graceConsumer.emitRtp(gracePackets[index]!);
    }

    const chunkEvents = workerEvents.filter((event) => event.type === "chunk");
    expect(chunkEvents).toHaveLength(2);
    expect(chunkEvents.map((event) => event.speaker.userId)).toEqual([
      "u1",
      "u2",
    ]);
    expect(chunkEvents.every((event) => event.bytes > 10_000)).toBe(true);

    await vi.advanceTimersByTimeAsync(1200);
    const commitEvents = workerEvents.filter((event) => event.type === "commit");
    expect(commitEvents.map((event) => event.speaker.userId)).toEqual([
      "u1",
      "u2",
    ]);

    relay.close();
  });

  it("flushes a short utterance when the producer pauses and ignores later RTP", async () => {
    const ada = producerEntry("producer-a", "u1", "Ada");
    const { directTransport, relay, workerEvents } = createHarness([ada]);
    await relay.start();

    const consumer = directTransport.consumers.get("producer-a")!;
    for (const packet of encodeOpusFrames(3, {
      frequencyHz: 440,
      amplitude: 9000,
      ssrc: 101,
    })) {
      consumer.emitRtp(packet);
    }
    consumer.emitProducerPause();
    consumer.emitRtp(
      encodeOpusFrames(1, {
        frequencyHz: 440,
        amplitude: 9000,
        ssrc: 101,
      })[0]!,
    );

    expect(workerEvents.filter((event) => event.type === "chunk")).toHaveLength(1);
    expect(workerEvents.filter((event) => event.type === "commit")).toHaveLength(1);
    expect(workerEvents.filter((event) => event.type === "clear")).toHaveLength(1);
    expect(
      workerEvents
        .filter(
          (event) =>
            event.type === "chunk" ||
            event.type === "commit" ||
            event.type === "clear",
        )
        .every((event) => event.speaker.userId === "u1"),
    ).toBe(true);

    relay.close();
  });

  it("does not create duplicate consumers when producer syncs overlap", async () => {
    const entries: TranscriptAudioProducerEntry[] = [];
    const ada = producerEntry("producer-a", "u1", "Ada");
    const { directTransport, relay } = createHarness(entries);
    await relay.start();

    entries.push(ada);
    await Promise.all([relay.syncProducers(), relay.syncProducers()]);

    expect(
      directTransport.consumeCalls.filter((producerId) => producerId === "producer-a"),
    ).toHaveLength(1);

    relay.close();
  });

  it("does not forward silence-only Opus RTP to the worker", async () => {
    vi.useFakeTimers();
    const ada = producerEntry("producer-a", "u1", "Ada");
    const { directTransport, relay, workerEvents } = createHarness([ada]);
    await relay.start();

    const consumer = directTransport.consumers.get("producer-a")!;
    for (const packet of encodeOpusFrames(16, {
      frequencyHz: 440,
      amplitude: 0,
      ssrc: 101,
    })) {
      consumer.emitRtp(packet);
    }
    await vi.advanceTimersByTimeAsync(2400);

    expect(workerEvents.filter((event) => event.type !== "connect")).toEqual([]);
    relay.close();
  });

  it("does not flush buffered audio during intentional relay shutdown", async () => {
    const ada = producerEntry("producer-a", "u1", "Ada");
    const { directTransport, relay, workerEvents } = createHarness([ada]);
    await relay.start();

    const consumer = directTransport.consumers.get("producer-a")!;
    for (const packet of encodeOpusFrames(3, {
      frequencyHz: 440,
      amplitude: 9000,
      ssrc: 101,
    })) {
      consumer.emitRtp(packet);
    }
    relay.close();

    expect(
      workerEvents.filter(
        (event) =>
          event.type === "chunk" ||
          event.type === "commit" ||
          event.type === "clear",
      ),
    ).toEqual([]);
  });

  it("closes SFU consumers when the transcript worker relay socket drops", async () => {
    const ada = producerEntry("producer-a", "u1", "Ada");
    const { directTransport, relay, workerClient, workerEvents } =
      createHarness([ada]);
    await relay.start();

    const consumer = directTransport.consumers.get("producer-a")!;
    workerClient().simulateClose();

    expect(directTransport.closed).toBe(true);
    expect(consumer.closed).toBe(true);
    expect(workerEvents.at(-1)).toEqual({ type: "close" });
  });
});

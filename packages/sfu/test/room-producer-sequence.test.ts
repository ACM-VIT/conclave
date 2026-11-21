import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Producer, Router } from "mediasoup/types";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";

const fakeRouter = (): Router =>
  ({
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close() {},
  }) as unknown as Router;

const fakeProducer = (id: string, kind: "audio" | "video"): Producer => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const producer = {
    id,
    kind,
    appData: { type: "webcam" },
    paused: false,
    closed: false,
    rtpParameters: {
      codecs: [
        kind === "video"
          ? { mimeType: "video/VP8", payloadType: 102, clockRate: 90_000 }
          : { mimeType: "audio/opus", payloadType: 111, clockRate: 48_000 },
      ],
      encodings: [{}],
    },
    on: events.on.bind(events),
    observer,
    close() {
      if (producer.closed) return;
      producer.closed = true;
      observer.emit("close");
    },
  };
  return producer as unknown as Producer;
};

const createRoomWithClients = (...clientIds: string[]) => {
  const room = new Room({
    id: "room",
    clientId: "default",
    router: fakeRouter(),
    workerPid: null,
  });
  const clients = clientIds.map((id) => {
    const client = new Client({
      id,
      socket: { emit: vi.fn(), connected: true } as never,
    });
    room.addClient(client);
    return client;
  });
  return { room, clients };
};

const publish = (room: Room, client: Client, producer: Producer) => {
  client.addProducer(producer);
  room.indexClientProducer(client.id, producer, "webcam");
};

describe("Room producer sequence", () => {
  it("numbers every listed producer in the order it was created", () => {
    const { room, clients } = createRoomWithClients("alice", "bob");
    const [alice, bob] = clients;
    publish(room, alice, fakeProducer("alice-mic", "audio"));
    publish(room, bob, fakeProducer("bob-camera", "video"));
    publish(room, alice, fakeProducer("alice-camera", "video"));

    const listed = room.getAllProducers();

    expect(listed.map((producer) => producer.producerId)).toEqual([
      "alice-mic",
      "bob-camera",
      "alice-camera",
    ]);
    const sequences = listed.map((producer) => producer.producerSeq);
    expect(sequences.every((seq) => typeof seq === "number")).toBe(true);
    expect([...sequences].sort((a, b) => Number(a) - Number(b))).toEqual(
      sequences,
    );
    expect(new Set(sequences).size).toBe(sequences.length);
    room.close();
  });

  it("gives a replacement camera a higher sequence than the camera it replaces", () => {
    const { room, clients } = createRoomWithClients("alice");
    const [alice] = clients;
    publish(room, alice, fakeProducer("first-camera", "video"));
    const firstSeq = room.getProducerInfoById("first-camera")?.producerSeq;

    publish(room, alice, fakeProducer("replacement-camera", "video"));

    const replacementSeq =
      room.getProducerInfoById("replacement-camera")?.producerSeq;
    expect(Number(replacementSeq)).toBeGreaterThan(Number(firstSeq));
    expect(room.getAllProducers().map((producer) => producer.producerId)).toEqual(
      ["replacement-camera"],
    );
    room.close();
  });

  it("keeps the sequence rising when the clock steps back", () => {
    vi.useFakeTimers();
    try {
      const { room, clients } = createRoomWithClients("alice", "bob");
      const [alice, bob] = clients;
      vi.setSystemTime(new Date("2030-01-01T00:00:10Z"));
      publish(room, alice, fakeProducer("before-rollback", "video"));
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      publish(room, bob, fakeProducer("after-rollback", "video"));

      expect(
        Number(room.getProducerInfoById("after-rollback")?.producerSeq),
      ).toBeGreaterThan(
        Number(room.getProducerInfoById("before-rollback")?.producerSeq),
      );
      room.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the sequence rising across rooms", () => {
    const first = createRoomWithClients("alice");
    publish(first.room, first.clients[0], fakeProducer("in-first-room", "video"));
    const second = createRoomWithClients("alice");
    publish(
      second.room,
      second.clients[0],
      fakeProducer("in-second-room", "video"),
    );

    expect(
      Number(second.room.getProducerInfoById("in-second-room")?.producerSeq),
    ).toBeGreaterThan(
      Number(first.room.getProducerInfoById("in-first-room")?.producerSeq),
    );
    first.room.close();
    second.room.close();
  });
});

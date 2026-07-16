import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Producer, Router } from "mediasoup/types";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";

const modernCapabilities = {
  webcam: {
    negotiationVersion: 3,
    receive: ["vp8", "h264-cb", "vp9-p0"],
    send: ["vp8", "h264-cb", "vp9-p0-l2t1"],
    preferredBaseline: "vp8" as const,
  },
};

const fakeSocket = () => ({ emit: vi.fn(), connected: true });
const producerCloseMocks = new WeakMap<Producer, ReturnType<typeof vi.fn>>();

const fakeRouter = (): Router => {
  const state = { closed: false };
  return ({
    get closed() {
      return state.closed;
    },
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close() {
      state.closed = true;
    },
  }) as unknown as Router;
};

const fakeWebcamProducer = (codec: "vp8" | "vp9"): Producer => {
  const events = new EventEmitter();
  const observer = new EventEmitter();
  const close = vi.fn(() => {
    if (producer.closed) return;
    producer.closed = true;
    observer.emit("close");
  });
  const producer = {
    id: `producer-${codec}`,
    kind: "video",
    type: codec === "vp9" ? "svc" : "simulcast",
    appData: { type: "webcam" },
    paused: false,
    closed: false,
    rtpParameters:
      codec === "vp9"
        ? {
            codecs: [
              {
                mimeType: "video/VP9",
                payloadType: 101,
                clockRate: 90_000,
                parameters: { "profile-id": 0 },
                rtcpFeedback: [],
              },
            ],
            encodings: [{ scalabilityMode: "L2T1" }],
            headerExtensions: [],
            rtcp: {},
          }
        : {
            codecs: [
              {
                mimeType: "video/VP8",
                payloadType: 102,
                clockRate: 90_000,
                parameters: {},
                rtcpFeedback: [],
              },
            ],
            encodings: [{ rid: "f" }],
            headerExtensions: [],
            rtcp: {},
          },
    on: events.on.bind(events),
    observer,
    close,
  };
  const result = producer as unknown as Producer;
  producerCloseMocks.set(result, close);
  return result;
};

const addProducer = (room: Room, client: Client, producer: Producer) => {
  client.addProducer(producer);
  room.indexClientProducer(client.id, producer, "webcam");
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Room webcam codec transitions", () => {
  it("closes an incompatible VP9 producer before a legacy late join can consume it", () => {
    const room = new Room({
      id: "room",
      clientId: "default",
      router: fakeRouter(),
      workerPid: null,
    });
    const modern = new Client({
      id: "modern",
      socket: fakeSocket() as never,
      mediaCapabilities: modernCapabilities,
    });
    room.addClient(modern);
    expect(room.webcamCodecPolicy.codec).toBe("vp9");

    const vp9Producer = fakeWebcamProducer("vp9");
    addProducer(room, modern, vp9Producer);
    room.addClient(
      new Client({ id: "legacy", socket: fakeSocket() as never }),
    );

    expect(room.webcamCodecPolicy.codec).toBe("vp8");
    expect(producerCloseMocks.get(vp9Producer)).toHaveBeenCalledTimes(1);
    expect(room.getAllProducers()).toEqual([]);
    room.close();
  });

  it("does not interrupt active baseline cameras for an optional VP9 upgrade", async () => {
    vi.useFakeTimers();
    const room = new Room({
      id: "room",
      clientId: "default",
      router: fakeRouter(),
      workerPid: null,
    });
    const modern = new Client({
      id: "modern",
      socket: fakeSocket() as never,
      mediaCapabilities: modernCapabilities,
    });
    const legacy = new Client({ id: "legacy", socket: fakeSocket() as never });
    room.addClient(modern);
    room.addClient(legacy);
    expect(room.webcamCodecPolicy.codec).toBe("vp8");

    const vp8Producer = fakeWebcamProducer("vp8");
    addProducer(room, modern, vp8Producer);
    room.removeClient(legacy.id);
    room.addClient(
      new Client({
        id: "modern-2",
        socket: fakeSocket() as never,
        mediaCapabilities: modernCapabilities,
      }),
    );

    expect(room.webcamCodecPolicy.codec).toBe("vp8");
    expect(producerCloseMocks.get(vp8Producer)).not.toHaveBeenCalled();

    vp8Producer.close();
    await vi.runAllTimersAsync();
    expect(room.webcamCodecPolicy.codec).toBe("vp9");
    room.close();
  });

  it("turns one proven VP9 encoder failure into a monotonic room fallback", () => {
    const room = new Room({
      id: "room",
      clientId: "default",
      router: fakeRouter(),
      workerPid: null,
    });
    const client = new Client({
      id: "modern",
      socket: fakeSocket() as never,
      mediaCapabilities: modernCapabilities,
    });
    room.addClient(client);
    const epoch = room.webcamCodecPolicy.epoch;

    expect(room.reportClientWebcamCodecFailure("modern", "vp9", epoch)?.codec).toBe(
      "vp8",
    );
    expect(room.reportClientWebcamCodecFailure("modern", "vp9", epoch)).toBeNull();
    expect(client.mediaCapabilities?.receive.has("vp9-p0")).toBe(true);
    expect(client.mediaCapabilities?.send.has("vp9-p0-l2t1")).toBe(false);
    room.close();
  });
});

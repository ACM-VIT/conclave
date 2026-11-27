import { afterEach, describe, expect, it, vi } from "vitest";
import type { Consumer, Producer } from "mediasoup/types";
import type { Socket } from "socket.io";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerMediaHandlers } from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";
import { PRODUCER_PACKET_COUNT_MAX_AGE_MS } from "../server/producerPacketCounts.js";

type SocketHandler = (...args: never[]) => unknown;
type Counts = { counts: Record<string, number> } | { error: string };

const sharer = (id: string, packetCounts: number[] = [70, 50]) => {
  const getStats = vi
    .fn()
    .mockResolvedValue(packetCounts.map((packetCount) => ({ type: "inbound-rtp", packetCount })));
  return { producer: { id, closed: false, getStats } as unknown as Producer, getStats };
};

const register = ({
  inRoom = true,
  socketId = "viewer-socket",
  producers = new Map<string, Producer>([["shared-screen", sharer("shared-screen").producer]]),
  consumerProducers = { screen: "shared-screen" },
  ownProducers = [] as Producer[],
}: {
  ownProducers?: Producer[];
  inRoom?: boolean;
  socketId?: string;
  producers?: Map<string, Producer>;
  consumerProducers?: Record<string, string>;
} = {}) => {
  const handlers = new Map<string, SocketHandler>();
  const socket = {
    id: socketId,
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
  } as unknown as Socket;
  const consumer = (id: string, producerId: string, closed = false) =>
    ({
      id,
      producerId,
      closed,
      getStats: vi.fn().mockResolvedValue([{ type: "outbound-rtp", packetCount: 3 }]),
    }) as unknown as Consumer;
  const consumers = new Map([
    ...Object.entries(consumerProducers).map(
      ([id, producerId]) => [id, consumer(id, producerId)] as const,
    ),
    ["closed", consumer("closed", "shared-screen", true)],
    ["orphan", consumer("orphan", "gone-producer")],
  ]);
  const client = {
    id: `viewer-${socketId}`,
    getConsumerById: (id: string) => consumers.get(id),
    producers: new Map(ownProducers.map((producer, index) => [`own-${index}`, producer])),
  } as unknown as Client;
  const room = {
    id: "room",
    channelId: "instance:room",
    getActiveProducerById: (id: string) => producers.get(id) ?? null,
  } as unknown as Room;
  registerMediaHandlers({
    socket,
    io: {} as ConnectionContext["io"],
    state: { rooms: new Map([[room.channelId, room]]) } as unknown as SfuState,
    currentRoom: inRoom ? room : null,
    currentClient: inRoom ? client : null,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
    activeConclaveAnswers: new Map(),
    adminHandlersRegistered: false,
    joinAttempts: 0,
  });
  const ask = async (data: unknown, event = "getSenderPacketCounts") => {
    const handler = handlers.get(event) as unknown as (
      data: unknown,
      callback: (response: Counts) => void,
    ) => Promise<void>;
    const callback = vi.fn<(response: Counts) => void>();
    await handler(data, callback);
    return callback.mock.calls[0]?.[0];
  };
  return { ask };
};

describe("telling a viewer how many packets the sharers behind its consumers sent", () => {
  it("counts what the SFU received from the producer behind each of the viewer's own live consumers", async () => {
    const { ask } = register();

    expect(
      await ask({ consumerIds: ["screen", "closed", "orphan", "someone-else"] }),
    ).toEqual({
      counts: { screen: 120 },
    });
  });

  it("answers nothing outside a room", async () => {
    expect(await register({ inRoom: false }).ask({ consumerIds: ["screen"] })).toEqual({
      error: "Not in a room",
    });
  });

  it.each<[string, unknown]>([
    ["no request", undefined],
    ["an id that is not a string", { consumerIds: ["screen", 7] }],
    ["more ids than one request may name", { consumerIds: Array.from({ length: 17 }, () => "screen") }],
    ["a field the request does not have", { consumerIds: ["screen"], producerIds: ["shared-screen"] }],
    ["the same id twice", { consumerIds: ["screen", "screen"] }],
  ])("refuses %s instead of guessing what it meant", async (_name, request) => {
    expect(await register().ask(request)).toEqual({ error: "Invalid request" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a sharer once however many viewers ask at the same time", async () => {
    const screen = sharer("shared-screen");
    const producers = new Map<string, Producer>([["shared-screen", screen.producer]]);
    const viewers = Array.from({ length: 50 }, (_, index) =>
      register({ socketId: `viewer-${index}`, producers }),
    );

    const answers = await Promise.all(viewers.map(({ ask }) => ask({ consumerIds: ["screen"] })));

    expect(answers).toEqual(viewers.map(() => ({ counts: { screen: 120 } })));
    expect(screen.getStats).toHaveBeenCalledTimes(1);
  });

  it("reads a sharer again only once the last count is older than the cache allows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const screen = sharer("shared-screen");
    const producers = new Map<string, Producer>([["shared-screen", screen.producer]]);
    const viewers = Array.from({ length: 3 }, (_, index) =>
      register({ socketId: `viewer-${index}`, producers }),
    );

    await viewers[0].ask({ consumerIds: ["screen"] });
    vi.advanceTimersByTime(PRODUCER_PACKET_COUNT_MAX_AGE_MS - 1);
    await viewers[1].ask({ consumerIds: ["screen"] });
    expect(screen.getStats).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await viewers[2].ask({ consumerIds: ["screen"] });
    expect(screen.getStats).toHaveBeenCalledTimes(2);
  });

  it("reads a sharer once for two of the viewer's consumers behind it", async () => {
    const screen = sharer("shared-screen");
    const { ask } = register({
      producers: new Map<string, Producer>([["shared-screen", screen.producer]]),
      consumerProducers: { screen: "shared-screen", "screen-again": "shared-screen" },
    });

    expect(await ask({ consumerIds: ["screen", "screen-again"] })).toEqual({
      counts: { screen: 120, "screen-again": 120 },
    });
    expect(screen.getStats).toHaveBeenCalledTimes(1);
  });

  it("leaves out a sharer that closes mid-request and still answers for the rest", async () => {
    const closing = sharer("closing-screen");
    closing.getStats.mockRejectedValue(new Error("Producer closed"));
    const { ask } = register({
      producers: new Map<string, Producer>([
        ["shared-screen", sharer("shared-screen").producer],
        ["closing-screen", closing.producer],
      ]),
      consumerProducers: { screen: "shared-screen", closing: "closing-screen" },
    });

    expect(await ask({ consumerIds: ["closing", "screen"] })).toEqual({
      counts: { screen: 120 },
    });
  });

  it("answers a burst of six from one viewer and refuses the seventh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ask } = register();
    const answers = [];
    for (let index = 0; index < 7; index += 1) {
      answers.push(await ask({ consumerIds: ["screen"] }));
    }

    expect(answers.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => ({ counts: { screen: 120 } })));
    expect(answers[6]).toEqual({ error: "Too many requests" });
  });
});

describe("telling a sender how many of its own packets reached the SFU", () => {
  const askOwn = (target: ReturnType<typeof register>, data: unknown) =>
    target.ask(data, "getOwnPacketCounts");

  it("counts what the SFU received from each of the caller's own live producers, and nobody else's", async () => {
    const microphone = sharer("mic", [40]);
    const camera = sharer("camera", [300, 200]);
    const target = register({
      ownProducers: [microphone.producer, camera.producer],
      producers: new Map<string, Producer>([["shared-screen", sharer("shared-screen").producer]]),
    });

    expect(await askOwn(target, { producerIds: ["mic", "camera", "shared-screen", "gone"] })).toEqual({
      counts: { mic: 40, camera: 500 },
    });
  });

  it("leaves out an own producer whose read fails and still answers for the rest", async () => {
    const microphone = sharer("mic", [40]);
    const camera = sharer("camera");
    camera.getStats.mockRejectedValue(new Error("Producer closed"));
    const target = register({ ownProducers: [microphone.producer, camera.producer] });

    expect(await askOwn(target, { producerIds: ["mic", "camera"] })).toEqual({ counts: { mic: 40 } });
  });

  it("answers nothing outside a room", async () => {
    expect(await askOwn(register({ inRoom: false }), { producerIds: ["mic"] })).toEqual({
      error: "Not in a room",
    });
  });

  it.each<[string, unknown]>([
    ["no request", undefined],
    ["the same id twice", { producerIds: ["mic", "mic"] }],
    ["more ids than a sender has producers", { producerIds: ["a", "b", "c", "d", "e"] }],
    ["consumer ids instead", { consumerIds: ["screen"] }],
  ])("refuses %s", async (_name, request) => {
    expect(await askOwn(register(), request)).toEqual({ error: "Invalid request" });
  });

  it("answers a burst of six and refuses the seventh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const target = register({ ownProducers: [sharer("mic", [40]).producer] });
    const answers = [];
    for (let index = 0; index < 7; index += 1) {
      answers.push(await askOwn(target, { producerIds: ["mic"] }));
    }
    vi.useRealTimers();

    expect(answers.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => ({ counts: { mic: 40 } })));
    expect(answers[6]).toEqual({ error: "Too many requests" });
  });
});

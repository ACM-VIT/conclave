import { describe, expect, it, vi } from "vitest";
import type { Consumer, Producer } from "mediasoup/types";
import type { Socket } from "socket.io";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerMediaHandlers } from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;

const registerFixture = ({ producerId = "publisher-video" } = {}) => {
  const handlers = new Map<string, SocketHandler>();
  const socket = {
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
  } as unknown as Socket;
  const producer = {
    id: producerId,
    closed: false,
  } as unknown as Producer;
  const requestKeyFrame = vi.fn().mockResolvedValue(undefined);
  const consumer = {
    id: "receiver-consumer",
    producerId,
    kind: "video",
    closed: false,
    requestKeyFrame,
  } as unknown as Consumer;
  const getProducer = vi.fn().mockReturnValue(producer);
  const owner = {
    id: "publisher",
    getProducer,
  } as unknown as Client;
  const receiver = {
    id: "receiver",
    getConsumer: vi.fn((requestedProducerId: string) =>
      requestedProducerId === producerId ? consumer : undefined,
    ),
  } as unknown as Client;
  const room = {
    id: "room",
    channelId: "instance:room",
    clients: new Map([
      [owner.id, owner],
      [receiver.id, receiver],
    ]),
  } as unknown as Room;

  registerMediaHandlers({
    socket,
    io: {} as ConnectionContext["io"],
    state: {
      rooms: new Map([[room.channelId, room]]),
    } as unknown as SfuState,
    currentRoom: room,
    currentClient: owner,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
    activeConclaveAnswers: new Map(),
    adminHandlersRegistered: false,
  });

  return { consumer, getProducer, handlers, requestKeyFrame };
};

describe("publisher source-switch key-frame requests", () => {
  it("requests a key frame from every live consumer of the owned webcam producer", async () => {
    const { getProducer, handlers, requestKeyFrame } = registerFixture();
    const handler = handlers.get("requestProducerKeyFrame") as unknown as (
      data: { producerId: string },
      callback: (response: { success?: true; error?: string }) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    await handler({ producerId: "publisher-video" }, callback);

    expect(getProducer).toHaveBeenCalledWith("video", "webcam");
    expect(requestKeyFrame).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({
      success: true,
      requestedConsumerCount: 1,
    });
  });

  it("rejects stale or unowned producer IDs without sending a PLI", async () => {
    const { handlers, requestKeyFrame } = registerFixture();
    const handler = handlers.get("requestProducerKeyFrame") as unknown as (
      data: { producerId: string },
      callback: (response: { success?: true; error?: string }) => void,
    ) => Promise<void>;
    const callback = vi.fn();

    await handler({ producerId: "stale-video" }, callback);

    expect(requestKeyFrame).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ error: "Video producer not found" });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Consumer, Producer } from "mediasoup/types";
import type { Socket } from "socket.io";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerMediaHandlers } from "../server/socket/handlers/mediaHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;
type Counts = { counts: Record<string, number> } | { error: string };

const register = ({ inRoom = true } = {}) => {
  const handlers = new Map<string, SocketHandler>();
  const socket = {
    id: "viewer-socket",
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
  } as unknown as Socket;
  const producers = new Map([
    [
      "shared-screen",
      {
        id: "shared-screen",
        getStats: vi.fn().mockResolvedValue([
          { type: "inbound-rtp", packetCount: 70 },
          { type: "inbound-rtp", packetCount: 50 },
        ]),
      } as unknown as Producer,
    ],
  ]);
  const consumer = (id: string, producerId: string, closed = false) =>
    ({
      id,
      producerId,
      closed,
      getStats: vi.fn().mockResolvedValue([{ type: "outbound-rtp", packetCount: 3 }]),
    }) as unknown as Consumer;
  const consumers = new Map([
    ["screen", consumer("screen", "shared-screen")],
    ["closed", consumer("closed", "shared-screen", true)],
    ["orphan", consumer("orphan", "gone-producer")],
  ]);
  const client = {
    id: "viewer",
    getConsumerById: (id: string) => consumers.get(id),
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
  });
  const ask = async (data: unknown) => {
    const handler = handlers.get("getSenderPacketCounts") as unknown as (
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
      await ask({ consumerIds: ["screen", "closed", "orphan", "someone-else", 7] }),
    ).toEqual({
      counts: { screen: 120 },
    });
  });

  it("answers nothing useful outside a room or for a malformed request", async () => {
    expect(await register({ inRoom: false }).ask({ consumerIds: ["screen"] })).toEqual({
      error: "Not in a room",
    });
    expect(await register().ask(undefined)).toEqual({ counts: {} });
  });
});

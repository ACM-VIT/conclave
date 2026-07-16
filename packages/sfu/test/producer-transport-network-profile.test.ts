import { describe, expect, it, vi } from "vitest";
import type { WebRtcTransport } from "mediasoup/types";
import type { Socket } from "socket.io";
import type { Client } from "../config/classes/Client.js";
import type { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import {
  getProducerTransportMaxIncomingBitrate,
  PRODUCER_TRANSPORT_EMERGENCY_MAX_INCOMING_BITRATE_BPS,
  PRODUCER_TRANSPORT_FAIR_MAX_INCOMING_BITRATE_BPS,
  PRODUCER_TRANSPORT_POOR_MAX_INCOMING_BITRATE_BPS,
} from "../server/producerTransportNetworkProfile.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { registerTransportHandlers } from "../server/socket/handlers/transportHandlers.js";
import type { SfuState } from "../server/state.js";

type SocketHandler = (...args: never[]) => unknown;

const registerFixture = ({
  observer = false,
  closed = false,
}: {
  observer?: boolean;
  closed?: boolean;
} = {}) => {
  const handlers = new Map<string, SocketHandler>();
  const socket = {
    data: {},
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
  } as unknown as Socket;
  const setMaxIncomingBitrate = vi.fn(async (_bitrate: number) => {});
  const producerTransport = {
    id: "producer-transport-current",
    closed,
    setMaxIncomingBitrate,
  } as unknown as WebRtcTransport;
  const client = {
    id: "publisher",
    isObserver: observer,
    producerTransport,
  } as unknown as Client;
  const room = { id: "room" } as Room;
  const context = {
    socket,
    io: {} as ConnectionContext["io"],
    state: { rooms: new Map() } as unknown as SfuState,
    currentRoom: room,
    currentClient: client,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
    activeConclaveAnswers: new Map(),
    adminHandlersRegistered: false,
  } satisfies ConnectionContext;

  registerTransportHandlers(context);
  return { context, handlers, setMaxIncomingBitrate };
};

const getProfileHandler = (handlers: Map<string, SocketHandler>) =>
  handlers.get("setProducerTransportNetworkProfile") as unknown as (
    data: { transportId?: string; profile: string },
    callback: (response: Record<string, unknown>) => void,
  ) => Promise<void>;

describe("producer transport network profiles", () => {
  it("maps constrained profiles to aggregate ceilings without exceeding config", () => {
    expect(getProducerTransportMaxIncomingBitrate("good", 6_000_000)).toBe(
      6_000_000,
    );
    expect(getProducerTransportMaxIncomingBitrate("fair", 6_000_000)).toBe(
      PRODUCER_TRANSPORT_FAIR_MAX_INCOMING_BITRATE_BPS,
    );
    expect(getProducerTransportMaxIncomingBitrate("poor", 6_000_000)).toBe(
      PRODUCER_TRANSPORT_POOR_MAX_INCOMING_BITRATE_BPS,
    );
    expect(
      getProducerTransportMaxIncomingBitrate("emergency", 6_000_000),
    ).toBe(PRODUCER_TRANSPORT_EMERGENCY_MAX_INCOMING_BITRATE_BPS);
    expect(getProducerTransportMaxIncomingBitrate("fair", 90_000)).toBe(
      90_000,
    );
  });

  it("applies a profile only to the socket-owned current producer transport", async () => {
    const { handlers, setMaxIncomingBitrate } = registerFixture();
    const callback = vi.fn();

    await getProfileHandler(handlers)(
      { transportId: "producer-transport-current", profile: "poor" },
      callback,
    );

    expect(setMaxIncomingBitrate).toHaveBeenCalledWith(
      PRODUCER_TRANSPORT_POOR_MAX_INCOMING_BITRATE_BPS,
    );
    expect(callback).toHaveBeenCalledWith({
      success: true,
      transportId: "producer-transport-current",
      profile: "poor",
      maxIncomingBitrate: PRODUCER_TRANSPORT_POOR_MAX_INCOMING_BITRATE_BPS,
    });
  });

  it.each([
    {
      name: "stale",
      fixture: {},
      data: { transportId: "producer-transport-old", profile: "poor" },
      error: "Stale producer transport",
    },
    {
      name: "invalid profile",
      fixture: {},
      data: { transportId: "producer-transport-current", profile: "turbo" },
      error: "Invalid producer transport profile",
    },
    {
      name: "observer",
      fixture: { observer: true },
      data: { transportId: "producer-transport-current", profile: "poor" },
      error: "Watch-only attendees cannot control producer transports",
    },
    {
      name: "closed",
      fixture: { closed: true },
      data: { transportId: "producer-transport-current", profile: "poor" },
      error: "Producer transport is closed",
    },
  ])("rejects $name requests", async ({ fixture, data, error }) => {
    const { handlers, setMaxIncomingBitrate } = registerFixture(fixture);
    const callback = vi.fn();

    await getProfileHandler(handlers)(data, callback);

    expect(setMaxIncomingBitrate).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ error });
  });

  it("uses the configured good ceiling on recovery", async () => {
    const { handlers, setMaxIncomingBitrate } = registerFixture();

    await getProfileHandler(handlers)(
      { transportId: "producer-transport-current", profile: "good" },
      vi.fn(),
    );

    expect(setMaxIncomingBitrate).toHaveBeenCalledWith(
      config.webRtcTransport.producerMaxIncomingBitrate,
    );
  });
});

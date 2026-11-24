import { describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import type { Room } from "../config/classes/Room.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { getSocketContext } from "../server/socket/context.js";
import { registerConnectionHandlers } from "../server/socket/registerConnectionHandlers.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { getOrCreateWebinarRoomConfig, setCustomWebinarLinkSlug } from "../server/webinar.js";

type Listener = (...args: unknown[]) => unknown;

const host = {
  userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA.tab-1",
  clientId: "conclave",
  sessionId: "tab-1",
  allowRoomCreation: true,
  guestProof: "proof-of-the-host-pass",
  guestRoom: "room",
} satisfies SfuAuthPayload;
const coHost = {
  userId: "guest-gp_CCCCCCCCCCCCCCCCCCCCCC",
  clientId: "conclave",
  sessionId: "co-host-tab",
  guestProof: "proof-of-the-co-host-pass",
  guestRoom: "room",
} satisfies SfuAuthPayload;
const seatOf = (user: SfuAuthPayload) => `${user.userId}#${user.sessionId}`;

const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const sfu = () => {
  const broadcast = vi.fn();
  let onConnection: ((socket: Socket) => void) | null = null;
  const io = {
    on: (event: string, listener: (socket: Socket) => void) => {
      if (event === "connection") onConnection = listener;
    },
    to: () => ({ emit: broadcast }),
    in: () => ({ emit: broadcast }),
    except: () => ({ emit: broadcast }),
  } as unknown as SocketIOServer;
  const state: SfuState = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "seat-authority-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: vi.fn(),
  } as unknown as Router;
  state.workers = [{ pid: 1, closed: false, createRouter: async () => router } as unknown as Worker];
  registerConnectionHandlers(io, state);

  let sockets = 0;
  const connect = (user: SfuAuthPayload) => {
    const handlers = new Map<string, Listener>();
    const socket = {
      id: `socket-${(sockets += 1)}`,
      data: { user },
      connected: true,
      handshake: { address: "127.0.0.1", headers: {}, auth: {} },
      on(event: string, listener: Listener) {
        handlers.set(event, listener);
        return socket;
      },
      emit: vi.fn(),
      join: vi.fn(async () => {}),
      leave: vi.fn(async () => {}),
      to: () => ({ emit: vi.fn() }),
      disconnect: vi.fn(() => {
        if (!socket.connected) return;
        socket.connected = false;
        handlers.get("disconnect")?.("server namespace disconnect");
      }),
    };
    onConnection!(socket as unknown as Socket);
    const ask = async (event: string, ...args: unknown[]) => {
      const ack = vi.fn();
      handlers.get(event)?.(...args, ack);
      await vi.waitFor(() => expect(ack).toHaveBeenCalled(), { timeout: 2000 }).catch(() => {});
      return ack.mock.calls[0]?.[0] as { error?: unknown; success?: unknown; status?: unknown } | undefined;
    };
    const join = (roomId = "room", payload: Record<string, unknown> = {}) =>
      ask("joinRoom", { roomId, sessionId: user.sessionId, ...payload });
    return { socket: socket as unknown as Socket & { connected: boolean }, handlers, ask, join };
  };
  return { state, broadcast, connect, room: () => state.rooms.get("conclave:room")! };
};

const stableView = (room: Room) => ({
  seats: [...room.clients.entries()].map(([id, client]) => `${id}:${client instanceof Admin ? "host" : "seat"}`).sort(),
  host: room.getHostUserId(),
  locked: room.isLocked,
  blocked: [...room.blockedUsers].sort(),
  admins: room.getAdminUserIds().sort(),
  pending: [...room.pendingClients.keys()].sort(),
});

describe("a seat that another socket took over (Neon)", () => {
  it("disconnects the socket it replaced, which can then neither unblock its guest nor remove the host", async () => {
    const { connect, room } = sfu();
    const hostTab = connect(host);
    expect(await hostTab.join()).toMatchObject({ status: "joined" });
    const first = connect(coHost);
    expect(await first.join()).toMatchObject({ status: "joined" });
    expect(await hostTab.ask("promoteHost", { userId: seatOf(coHost) })).toMatchObject({ success: true });
    expect(room().getClient(seatOf(coHost))).toBeInstanceOf(Admin);

    const second = connect(coHost);
    expect(await second.join()).toMatchObject({ status: "joined" });
    await settle();

    expect(first.socket.connected).toBe(false);
    expect(getSocketContext(first.socket)?.currentClient ?? null).toBeNull();
    expect(await hostTab.ask("admin:blockUsers", { userKeys: [coHost.userId], kickPresent: true })).toMatchObject({ success: true });
    await settle();
    const blocked = stableView(room());

    expect((await first.ask("admin:unblockUsers", { userKeys: [coHost.userId] }))?.success).not.toBe(true);
    expect((await first.ask("kickUser", { userId: seatOf(host) }))?.success).not.toBe(true);
    await settle();

    expect(stableView(room())).toEqual(blocked);
    expect(room().getHostUserId()).toBe(seatOf(host));
    expect(room().blockedUsers.has(coHost.userId)).toBe(true);
  });

  it.each([
    ["the room removed", false],
    ["another seat object replaced", true],
  ])("refuses every event from a socket whose seat %s while the socket stayed open", async (_how, replaced) => {
    const { connect, room, broadcast } = sfu();
    const hostTab = connect(host);
    await hostTab.join();
    const first = connect(coHost);
    await first.join();
    await hostTab.ask("promoteHost", { userId: seatOf(coHost) });
    const stale = room().getClient(seatOf(coHost))!;
    expect(stale).toBeInstanceOf(Admin);
    room().removeClient(seatOf(coHost));
    if (replaced) {
      room().addClient(new Admin({ id: seatOf(coHost), socket: connect(coHost).socket }));
    }
    await settle();
    const before = stableView(room());
    broadcast.mockClear();

    const events = [...first.handlers.keys()].filter(
      (event) => event !== "joinRoom" && event !== "disconnect" && event !== "getRooms",
    );
    expect(events.length).toBeGreaterThan(60);
    const payload = {
      userId: seatOf(host),
      targetUserId: seatOf(host),
      userKeys: [host.userId],
      locked: true,
      enabled: true,
      disabled: true,
      kickPresent: true,
      message: "Taken over",
      reason: "Taken over",
      text: "Taken over",
      content: "Taken over",
      roomId: "room",
    };
    const outsider = connect({ ...coHost, userId: "guest-gp_OOOOOOOOOOOOOOOOOOOOOO", sessionId: "outsider", guestProof: "proof-of-an-outsider" });
    const answerOf = async (peer: ReturnType<typeof connect>, event: string, args: unknown[]) => {
      const handler = peer.handlers.get(event);
      if (!handler) return null;
      const ack = vi.fn();
      handler(...args, ack);
      await settle();
      return (ack.mock.calls[0]?.[0] ?? null) as { error?: unknown } | null;
    };
    const accepted: string[] = [];
    for (const event of events) {
      for (const args of [[payload], []]) {
        const context = getSocketContext(first.socket)!;
        context.currentRoom = room();
        context.currentClient = stale;
        const fromStaleSeat = await answerOf(first, event, args);
        const fromOutside = await answerOf(outsider, event, args);
        const answered = fromStaleSeat !== null && typeof fromStaleSeat.error !== "string";
        if (answered && JSON.stringify(fromStaleSeat) !== JSON.stringify(fromOutside) && !accepted.includes(event)) {
          accepted.push(event);
        }
      }
    }

    expect(accepted).toEqual([]);
    expect(stableView(room())).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("hands the room on and keeps no host rights on the old socket when the host comes back as a webinar attendee", async () => {
    const { connect, room, state } = sfu();
    const account = { email: "asha@example.com", userId: "asha@example.com", clientId: "conclave", sessionId: "asha-1", allowRoomCreation: true } satisfies SfuAuthPayload;
    const hostTab = connect(account);
    expect(await hostTab.join()).toMatchObject({ status: "joined" });
    const participant = connect({ ...coHost, userId: "guest-gp_PPPPPPPPPPPPPPPPPPPPPP", sessionId: "participant", guestProof: "proof-of-the-participant" });
    expect(await participant.join()).toMatchObject({ status: "joined" });
    const config = getOrCreateWebinarRoomConfig(state.webinarConfigs, room().channelId);
    config.enabled = true;
    config.publicAccess = true;
    setCustomWebinarLinkSlug({
      webinarConfig: config,
      webinarLinks: state.webinarLinks,
      room: { channelId: room().channelId, id: room().id, clientId: room().clientId },
      slug: "launch",
    });

    const watching = connect({ ...account, joinMode: "webinar_attendee" });
    expect(await watching.join("launch")).toMatchObject({ status: "joined", webinarRole: "attendee" });
    await settle();

    expect(hostTab.socket.connected).toBe(false);
    expect(room().getClient(seatOf(account))?.isWebinarAttendee).toBe(true);
    expect(room().hasActiveAdmin()).toBe(true);
    expect(room().getClient("guest-gp_PPPPPPPPPPPPPPPPPPPPPP#participant")).toBeInstanceOf(Admin);
    expect((await hostTab.ask("lockRoom", true))?.success).not.toBe(true);
    expect(room().isLocked).toBe(false);
  });
});

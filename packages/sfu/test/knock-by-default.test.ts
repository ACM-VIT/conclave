import { describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createScheduledMeeting } from "../server/scheduledMeetings.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";

type Handler = (...args: never[]) => void | Promise<void>;

const makeSocket = (id: string, user: SfuAuthPayload) => {
  const handlers = new Map<string, Handler>();
  const emit = vi.fn();
  const socket = {
    id,
    data: { user },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit,
    disconnect: vi.fn(),
    connected: true,
    join: vi.fn(),
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  return { socket, handlers, emit };
};

const io = { to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer;

const makeState = (): SfuState => {
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: vi.fn(),
  } as unknown as Router;
  const worker = {
    pid: 1,
    closed: false,
    createRouter: vi.fn(async () => router),
  } as unknown as Worker;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "knock-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  state.workers = [worker];
  return state;
};

type JoinAck = {
  status?: string;
  error?: string;
  isLocked?: boolean;
  hostUserId?: string | null;
  hostUserIds?: string[];
  roomRecoveryPass?: string;
};

const join = async (
  state: SfuState,
  user: SfuAuthPayload,
  options: { roomId?: string; roomRecoveryPass?: string } = {},
) => {
  const peer = makeSocket(`${user.userId}-socket`, user);
  const context = createConnectionContext(io, peer.socket, state);
  registerJoinRoomHandler(context);
  const ack = vi.fn();
  await peer.handlers.get("joinRoom")!(...[
    {
      roomId: options.roomId ?? "abc-mnop-xyz",
      sessionId: user.sessionId,
      roomRecoveryPass: options.roomRecoveryPass,
    },
    ack,
  ] as never[]);
  const response = (ack.mock.calls[0]?.[0] ?? {}) as JoinAck;
  return { context, peer, ack, response, status: response.status };
};

// What a host's socket sends: an admin event with a payload and an ack.
const send = async (
  peer: ReturnType<typeof makeSocket>,
  event: string,
  payload: unknown,
) => {
  const ack = vi.fn();
  await peer.handlers.get(event)?.(...([payload, ack] as never[]));
  return ack.mock.calls[0]?.[0] as { success?: boolean; error?: string } | undefined;
};

const roomOf = (state: SfuState) => state.rooms.get("conclave:abc-mnop-xyz")!;

const host = { userId: "guest-host", clientId: "conclave", sessionId: "h", allowRoomCreation: true };
const guest = { userId: "guest-visitor", clientId: "conclave", sessionId: "v" };

describe("new meetings make people knock", () => {
  it("lets the creator in as host and parks everyone else until admitted", async () => {
    const state = makeState();
    const created = await join(state, host);
    expect(created.status).toBe("joined");
    expect(created.context.currentClient).toBeInstanceOf(Admin);
    expect(created.ack).toHaveBeenCalledWith(expect.objectContaining({ isLocked: true }));

    const knocking = await join(state, guest);
    expect(knocking.status).toBe("waiting");
    const status = knocking.peer.emit.mock.calls.find(
      ([event]) => event === "waitingRoomStatus",
    )?.[1] as { message?: string } | undefined;
    expect(status?.message).toContain("locked");
    const knock = created.peer.emit.mock.calls.find(
      ([event]) => event === "userRequestedJoin",
    )?.[1] as { userId?: string } | undefined;
    expect(knock?.userId).toBe("guest-visitor");

    const room = state.rooms.get("conclave:abc-mnop-xyz")!;
    room.allowLockedUser("guest-visitor");
    expect((await join(state, guest)).status).toBe("joined");
  });

  it("lets people straight in once the host opens the room", async () => {
    const state = makeState();
    await join(state, host);
    state.rooms.get("conclave:abc-mnop-xyz")!.setLocked(false);

    expect((await join(state, guest)).status).toBe("joined");
  });

  it("lets a returning host back in without knocking", async () => {
    const state = makeState();
    await join(state, host);
    const back = await join(state, { ...host, allowRoomCreation: false });
    expect(back.status).toBe("joined");
    expect(back.context.currentClient).toBeInstanceOf(Admin);
  });

  it("lets a scheduled meeting's invited attendee skip the knock", async () => {
    const state = makeState();
    createScheduledMeeting(
      state.scheduledMeetings,
      {
        title: "Intro call",
        scheduledStartAt: Date.now(),
        roomCode: "abc-mnop-xyz",
        hostEmail: "host@example.com",
        attendeeEmail: "Invitee@Example.com",
      },
      {
        clientId: "conclave",
        createdBy: "host@example.com",
        defaultHostEmail: "host@example.com",
        defaultHostUserId: null,
      },
    );
    await join(state, host);

    const invited = await join(state, {
      userId: "user-2",
      email: "invitee@example.com",
      clientId: "conclave",
      sessionId: "i",
    });
    expect(invited.status).toBe("joined");

    const stranger = await join(state, {
      userId: "user-3",
      email: "stranger@example.com",
      clientId: "conclave",
      sessionId: "s",
    });
    expect(stranger.status).toBe("waiting");
  });

  it("keeps an invited attendee the host removed out until they are let in again", async () => {
    const state = makeState();
    createScheduledMeeting(
      state.scheduledMeetings,
      {
        title: "Intro call",
        scheduledStartAt: Date.now(),
        roomCode: "abc-mnop-xyz",
        hostEmail: "host@example.com",
        attendeeEmail: "invitee@example.com",
      },
      {
        clientId: "conclave",
        createdBy: "host@example.com",
        defaultHostEmail: "host@example.com",
        defaultHostUserId: null,
      },
    );
    const created = await join(state, host);
    const invitee = {
      userId: "user-2",
      email: "invitee@example.com",
      clientId: "conclave",
      sessionId: "i",
    };
    expect((await join(state, invitee)).status).toBe("joined");

    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });
    expect((await join(state, invitee)).status).toBe("waiting");

    await send(created.peer, "admitUser", { userId: "invitee@example.com" });
    expect((await join(state, invitee)).status).toBe("joined");
  });
});

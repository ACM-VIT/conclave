import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createScheduledMeeting } from "../server/scheduledMeetings.js";
import {
  isNonJoinToken,
  type SfuAuthPayload,
} from "../server/socket/auth.js";
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
const second = { userId: "guest-second", clientId: "conclave", sessionId: "s2" };
const knocker = { userId: "guest-knocker", clientId: "conclave", sessionId: "k" };

afterEach(() => {
  vi.useRealTimers();
});

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

  // A guest's session id is their identity until guest passes land, so a
  // host's user id in this reply would let a knocker come back as that host.
  it("does not tell someone who is still knocking who is in the meeting", async () => {
    const state = makeState();
    const created = await join(state, host);
    expect(created.response.hostUserId).toBe("guest-host#h");

    const knocking = await join(state, guest);
    expect(knocking.status).toBe("waiting");
    expect(JSON.stringify(knocking.response)).not.toContain("guest-host");
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

describe("a call whose server lost the room", () => {
  // Three people in a call and one person still knocking, then the SFU
  // restarts: a fresh state has no rooms and no memory of who was let in.
  const callBeforeRestart = async () => {
    const before = makeState();
    const hostJoin = await join(before, host);
    roomOf(before).allowLockedUser(guest.userId);
    roomOf(before).allowLockedUser(second.userId);
    const guestJoin = await join(before, guest);
    const secondJoin = await join(before, second);
    const knock = await join(before, knocker);
    expect(knock.status).toBe("waiting");
    return {
      before,
      hostJoin,
      knock,
      passes: {
        host: hostJoin.response.roomRecoveryPass,
        guest: guestJoin.response.roomRecoveryPass,
        second: secondJoin.response.roomRecoveryPass,
      },
    };
  };
  const rejoining = (user: SfuAuthPayload) => ({ ...user, allowRoomCreation: true });

  it("brings everyone who was in it back without anyone admitting them", async () => {
    const { passes } = await callBeforeRestart();
    const after = makeState();

    const first = await join(after, rejoining(guest), {
      roomRecoveryPass: passes.guest,
    });
    expect(first.status).toBe("joined");
    expect(first.context.currentClient).toBeInstanceOf(Admin);

    const returningHost = await join(after, rejoining(host), {
      roomRecoveryPass: passes.host,
    });
    expect(returningHost.status).toBe("joined");
    const third = await join(after, rejoining(second), {
      roomRecoveryPass: passes.second,
    });
    expect(third.status).toBe("joined");

    expect(roomOf(after).clients.size).toBe(3);
    expect(roomOf(after).pendingClients.size).toBe(0);
    expect(
      first.peer.emit.mock.calls.some(([event]) => event === "userRequestedJoin"),
    ).toBe(false);
  });

  it("keeps the recovered meeting locked for people who were only knocking", async () => {
    const { passes, knock } = await callBeforeRestart();
    expect(knock.response.roomRecoveryPass).toBeUndefined();
    const after = makeState();
    await join(after, rejoining(guest), { roomRecoveryPass: passes.guest });

    expect(roomOf(after).isLocked).toBe(true);
    expect((await join(after, knocker)).status).toBe("waiting");
    // Someone else's pass does not let the knocker in either.
    expect(
      (await join(after, knocker, { roomRecoveryPass: passes.second })).status,
    ).toBe("waiting");
    expect(
      (await join(after, knocker, { roomRecoveryPass: "not-a-pass" })).status,
    ).toBe("waiting");
  });

  it("lets a member back in again after a second drop in the recovered meeting", async () => {
    const { passes } = await callBeforeRestart();
    const after = makeState();
    await join(after, rejoining(guest), { roomRecoveryPass: passes.guest });
    const back = await join(after, rejoining(second), {
      roomRecoveryPass: passes.second,
    });

    const again = await join(after, second, {
      roomRecoveryPass: back.response.roomRecoveryPass,
    });
    expect(again.status).toBe("joined");
  });

  it("does not let someone the host removed back in with their old pass", async () => {
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).allowLockedUser(guest.userId);
    const member = await join(state, guest);

    await send(created.peer, "kickUser", { userId: "guest-visitor#v" });
    expect(
      (await join(state, guest, { roomRecoveryPass: member.response.roomRecoveryPass }))
        .status,
    ).toBe("waiting");
  });

  it("keeps someone removed from the recovered meeting out as well", async () => {
    const { passes } = await callBeforeRestart();
    const after = makeState();
    const first = await join(after, rejoining(guest), {
      roomRecoveryPass: passes.guest,
    });
    await join(after, rejoining(second), { roomRecoveryPass: passes.second });

    await send(first.peer, "kickUser", { userId: "guest-second#s2" });
    expect(
      (await join(after, second, { roomRecoveryPass: passes.second })).status,
    ).toBe("waiting");
  });

  it("stops honouring a pass once it is older than a join token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const { passes } = await callBeforeRestart();
    const after = makeState();
    await join(after, rejoining(guest), { roomRecoveryPass: passes.guest });

    vi.setSystemTime(new Date("2026-11-22T20:00:01Z"));
    expect(
      (await join(after, second, { roomRecoveryPass: passes.second })).status,
    ).toBe("waiting");
  });

  it("issues a pass that cannot be used to sign in to the SFU", async () => {
    const { passes } = await callBeforeRestart();
    const claims = jwt.decode(passes.guest ?? "");
    expect(claims).toBeTypeOf("object");
    expect(isNonJoinToken(claims as jwt.JwtPayload)).toBe(true);
  });
});

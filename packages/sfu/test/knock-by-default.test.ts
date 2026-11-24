import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import type { ScheduledMeeting } from "../types.js";
import { Admin } from "../config/classes/Admin.js";
import { config } from "../config/config.js";
import { initScheduledMeetings } from "../server/init.js";
import {
  createMemoryRoomRecoveryStore,
  type RoomRecoveryStore,
} from "../server/roomRecoveryLedger.js";
import { startRoomRecoveryPassRefresh } from "../server/roomRecoveryPass.js";
import {
  LocalRoomRegistry,
  createRoomRegistry,
  type RoomRegistry,
} from "../server/roomRegistry.js";
import { forceCloseRoom, renewRoomOwnerships } from "../server/rooms.js";
import {
  createScheduledMeeting,
  isScheduledMeetingInvitee,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";
import {
  isNonJoinToken,
  type SfuAuthPayload,
} from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";

type Handler = (...args: never[]) => void | Promise<void>;

const makeSocket = (id: string, user: SfuAuthPayload) => {
  const handlers = new Map<string, Handler>();
  const emit = vi.fn();
  const disconnect = vi.fn();
  const socket = {
    id,
    data: { user },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit,
    disconnect,
    connected: true,
    join: vi.fn(),
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  return { socket, handlers, emit, disconnect, user };
};

const io = {
  to: () => ({ emit: vi.fn() }),
  in: () => ({ disconnectSockets: vi.fn() }),
} as unknown as SocketIOServer;

// What outlives an SFU process: the recovery ledger and the schedule. A new
// state built on the same two is the SFU after a restart.
type Durable = {
  recovery: RoomRecoveryStore;
  schedule: ScheduledMeetingPersistence;
};
const makeDurable = (): Durable => {
  let stored = "[]";
  return {
    recovery: createMemoryRoomRecoveryStore(),
    schedule: {
      save: (snapshot) => {
        stored = JSON.stringify(snapshot);
      },
      load: () => JSON.parse(stored) as ScheduledMeeting[],
      loadOne: (id) =>
        (JSON.parse(stored) as ScheduledMeeting[]).find((meeting) => meeting.id === id) ??
        null,
    },
  };
};
const durableOf = new WeakMap<SfuState, Durable>();
const restart = async (before: SfuState): Promise<SfuState> => {
  const durable = durableOf.get(before)!;
  const after = makeState(durable);
  await initScheduledMeetings(after, durable.schedule);
  return after;
};

const makeState = (
  durable: Durable = makeDurable(),
  roomRegistry: RoomRegistry = new LocalRoomRegistry({
    instanceId: "knock-test",
    instanceUrl: "http://localhost",
    ttlMs: 45000,
  }),
): SfuState => {
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
    roomRegistry,
    roomRecoveryStore: durable.recovery,
  });
  state.workers = [worker];
  state.scheduledMeetingPersistence = durable.schedule;
  durableOf.set(state, durable);
  return state;
};

const schedule = (state: SfuState, attendeeEmail = "invitee@example.com") => {
  createScheduledMeeting(
    state.scheduledMeetings,
    {
      title: "Intro call",
      scheduledStartAt: Date.now(),
      roomCode: "abc-mnop-xyz",
      hostEmail: "host@example.com",
      attendeeEmail,
    },
    {
      clientId: "conclave",
      createdBy: "host@example.com",
      defaultHostEmail: "host@example.com",
      defaultHostUserId: null,
    },
  );
  void durableOf.get(state)!.schedule.save([...state.scheduledMeetings.byId.values()]);
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
  options: { roomId?: string; roomRecoveryPass?: string; admissionCode?: string } = {},
) => {
  const peer = makeSocket(`${user.userId}-socket`, user);
  const context = createConnectionContext(io, peer.socket, state);
  registerJoinRoomHandler(context);
  registerDisconnectHandlers(context);
  const ack = vi.fn();
  await peer.handlers.get("joinRoom")!(...[
    {
      roomId: options.roomId ?? "abc-mnop-xyz",
      sessionId: user.sessionId,
      roomRecoveryPass: options.roomRecoveryPass,
      admissionCode: options.admissionCode,
    },
    ack,
  ] as never[]);
  const response = (ack.mock.calls[0]?.[0] ?? {}) as JoinAck;
  return { context, peer, ack, response, status: response.status };
};

// What a host's socket sends: an admin event with a payload and an ack.
const send = async <Answer = { success?: boolean; error?: string }>(
  peer: ReturnType<typeof makeSocket>,
  event: string,
  payload: unknown,
) => {
  const ack = vi.fn();
  await peer.handlers.get(event)?.(...([payload, ack] as never[]));
  return ack.mock.calls[0]?.[0] as Answer | undefined;
};

// What a tab does when the SFU says "joinApproved": it asks again on the
// socket it has.
const askAgain = async (member: Awaited<ReturnType<typeof join>>, roomId = "abc-mnop-xyz") => {
  const ack = vi.fn();
  await member.peer.handlers.get("joinRoom")!(
    ...([{ roomId, sessionId: member.peer.user.sessionId }, ack] as never[]),
  );
  return (ack.mock.calls[0]?.[0] ?? {}) as JoinAck;
};

const CHANNEL = "conclave:abc-mnop-xyz";
const roomOf = (state: SfuState) => state.rooms.get(CHANNEL)!;
const hangUp = async (peer: ReturnType<typeof makeSocket>) => {
  await peer.handlers.get("disconnect")?.(...(["client namespace disconnect"] as never[]));
};
// The people a host's tab is told are waiting to be let in.
const knocksShownTo = (member: Awaited<ReturnType<typeof join>>): string[] =>
  member.peer.emit.mock.calls
    .filter(([event]) => event === "pendingUsersSnapshot")
    .flatMap(([, sent]) => (sent as { users: Array<{ userId: string }> }).users)
    .map((user) => user.userId);

// Every pass a member's tab has been handed: with the join reply, then by the
// SFU during the call. A tab keeps the newest.
const passesHeldBy = (member: Awaited<ReturnType<typeof join>>): string[] => [
  ...(member.response.roomRecoveryPass ? [member.response.roomRecoveryPass] : []),
  ...member.peer.emit.mock.calls
    .filter(([event]) => event === "roomRecoveryPass")
    .map(([, sent]) => (sent as { roomRecoveryPass: string }).roomRecoveryPass),
];
const secondsLeftOn = (pass: string): number =>
  (jwt.decode(pass) as jwt.JwtPayload).exp! - Date.now() / 1000;
const MINUTE_MS = 60_000;
const useTestClock = () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
};

const host = { userId: "guest-host", clientId: "conclave", sessionId: "h", allowRoomCreation: true };
const guest = { userId: "guest-visitor", clientId: "conclave", sessionId: "v" };
const second = { userId: "guest-second", clientId: "conclave", sessionId: "s2" };
const knocker = { userId: "guest-knocker", clientId: "conclave", sessionId: "k" };
// The voice agent joins as a brand new guest that nobody has let in.
const agent = { userId: "guest-agent-session-1", clientId: "conclave", sessionId: "agent-session-1" };
const invitee = { userId: "user-2", email: "invitee@example.com", clientId: "conclave", sessionId: "i" };

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
    room.restoreAdmission("guest-visitor", undefined, { pastLock: true });
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

  it("makes an invited attendee knock once a host revokes their access", async () => {
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

    await send(created.peer, "admin:revokeAllowedUsers", {
      userKeys: ["invitee@example.com"],
    });
    expect((await join(state, invitee)).status).toBe("waiting");
  });
});

describe("a participant the host admits before it joins", () => {
  it("joins a locked meeting without knocking, and nobody else does", async () => {
    const state = makeState();
    const created = await join(state, host);
    expect(roomOf(state).pendingClients.has(agent.userId)).toBe(false);

    const admitted = await send<{ success?: boolean; admissionCode?: string }>(
      created.peer,
      "admin:createAdmission",
      {},
    );
    expect(admitted?.success).toBe(true);

    expect((await join(state, agent, { admissionCode: admitted?.admissionCode })).status).toBe(
      "joined",
    );
    expect((await join(state, knocker)).status).toBe("waiting");
    expect(roomOf(state).isLocked).toBe(true);
  });

  it("cannot be admitted by someone who is not a host", async () => {
    const state = makeState();
    await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const participant = await join(state, guest);
    expect(participant.status).toBe("joined");

    const refused = await send<{ admissionCode?: string }>(
      participant.peer,
      "admin:createAdmission",
      {},
    );
    expect(refused?.admissionCode).toBeUndefined();
    expect((await join(state, agent, { admissionCode: refused?.admissionCode })).status).toBe(
      "waiting",
    );
  });
});

describe("a call whose server lost the room", () => {
  // Three people in a call and one person still knocking, then the SFU
  // restarts: a fresh state has no rooms and no memory of who was let in.
  const callBeforeRestart = async () => {
    const before = makeState();
    const hostJoin = await join(before, host);
    roomOf(before).restoreAdmission(guest.userId, undefined, { pastLock: true });
    roomOf(before).restoreAdmission(second.userId, undefined, { pastLock: true });
    const guestJoin = await join(before, guest);
    const secondJoin = await join(before, second);
    const knock = await join(before, knocker);
    expect(knock.status).toBe("waiting");
    return {
      before,
      hostJoin,
      guestJoin,
      secondJoin,
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
    const { before, passes } = await callBeforeRestart();
    const after = await restart(before);

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
    const { before, passes, knock } = await callBeforeRestart();
    expect(knock.response.roomRecoveryPass).toBeUndefined();
    const after = await restart(before);
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
    const { before, passes } = await callBeforeRestart();
    const after = await restart(before);
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
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);

    await send(created.peer, "kickUser", { userId: "guest-visitor#v" });
    expect(
      (await join(state, guest, { roomRecoveryPass: member.response.roomRecoveryPass }))
        .status,
    ).toBe("waiting");
  });

  it("keeps someone removed from the recovered meeting out as well", async () => {
    const { before, passes } = await callBeforeRestart();
    const after = await restart(before);
    const first = await join(after, rejoining(guest), {
      roomRecoveryPass: passes.guest,
    });
    await join(after, rejoining(second), { roomRecoveryPass: passes.second });

    await send(first.peer, "kickUser", { userId: "guest-second#s2" });
    expect(
      (await join(after, second, { roomRecoveryPass: passes.second })).status,
    ).toBe("waiting");
  });

  it("does not take back someone whose admission a host revoked in the recovered meeting", async () => {
    const { before, passes } = await callBeforeRestart();
    const after = await restart(before);
    const first = await join(after, rejoining(guest), {
      roomRecoveryPass: passes.guest,
    });
    const back = await join(after, rejoining(second), {
      roomRecoveryPass: passes.second,
    });
    expect(back.status).toBe("joined");

    const revoked = await send(first.peer, "admin:revokeAllowedUsers", {
      userKeys: [second.userId],
    });
    expect(revoked?.success).toBe(true);
    expect(
      (await join(after, second, { roomRecoveryPass: passes.second })).status,
    ).toBe("waiting");

    await send(first.peer, "admitUser", { userId: second.userId });
    expect((await join(after, second)).status).toBe("joined");
  });

  it("does not take back someone a host revoked before they came back", async () => {
    const { before, passes } = await callBeforeRestart();
    const after = await restart(before);
    const first = await join(after, rejoining(guest), {
      roomRecoveryPass: passes.guest,
    });

    await send(first.peer, "admin:revokeAllowedUsers", {
      userKeys: [second.userId],
    });
    expect(
      (await join(after, second, { roomRecoveryPass: passes.second })).status,
    ).toBe("waiting");
  });

  it("stops renewing the pass of someone whose admission a host revoked", async () => {
    useTestClock();
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);
    const stopRefreshing = startRoomRecoveryPassRefresh(state, config.sfuSecret);
    vi.advanceTimersByTime(MINUTE_MS);

    await send(created.peer, "admin:revokeAllowedUsers", {
      userKeys: [guest.userId],
    });
    const kept = passesHeldBy(member);
    vi.advanceTimersByTime(3 * MINUTE_MS);
    stopRefreshing();
    expect(roomOf(state).clients.size).toBe(2);
    expect(passesHeldBy(member)).toEqual(kept);
  });

  it("stops honouring a pass a few minutes after the SFU last renewed it", async () => {
    useTestClock();
    const { before, passes } = await callBeforeRestart();
    const after = await restart(before);
    await join(after, rejoining(guest), { roomRecoveryPass: passes.guest });

    vi.setSystemTime(Date.now() + 5 * MINUTE_MS + 1000);
    expect(
      (await join(after, second, { roomRecoveryPass: passes.second })).status,
    ).toBe("waiting");
  });

  it("keeps every member's pass good through a long idle call", async () => {
    useTestClock();
    const { before, hostJoin, guestJoin, secondJoin, passes } =
      await callBeforeRestart();
    const members = [hostJoin, guestJoin, secondJoin];
    const stopRefreshing = startRoomRecoveryPassRefresh(before, config.sfuSecret);

    for (let minute = 1; minute <= 30; minute += 1) {
      vi.advanceTimersByTime(MINUTE_MS);
      for (const member of members) {
        // Even a tab that missed the latest renewal holds a pass with time
        // left to get through a restart.
        expect(secondsLeftOn(passesHeldBy(member).at(-2)!)).toBeGreaterThan(120);
      }
    }
    stopRefreshing();
    // Quietly: a renewal every so often, not a stream of them.
    expect(passesHeldBy(guestJoin).length).toBeLessThanOrEqual(31);

    const after = await restart(before);
    const first = await join(after, rejoining(guest), {
      roomRecoveryPass: passesHeldBy(guestJoin).at(-1),
    });
    // The pass from joining half an hour ago ran out long since.
    expect(
      (await join(after, rejoining(second), { roomRecoveryPass: passes.second }))
        .status,
    ).toBe("waiting");
    for (const [user, member] of [
      [host, hostJoin],
      [second, secondJoin],
    ] as const) {
      const back = await join(after, rejoining(user), {
        roomRecoveryPass: passesHeldBy(member).at(-1),
      });
      expect(back.status).toBe("joined");
    }
    expect(roomOf(after).clients.size).toBe(3);
    expect(
      first.peer.emit.mock.calls.filter(([event]) => event === "userRequestedJoin"),
    ).toHaveLength(1);
  });

  it("brings back a member who missed a renewal, on a server whose clock runs ahead", async () => {
    useTestClock();
    const { before, hostJoin, secondJoin } = await callBeforeRestart();
    const stopRefreshing = startRoomRecoveryPassRefresh(before, config.sfuSecret);
    vi.advanceTimersByTime(10 * MINUTE_MS - 1000);
    stopRefreshing();
    const missedOne = passesHeldBy(secondJoin).at(-2);

    // The room comes back on an instance a minute ahead of the one that
    // signed the pass, and the tab gets through two minutes after the crash.
    vi.setSystemTime(Date.now() + 3 * MINUTE_MS);
    const after = await restart(before);
    await join(after, rejoining(host), {
      roomRecoveryPass: passesHeldBy(hostJoin).at(-1),
    });
    expect(
      (await join(after, rejoining(second), { roomRecoveryPass: missedOne })).status,
    ).toBe("joined");
  });

  it("stops renewing a removed member's pass at once, and the one they kept gets them nowhere", async () => {
    useTestClock();
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);
    const stopRefreshing = startRoomRecoveryPassRefresh(state, config.sfuSecret);
    vi.advanceTimersByTime(2 * MINUTE_MS);

    await send(created.peer, "kickUser", { userId: "guest-visitor#v" });
    const kept = passesHeldBy(member);
    vi.advanceTimersByTime(MINUTE_MS);
    expect(passesHeldBy(member)).toEqual(kept);
    expect(passesHeldBy(created).length).toBeGreaterThan(3);
    stopRefreshing();

    // The removal is in the ledger, so the recreated room knows of it even
    // while the kept pass has minutes left.
    const soon = await restart(state);
    await join(soon, rejoining(host));
    expect(
      (await join(soon, guest, { roomRecoveryPass: kept.at(-1) })).status,
    ).toBe("waiting");
  });

  it("gives no pass to a removed member's other device", async () => {
    useTestClock();
    const state = makeState();
    const created = await join(state, host);
    const laptop = { userId: "user-9", email: "sam@example.com", clientId: "conclave", sessionId: "laptop" };
    const phone = { ...laptop, sessionId: "phone" };
    roomOf(state).restoreAdmission("sam@example.com", undefined, { pastLock: true });
    await join(state, laptop);
    const onPhone = await join(state, phone);
    const stopRefreshing = startRoomRecoveryPassRefresh(state, config.sfuSecret);

    await send(created.peer, "kickUser", { userId: "sam@example.com#laptop" });
    const kept = passesHeldBy(onPhone);
    vi.advanceTimersByTime(3 * MINUTE_MS);
    stopRefreshing();
    expect(passesHeldBy(onPhone)).toEqual(kept);
  });

  it("issues a pass that cannot be used to sign in to the SFU", async () => {
    const { passes } = await callBeforeRestart();
    const claims = jwt.decode(passes.guest ?? "");
    expect(claims).toBeTypeOf("object");
    expect(isNonJoinToken(claims as jwt.JwtPayload)).toBe(true);
  });
});

describe("who hosts a call the server lost", () => {
  // A host, a member and someone still knocking, then the SFU loses the room.
  // Scheduled links and links from older web tabs ask to open the room on
  // every join, so the knocker's tab asks too.
  const knockerAsking = { ...knocker, allowRoomCreation: true };
  const lostCall = async (options: { scheduled?: boolean } = {}) => {
    const before = makeState();
    if (options.scheduled) schedule(before);
    const hostJoin = await join(before, host);
    roomOf(before).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const guestJoin = await join(before, guest);
    expect((await join(before, knockerAsking)).status).toBe("waiting");
    return {
      before,
      hostPass: hostJoin.response.roomRecoveryPass,
      guestPass: guestJoin.response.roomRecoveryPass,
    };
  };

  it.each([
    ["a scheduled link", true],
    ["an older link that always asks to open the room", false],
  ])(
    "keeps someone who was only knocking out of the host's seat when they are first back, on %s",
    async (_link, scheduled) => {
      const { before, hostPass, guestPass } = await lostCall({ scheduled });
      const after = await restart(before);

      const knockerBack = await join(after, knockerAsking);
      expect(knockerBack.status).toBe("waiting");
      expect(roomOf(after).getAdmins()).toHaveLength(0);

      const member = await join(
        after,
        { ...guest, allowRoomCreation: true },
        { roomRecoveryPass: guestPass },
      );
      expect(member.status).toBe("joined");
      expect(member.context.currentClient).toBeInstanceOf(Admin);
      expect(knocksShownTo(member)).toContain(knocker.userId);

      const realHost = await join(after, host, { roomRecoveryPass: hostPass });
      expect(realHost.status).toBe("joined");
      expect(realHost.context.currentClient).toBeInstanceOf(Admin);
      expect(roomOf(after).isLocked).toBe(true);
      expect(roomOf(after).pendingClients.has(knocker.userId)).toBe(true);
    },
  );

  it("gives the call back to its host from an app that keeps no pass", async () => {
    const { before } = await lostCall();
    const after = await restart(before);
    expect((await join(after, knockerAsking)).status).toBe("waiting");

    const hostBack = await join(after, host);
    expect(hostBack.status).toBe("joined");
    expect(hostBack.context.currentClient).toBeInstanceOf(Admin);
    expect(knocksShownTo(hostBack)).toContain(knocker.userId);
  });

  it("shows the host the knock again after the restart, and admitting it lets the knocker in", async () => {
    const { before } = await lostCall();
    const after = await restart(before);
    const knockerBack = await join(after, knockerAsking);
    expect(knockerBack.status).toBe("waiting");

    const hostBack = await join(after, host);
    expect(knocksShownTo(hostBack)).toContain(knocker.userId);
    const admitted = await send(hostBack.peer, "admitUser", { userId: knocker.userId });
    expect(admitted?.success).toBe(true);
    expect(
      knockerBack.peer.emit.mock.calls.some(([event]) => event === "joinApproved"),
    ).toBe(true);
    expect((await join(after, knockerAsking)).status).toBe("joined");
  });

  it("makes a member without a pass wait for a host when they are first back", async () => {
    const { before } = await lostCall();
    const after = await restart(before);

    const memberBack = await join(after, { ...guest, allowRoomCreation: true });
    expect(memberBack.status).toBe("waiting");
    const hostBack = await join(after, host);
    expect(hostBack.context.currentClient).toBeInstanceOf(Admin);
    expect(knocksShownTo(hostBack)).toContain(guest.userId);
  });

  it("still makes a knocker wait if they leave and come straight back", async () => {
    const { before } = await lostCall();
    const after = await restart(before);

    const firstTry = await join(after, knockerAsking);
    expect(firstTry.status).toBe("waiting");
    await hangUp(firstTry.peer);
    expect(after.rooms.size).toBe(0);

    expect((await join(after, knockerAsking)).status).toBe("waiting");
  });

  it("treats a room lost with its media worker the same way", async () => {
    const { before, guestPass } = await lostCall();
    forceCloseRoom(before, CHANNEL);

    expect((await join(before, knockerAsking)).status).toBe("waiting");
    const member = await join(before, guest, { roomRecoveryPass: guestPass });
    expect(member.context.currentClient).toBeInstanceOf(Admin);
  });

  it("lets the next visitor open the meeting once the lost call is long gone", async () => {
    useTestClock();
    const { before } = await lostCall();
    const after = await restart(before);
    expect((await join(after, knockerAsking)).status).toBe("waiting");

    vi.advanceTimersByTime(8 * MINUTE_MS);
    const later = await join(after, knockerAsking);
    expect(later.status).toBe("joined");
    expect(later.context.currentClient).toBeInstanceOf(Admin);
  });

  describe("when a host's seat changed just before the loss", () => {
    const guestSeat = "guest-visitor#v";
    // Alice hosts, Bob (guest) and Cara (second) are in the call.
    const callOfThree = async () => {
      useTestClock();
      const before = makeState();
      const created = await join(before, host);
      roomOf(before).restoreAdmission(guest.userId, undefined, { pastLock: true });
      roomOf(before).restoreAdmission(second.userId, undefined, { pastLock: true });
      const bob = await join(before, guest);
      const cara = await join(before, second);
      const stopRefreshing = startRoomRecoveryPassRefresh(before, config.sfuSecret);
      return { before, created, bob, cara, stopRefreshing };
    };

    it("does not hand a removed co-host their seat back", async () => {
      const { before, created, bob, stopRefreshing } = await callOfThree();
      await send(created.peer, "promoteHost", { userId: guestSeat });
      vi.advanceTimersByTime(MINUTE_MS);
      await send(created.peer, "kickUser", { userId: guestSeat });
      stopRefreshing();
      const after = await restart(before);

      // First back, from a tab that asks to open the room, with the pass
      // they kept.
      const bobBack = await join(
        after,
        { ...guest, allowRoomCreation: true },
        { roomRecoveryPass: passesHeldBy(bob).at(-1) },
      );
      expect(bobBack.status).toBe("waiting");
      const hostBack = await join(after, host);
      expect(hostBack.context.currentClient).toBeInstanceOf(Admin);
      expect(knocksShownTo(hostBack)).toContain(guest.userId);
    });

    it("does not hand it back when another member recreates the room first", async () => {
      const { before, created, cara, stopRefreshing } = await callOfThree();
      await send(created.peer, "promoteHost", { userId: guestSeat });
      vi.advanceTimersByTime(MINUTE_MS);
      await send(created.peer, "kickUser", { userId: guestSeat });
      stopRefreshing();
      const after = await restart(before);

      const caraBack = await join(
        after,
        { ...second, allowRoomCreation: true },
        { roomRecoveryPass: passesHeldBy(cara).at(-1) },
      );
      expect(caraBack.context.currentClient).toBeInstanceOf(Admin);
      const bobBack = await join(after, { ...guest, allowRoomCreation: true });
      expect(bobBack.status).toBe("waiting");
      expect(roomOf(after).isAdminUserKey(guest.userId)).toBe(false);
    });

    it("keeps a co-host who was promoted a moment before", async () => {
      const { before, created, stopRefreshing } = await callOfThree();
      await send(created.peer, "promoteHost", { userId: guestSeat });
      stopRefreshing();
      const after = await restart(before);

      const bobBack = await join(after, { ...guest, allowRoomCreation: true });
      expect(bobBack.status).toBe("joined");
      expect(bobBack.context.currentClient).toBeInstanceOf(Admin);
    });

    it("gives the seat to whoever it was transferred to a moment before", async () => {
      const { before, created, stopRefreshing } = await callOfThree();
      await send(created.peer, "admin:transferHost", { userId: guestSeat });
      stopRefreshing();
      const after = await restart(before);

      const bobBack = await join(after, { ...guest, allowRoomCreation: true });
      expect(bobBack.context.currentClient).toBeInstanceOf(Admin);
      expect(bobBack.response.hostUserId).toBe(guestSeat);
    });
  });

  describe("once the lost call's time is up", () => {
    const useFullTestClock = () => {
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    };
    const toldToTryAgain = (peer: ReturnType<typeof makeSocket>) =>
      peer.emit.mock.calls.some(([event]) => event === "joinApproved");

    it("asks the people still waiting to try joining again", async () => {
      useFullTestClock();
      const { before } = await lostCall();
      const after = await restart(before);
      const waiting = await join(after, knockerAsking);
      expect(waiting.status).toBe("waiting");

      vi.advanceTimersByTime(6 * MINUTE_MS);
      expect(toldToTryAgain(waiting.peer)).toBe(false);
      vi.advanceTimersByTime(2 * MINUTE_MS);
      expect(toldToTryAgain(waiting.peer)).toBe(true);

      const again = await join(after, knockerAsking);
      expect(again.status).toBe("joined");
      expect(again.context.currentClient).toBeInstanceOf(Admin);
    });

    // Two knockers wait in the room recreated for the lost call; one leaves,
    // and with nobody in it the room closes.
    const otherKnockerLeft = async (remaining: typeof knocker) => {
      useFullTestClock();
      const { before } = await lostCall();
      const after = await restart(before);
      const leaving = await join(after, {
        ...knockerAsking,
        userId: "guest-second-knocker",
        sessionId: "k2",
      });
      const waiting = await join(after, remaining);
      expect([leaving.status, waiting.status]).toEqual(["waiting", "waiting"]);
      await hangUp(leaving.peer);
      expect(after.rooms.size).toBe(0);
      return { after, waiting };
    };

    it("still asks a knocker to try again on time once the other knocker has left", async () => {
      const { after, waiting } = await otherKnockerLeft(knockerAsking);

      vi.advanceTimersByTime(6 * MINUTE_MS);
      expect(toldToTryAgain(waiting.peer)).toBe(false);
      vi.advanceTimersByTime(2 * MINUTE_MS);
      expect(toldToTryAgain(waiting.peer)).toBe(true);

      const again = await askAgain(waiting);
      expect(again.status).toBe("joined");
      expect(waiting.context.currentClient).toBeInstanceOf(Admin);
      expect(roomOf(after).pendingClients.has(knocker.userId)).toBe(false);
    });

    it("keeps one who may not open the code waiting for whoever opens it", async () => {
      const { after, waiting } = await otherKnockerLeft(knocker);
      vi.advanceTimersByTime(8 * MINUTE_MS);
      expect(toldToTryAgain(waiting.peer)).toBe(true);
      expect((await askAgain(waiting)).status).toBe("waiting");

      const opener = await join(after, { ...guest, allowRoomCreation: true });
      expect(opener.context.currentClient).toBeInstanceOf(Admin);
      expect(knocksShownTo(opener)).toEqual([knocker.userId]);
    });

    it("does not make the lost call's host a host of the meeting opened after it", async () => {
      useFullTestClock();
      const { before } = await lostCall();
      const after = await restart(before);
      await join(after, knockerAsking);
      vi.advanceTimersByTime(8 * MINUTE_MS);
      const newHost = await join(after, knockerAsking);
      expect(newHost.context.currentClient).toBeInstanceOf(Admin);

      const oldHost = await join(after, host);
      expect(oldHost.status).toBe("waiting");
      expect(roomOf(after).isAdminUserKey(host.userId)).toBe(false);
      expect(roomOf(after).hostUserKey).toBe(knocker.userId);
    });
  });

  describe("on an SFU that has no record of the lost call", () => {
    // Another host: its ledger is its own, and empty.
    const elsewhere = () => makeState();

    it("lets pass holders back into the call but gives none of them the host's seat", async () => {
      const { hostPass, guestPass } = await lostCall();
      const other = elsewhere();

      const member = await join(
        other,
        { ...guest, allowRoomCreation: true },
        { roomRecoveryPass: guestPass },
      );
      expect(member.status).toBe("joined");
      const formerHost = await join(other, host, { roomRecoveryPass: hostPass });
      expect(formerHost.status).toBe("joined");
      expect(roomOf(other).getAdmins()).toHaveLength(0);
      expect((await join(other, knockerAsking)).status).toBe("waiting");
    });

    it("gives the call a host once no pass from it can still be good", async () => {
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
      const { guestPass } = await lostCall();
      const other = elsewhere();
      const member = await join(
        other,
        { ...guest, allowRoomCreation: true },
        { roomRecoveryPass: guestPass },
      );
      await join(other, knockerAsking);

      vi.advanceTimersByTime(7 * MINUTE_MS);
      expect(member.context.currentClient).toBeInstanceOf(Admin);
      expect(knocksShownTo(member)).toContain(knocker.userId);
    });

    it("still lets the first visitor without a pass open the meeting", async () => {
      const other = elsewhere();
      const visitor = await join(other, knockerAsking);
      expect(visitor.status).toBe("joined");
      expect(visitor.context.currentClient).toBeInstanceOf(Admin);
    });
  });

  it("keeps saving the meeting that replaces a room which emptied while a join waited on it", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const state = makeState();
    const recovery = durableOf.get(state)!.recovery;

    // The host's join reads the recovery record, and is held right after.
    const read = recovery.read.bind(recovery);
    let readDone = false;
    let readGoesOn: () => void = () => {};
    const readHeld = new Promise<void>((resolve) => (readGoesOn = resolve));
    recovery.read = async (channelId) => {
      recovery.read = read;
      const answer = await read(channelId);
      readDone = true;
      await readHeld;
      return answer;
    };
    const hostJoining = join(state, host);
    await vi.waitFor(() => expect(readDone).toBe(true));

    // Where the join reads before it holds the room, Dan can open the room
    // in between and host it. The host's join then finds Dan's room and
    // waits on its lease, and Dan's room empties during the wait.
    if (!state.roomCreations.has(CHANNEL)) {
      const dan = await join(state, { ...knocker, allowRoomCreation: true });
      expect(dan.context.currentClient).toBeInstanceOf(Admin);
      const registry = state.roomRegistry;
      const renewRoom = registry.renewRoom.bind(registry);
      let renewalStarted = false;
      let renewalGoesOn: () => void = () => {};
      const renewalHeld = new Promise<void>((resolve) => (renewalGoesOn = resolve));
      registry.renewRoom = async (input) => {
        registry.renewRoom = renewRoom;
        renewalStarted = true;
        await renewalHeld;
        return renewRoom(input);
      };
      readGoesOn();
      await vi.waitFor(() => expect(renewalStarted).toBe(true));
      await hangUp(dan.peer);
      vi.advanceTimersByTime(10 * MINUTE_MS);
      expect(state.rooms.size).toBe(0);
      renewalGoesOn();
    } else {
      readGoesOn();
    }

    // The host's join creates the room that replaces Dan's.
    const hostIn = await hostJoining;
    expect(hostIn.context.currentClient).toBeInstanceOf(Admin);
    const replacement = roomOf(state).incarnationId;

    // A removal there is saved: after a restart the removed guest's pass
    // gets her nowhere.
    roomOf(state).restoreAdmission(second.userId, undefined, { pastLock: true });
    const cara = await join(state, second);
    await send(hostIn.peer, "kickUser", { userId: `${second.userId}#${second.sessionId}` });
    const afterRemoval = await restart(state);
    expect(
      (
        await join(
          afterRemoval,
          { ...second, allowRoomCreation: true },
          { roomRecoveryPass: cara.response.roomRecoveryPass },
        )
      ).status,
    ).toBe("waiting");

    // And so is the end.
    await send(hostIn.peer, "admin:endRoom", {});
    const saved = (await recovery.read(CHANNEL)) as { writer?: string; overAt?: number | null };
    expect(saved.writer).toBe(replacement);
    expect(saved.overAt).toBeTypeOf("number");
  });

  it("keeps what the SFU that took a call over wrote when the SFU it took it from writes again", async () => {
    const first = makeState();
    await join(first, host);
    // Another SFU on the same ledger takes the call over, and its host makes
    // Bob a co-host there.
    const second = makeState(durableOf.get(first));
    const hostOnSecond = await join(second, host);
    expect(hostOnSecond.context.currentClient).toBeInstanceOf(Admin);
    roomOf(second).restoreAdmission(guest.userId, undefined, { pastLock: true });
    await join(second, guest);
    await send(hostOnSecond.peer, "promoteHost", { userId: "guest-visitor#v" });

    // The first SFU never learned of that, and writes what it knows.
    first.roomRecovery.noteRunning(roomOf(first));
    first.roomRecovery.noteOver(roomOf(first));

    // The call is still the one the second SFU was running: someone who was
    // only knocking waits, and Bob is a host of it.
    const after = await restart(second);
    expect((await join(after, knockerAsking)).status).toBe("waiting");
    const bobBack = await join(after, { ...guest, allowRoomCreation: true });
    expect(bobBack.context.currentClient).toBeInstanceOf(Admin);
  });

  it("gives a host their own meeting back when they reopen it after it emptied, pass in hand", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const before = makeState();
    const created = await join(before, host);
    await hangUp(created.peer);
    vi.advanceTimersByTime(3 * MINUTE_MS);
    expect(before.rooms.size).toBe(0);

    // A reload: the tab still holds the pass it was handed three minutes ago.
    const sameSfu = await join(before, host, {
      roomRecoveryPass: created.response.roomRecoveryPass,
    });
    expect(sameSfu.context.currentClient).toBeInstanceOf(Admin);
    await hangUp(sameSfu.peer);
    vi.advanceTimersByTime(3 * MINUTE_MS);

    const afterRestart = await join(await restart(before), host, {
      roomRecoveryPass: sameSfu.response.roomRecoveryPass,
    });
    expect(afterRestart.status).toBe("joined");
    expect(afterRestart.context.currentClient).toBeInstanceOf(Admin);
  });

  it("opens a meeting that emptied on purpose for its next visitor", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const before = makeState();
    const created = await join(before, host);
    await hangUp(created.peer);
    vi.advanceTimersByTime(10 * MINUTE_MS);
    expect(before.rooms.size).toBe(0);
    const after = await restart(before);

    const visitor = await join(after, knockerAsking);
    expect(visitor.status).toBe("joined");
    expect(visitor.context.currentClient).toBeInstanceOf(Admin);
  });
});

describe("an invited attendee the host removed, after a restart", () => {
  it("still has to be let in again, and is invited again once a host does", async () => {
    const before = makeState();
    schedule(before);
    const created = await join(before, host);
    const invited = await join(before, invitee);
    expect(invited.status).toBe("joined");
    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });

    const after = await restart(before);
    const hostBack = await join(after, host);
    expect(
      (await join(after, invitee, { roomRecoveryPass: invited.response.roomRecoveryPass }))
        .status,
    ).toBe("waiting");

    await send(hostBack.peer, "admitUser", { userId: "invitee@example.com" });
    const later = await restart(after);
    await join(later, host);
    expect((await join(later, invitee)).status).toBe("joined");
  });

  it("is not counted as invited when the web asks who may see the headcount", async () => {
    const before = makeState();
    schedule(before);
    const created = await join(before, host);
    await join(before, invitee);
    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });

    const after = await restart(before);
    expect(
      isScheduledMeetingInvitee(
        after.scheduledMeetings,
        "conclave",
        "abc-mnop-xyz",
        "invitee@example.com",
      ),
    ).toBe(false);
  });
});

describe("the account a code belongs to", () => {
  // A signed-in account: its verified email is in the join token.
  const owner = {
    userId: "owner@example.com",
    email: "owner@example.com",
    clientId: "conclave",
    sessionId: "o",
    allowRoomCreation: true,
  };
  const guestOpener = { ...guest, allowRoomCreation: true };
  const anotherGuest = { ...knocker, allowRoomCreation: true };
  const scheduledHost = {
    userId: "host@example.com",
    email: "host@example.com",
    clientId: "conclave",
    sessionId: "sh",
    allowRoomCreation: true,
  };
  const emptyOut = async (state: SfuState, ...peers: Array<ReturnType<typeof makeSocket>>) => {
    for (const peer of peers) await hangUp(peer);
    vi.advanceTimersByTime(10 * MINUTE_MS);
    expect(state.rooms.size).toBe(0);
  };
  const useClock = () =>
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  const toldTheyNoLongerHost = (member: Awaited<ReturnType<typeof join>>) =>
    member.peer.emit.mock.calls.some(([event]) => event === "hostRemoved");

  it("hosts again when they come back to a meeting a guest reopened, and the guest is a participant", async () => {
    useClock();
    const state = makeState();
    const created = await join(state, owner);
    await emptyOut(state, created.peer);

    const opener = await join(state, guestOpener);
    expect(opener.context.currentClient).toBeInstanceOf(Admin);
    const back = await join(state, owner);

    expect(back.status).toBe("joined");
    expect(back.context.currentClient).toBeInstanceOf(Admin);
    expect(roomOf(state).getHostUserId()).toBe("owner@example.com#o");
    expect(opener.context.currentClient).not.toBeInstanceOf(Admin);
    expect(toldTheyNoLongerHost(opener)).toBe(true);
    expect(
      opener.peer.emit.mock.calls.some(
        ([event, sent]) =>
          event === "adminNotice" &&
          (sent as { message: string }).message.includes("owner joined"),
      ),
    ).toBe(true);
  });

  it("is let in without knocking even though the guest locked the meeting", async () => {
    useClock();
    const state = makeState();
    const created = await join(state, owner);
    await emptyOut(state, created.peer);
    await join(state, guestOpener);
    expect(roomOf(state).isLocked).toBe(true);

    expect((await join(state, owner)).status).toBe("joined");
  });

  it("still owns the code after the SFU restarts", async () => {
    useClock();
    const before = makeState();
    const created = await join(before, owner);
    await emptyOut(before, created.peer);
    const after = await restart(before);

    const opener = await join(after, guestOpener);
    const back = await join(after, owner);
    expect(back.context.currentClient).toBeInstanceOf(Admin);
    expect(opener.context.currentClient).not.toBeInstanceOf(Admin);
  });

  it("hosts the scheduled meeting they booked even when an invitee opened it first", async () => {
    useClock();
    const state = makeState();
    schedule(state);
    const attendee = await join(state, { ...invitee, allowRoomCreation: true });
    expect(attendee.context.currentClient).toBeInstanceOf(Admin);

    const booker = await join(state, scheduledHost);
    expect(booker.status).toBe("joined");
    expect(booker.context.currentClient).toBeInstanceOf(Admin);
    expect(attendee.context.currentClient).not.toBeInstanceOf(Admin);
  });

  it("is never a member whose pass brings an earlier call back on an SFU with no record of it", async () => {
    const member = {
      userId: "member@example.com",
      email: "member@example.com",
      clientId: "conclave",
      sessionId: "m",
    };
    const before = makeState();
    await join(before, host);
    roomOf(before).restoreAdmission("member@example.com", undefined, { pastLock: true });
    const inCall = await join(before, member);
    const elsewhere = makeState();

    const back = await join(
      elsewhere,
      { ...member, allowRoomCreation: true },
      { roomRecoveryPass: inCall.response.roomRecoveryPass },
    );
    expect(back.status).toBe("joined");
    expect(back.context.currentClient).not.toBeInstanceOf(Admin);
    expect(roomOf(elsewhere).ownerEmail).toBeNull();
  });

  it("keeps a real co-host who brought the call back first", async () => {
    useClock();
    const before = makeState();
    const created = await join(before, owner);
    roomOf(before).restoreAdmission(guest.userId, undefined, { pastLock: true });
    await join(before, guest);
    await send(created.peer, "promoteHost", { userId: "guest-visitor#v" });
    const after = await restart(before);

    const coHost = await join(after, guestOpener);
    expect(coHost.context.currentClient).toBeInstanceOf(Admin);
    await join(after, owner);
    expect(coHost.context.currentClient).toBeInstanceOf(Admin);
    expect(toldTheyNoLongerHost(coHost)).toBe(false);
  });

  it("does not undo a promotion of their own when they reconnect", async () => {
    useClock();
    const state = makeState();
    const created = await join(state, owner);
    await emptyOut(state, created.peer);
    const opener = await join(state, guestOpener);
    const back = await join(state, owner);
    expect(opener.context.currentClient).not.toBeInstanceOf(Admin);
    await send(back.peer, "promoteHost", { userId: "guest-visitor#v" });
    expect(opener.context.currentClient).toBeInstanceOf(Admin);

    await join(state, owner);
    expect(opener.context.currentClient).toBeInstanceOf(Admin);
  });

  it("leaves the guest they took the host's seat from in the meeting, without knocking again", async () => {
    useClock();
    const state = makeState();
    const created = await join(state, owner);
    await emptyOut(state, created.peer);
    await join(state, guestOpener);
    await join(state, owner);

    expect((await join(state, guestOpener)).status).toBe("joined");
  });

  it("takes the seat back from a guest who reopened the meeting, also after the SFU restarts", async () => {
    useClock();
    const before = makeState();
    const created = await join(before, owner);
    await emptyOut(before, created.peer);
    await join(before, guestOpener);
    const after = await restart(before);

    const openerBack = await join(after, guestOpener);
    expect(openerBack.context.currentClient).toBeInstanceOf(Admin);
    await join(after, owner);
    expect(openerBack.context.currentClient).not.toBeInstanceOf(Admin);
  });

  it("is not an account a guest made the code with: the first to arrive hosts", async () => {
    useClock();
    const state = makeState();
    const created = await join(state, guestOpener);
    await emptyOut(state, created.peer);

    const someoneElse = await join(state, anotherGuest);
    expect(someoneElse.context.currentClient).toBeInstanceOf(Admin);
    expect((await join(state, guestOpener)).status).toBe("waiting");
  });

  // A fresh tab, or another browser on the same account, keeps no record of
  // having been in the meeting, so the web does not ask to open the code.
  const inAFreshTab = (account: typeof owner, sessionId: string) => ({
    ...account,
    sessionId,
    allowRoomCreation: false,
  });

  it.each([
    ["a fresh tab", "fresh-tab"],
    ["another browser signed in to the same account", "other-browser"],
  ])("reopens their emptied meeting from %s, as its host", async (_, sessionId) => {
    useClock();
    const state = makeState();
    const created = await join(state, owner);
    await emptyOut(state, created.peer);

    const back = await join(state, inAFreshTab(owner, sessionId));
    expect(back.status).toBe("joined");
    expect(back.context.currentClient).toBeInstanceOf(Admin);
  });

  it("reopens it from a fresh tab after the SFU restarts", async () => {
    useClock();
    const before = makeState();
    const created = await join(before, owner);
    await emptyOut(before, created.peer);
    const after = await restart(before);

    const back = await join(after, inAFreshTab(owner, "fresh-tab"));
    expect(back.status).toBe("joined");
    expect(back.context.currentClient).toBeInstanceOf(Admin);
  });

  it("reopens the scheduled meeting they booked from a fresh tab", async () => {
    useClock();
    const state = makeState();
    schedule(state);
    const back = await join(state, inAFreshTab(scheduledHost, "fresh-tab"));
    expect(back.status).toBe("joined");
    expect(back.context.currentClient).toBeInstanceOf(Admin);
  });

  // The meeting at the owner's code is over: ended for everyone or emptied,
  // and then perhaps the SFU restarted.
  const overBy = async (ending: "ended" | "emptied", restarted: boolean) => {
    useClock();
    const state = makeState();
    const created = await join(state, owner);
    if (ending === "ended") await send(created.peer, "admin:endRoom", {});
    await emptyOut(state, created.peer);
    return restarted ? restart(state) : state;
  };
  const strangerInAFreshTab = inAFreshTab(
    { ...owner, userId: "other@example.com", email: "other@example.com" },
    "stranger",
  );

  it.each([
    ["ended for everyone", "ended", false],
    ["emptied", "emptied", false],
    ["ended for everyone, and the SFU restarted", "ended", true],
    ["emptied, and the SFU restarted", "emptied", true],
  ] as const)(
    "reopens their meeting from a fresh tab once it was %s, and no one else can",
    async (_, ending, restarted) => {
      const state = await overBy(ending, restarted);

      const stranger = await join(state, strangerInAFreshTab);
      expect(stranger.status).toBeUndefined();
      expect(stranger.response.error).toBeTruthy();
      const visitor = await join(state, guest);
      expect(visitor.status).toBeUndefined();
      expect(state.rooms.size).toBe(0);

      const back = await join(state, inAFreshTab(owner, "fresh-tab"));
      expect(back.status).toBe("joined");
      expect(back.context.currentClient).toBeInstanceOf(Admin);
    },
  );

  it("does not let another account or a guest open the emptied code from a fresh tab", async () => {
    useClock();
    const state = makeState();
    const created = await join(state, owner);
    await emptyOut(state, created.peer);
    const other = { ...owner, userId: "other@example.com", email: "other@example.com" };

    expect((await join(state, inAFreshTab(other, "x"))).response.error).toBe("No room found.");
    expect((await join(state, guest)).response.error).toBe("No room found.");
    expect(state.rooms.size).toBe(0);
  });

  it("is not whoever signs in next: another account knocks", async () => {
    useClock();
    const state = makeState();
    await join(state, owner);
    const other = { ...owner, userId: "other@example.com", email: "other@example.com", sessionId: "x" };
    expect((await join(state, other)).status).toBe("waiting");
  });
});

describe("an invited attendee a host removed, once that meeting is over", () => {
  // A host removes the invitee, then the meeting ends: by its last person
  // leaving, or by a host ending it for everyone.
  const removedThenOver = async (ending: "emptied" | "ended") => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const state = makeState();
    schedule(state);
    const created = await join(state, host);
    const invited = await join(state, invitee);
    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });
    const knocking = await join(state, invitee);
    expect(knocking.status).toBe("waiting");
    if (ending === "ended") await send(created.peer, "admin:endRoom", {});
    await hangUp(knocking.peer);
    await hangUp(invited.peer);
    await hangUp(created.peer);
    vi.advanceTimersByTime(10 * MINUTE_MS);
    expect(state.rooms.size).toBe(0);
    return state;
  };

  it.each(["emptied", "ended"] as const)(
    "joins the next meeting at the code directly after it %s, and knocks once removed again",
    async (ending) => {
      const state = await removedThenOver(ending);
      const reopened = await join(state, host);
      expect((await join(state, invitee)).status).toBe("joined");

      await send(reopened.peer, "kickUser", { userId: "invitee@example.com#i" });
      expect((await join(state, invitee)).status).toBe("waiting");
    },
  );

  it("joins it directly after a restart too", async () => {
    const state = await removedThenOver("emptied");
    const after = await restart(state);
    await join(after, host);
    expect((await join(after, invitee)).status).toBe("joined");
  });
});

describe("a meeting whose last participant leaves while someone is still knocking", () => {
  const statusesShownTo = (member: Awaited<ReturnType<typeof join>>): string[] =>
    member.peer.emit.mock.calls
      .filter(([event]) => event === "waitingRoomStatus")
      .map(([, sent]) => (sent as { message: string }).message);
  // A host removes an invitee and a guest knocks. Then everyone in the
  // meeting leaves; the guest is still waiting.
  const everyoneLeftButTheKnocker = async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const state = makeState();
    schedule(state);
    const created = await join(state, host);
    const invited = await join(state, invitee);
    expect(invited.status).toBe("joined");
    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });
    const knocking = await join(state, knocker);
    expect(knocking.status).toBe("waiting");
    await hangUp(invited.peer);
    await hangUp(created.peer);
    vi.advanceTimersByTime(10 * MINUTE_MS);
    return { state, knocking, pass: created.response.roomRecoveryPass };
  };

  it("is over: the invitee the host removed joins the next meeting directly", async () => {
    const { state } = await everyoneLeftButTheKnocker();
    await join(state, host);
    expect((await join(state, invitee)).status).toBe("joined");
  });

  it("is over after a restart too", async () => {
    const { state } = await everyoneLeftButTheKnocker();
    const after = await restart(state);
    await join(after, host);
    expect((await join(after, invitee)).status).toBe("joined");
  });

  it("takes nobody back on a pass from it", async () => {
    const { state, pass } = await everyoneLeftButTheKnocker();
    await join(state, { ...knocker, userId: "guest-opener", sessionId: "op", allowRoomCreation: true });
    expect((await join(state, host, { roomRecoveryPass: pass })).status).toBe("waiting");
  });

  it("tells the knocker it ended, keeps them waiting, and shows them to the next meeting's host", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    expect(statusesShownTo(knocking).at(-1)).toMatch(/ended/i);
    expect(statusesShownTo(knocking).at(-1)).toMatch(/no one to let you in/i);

    const reopened = await join(state, host);
    expect(knocksShownTo(reopened)).toEqual(["guest-knocker"]);
    expect(statusesShownTo(knocking).at(-1)).toMatch(/host is available/i);
    expect(await send(reopened.peer, "admitUser", { userId: "guest-knocker" })).toEqual({
      success: true,
    });
    expect(knocking.peer.emit).toHaveBeenCalledWith("joinApproved", expect.anything());
    expect((await join(state, knocker)).status).toBe("joined");
  });

  it("does not show the next meeting's host a knocker who gave up in between", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    await hangUp(knocking.peer);
    const reopened = await join(state, host);
    expect(knocksShownTo(reopened)).toEqual([]);
  });

  it("keeps a knocker who asks again before the next meeting opens waiting for it", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    expect((await askAgain(knocking)).status).toBe("waiting");
    expect(statusesShownTo(knocking).at(-1)).toMatch(/ended/i);

    const reopened = await join(state, host);
    expect(knocksShownTo(reopened)).toEqual(["guest-knocker"]);
  });

  // The knocker's tab asks again, and that join stops at the registry
  // until the test lets it go on.
  const askAgainHeldAtTheRegistry = (
    state: SfuState,
    knocking: Awaited<ReturnType<typeof join>>,
  ) => {
    const registry = state.roomRegistry;
    const lookUp = registry.getAssignment.bind(registry);
    let goOn = () => {};
    const held = new Promise<void>((resolve) => (goOn = resolve));
    let heldOnce = false;
    registry.getAssignment = async (channelId) => {
      if (!heldOnce) {
        heldOnce = true;
        await held;
      }
      return lookUp(channelId);
    };
    const reply = askAgain(knocking);
    expect(heldOnce).toBe(true);
    return { reply, goOn };
  };
  const knocksAskedOf = (member: Awaited<ReturnType<typeof join>>) =>
    member.peer.emit.mock.calls
      .filter(([event]) => event === "userRequestedJoin")
      .map(([, sent]) => (sent as { userId: string }).userId);

  it("takes a knocker whose retry was still being decided into the meeting that opened meanwhile", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    const retry = askAgainHeldAtTheRegistry(state, knocking);

    const reopened = await join(state, host);
    retry.goOn();
    expect((await retry.reply).status).toBe("waiting");

    expect(roomOf(state).pendingClients.has(knocker.userId)).toBe(true);
    expect(state.nextMeetingLobbies.size).toBe(0);
    expect([...knocksShownTo(reopened), ...knocksAskedOf(reopened)]).toContain(knocker.userId);
    expect(await send(reopened.peer, "admitUser", { userId: knocker.userId })).toEqual({
      success: true,
    });
    expect((await askAgain(knocking)).status).toBe("joined");
  });

  it("seats a knocker the host let in while their retry was still being decided, with no second knock", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    const retry = askAgainHeldAtTheRegistry(state, knocking);
    const reopened = await join(state, host);
    expect(knocksShownTo(reopened)).toEqual([knocker.userId]);
    expect(await send(reopened.peer, "admitUser", { userId: knocker.userId })).toEqual({
      success: true,
    });

    retry.goOn();
    expect((await retry.reply).status).toBe("joined");
    expect(knocking.context.currentRoom).toBe(roomOf(state));
    expect(roomOf(state).pendingClients.has(knocker.userId)).toBe(false);
    expect(knocksAskedOf(reopened)).toEqual([]);
  });

  it("leaves a knocker's seat alone when a retry older than the join that seated them ends", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    const retry = askAgainHeldAtTheRegistry(state, knocking);
    const reopened = await join(state, host);
    expect(await send(reopened.peer, "admitUser", { userId: knocker.userId })).toEqual({
      success: true,
    });
    // The tab answers "joinApproved" with a join of its own, which seats it
    // before the older retry gets its answer from the registry.
    expect((await askAgain(knocking)).status).toBe("joined");
    const seat = knocking.context.currentClient!;
    const closing = vi.spyOn(seat, "close");

    retry.goOn();
    expect((await retry.reply).error).toBe("A newer join from this connection took over.");
    expect(knocking.context.currentClient).toBe(seat);
    expect(roomOf(state).getClient(seat.id)).toBe(seat);
    expect(closing).not.toHaveBeenCalled();
    expect(knocksAskedOf(reopened)).toEqual([]);
  });

  it("does not knock again for a knocker the host turned away while their retry was still being decided", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    const retry = askAgainHeldAtTheRegistry(state, knocking);
    const reopened = await join(state, host);
    expect(await send(reopened.peer, "rejectUser", { userId: knocker.userId })).toEqual({
      success: true,
    });
    // The turned-away tab goes back to setup and closes its connection.
    (knocking.peer.socket as { connected: boolean }).connected = false;
    await hangUp(knocking.peer);

    retry.goOn();
    await retry.reply;
    expect(roomOf(state).pendingClients.has(knocker.userId)).toBe(false);
    expect(knocksAskedOf(reopened)).toEqual([]);
  });

  it("does not show the next meeting's host a knocker who went to another code", async () => {
    const { state, knocking } = await everyoneLeftButTheKnocker();
    expect((await askAgain(knocking, "other-code-xyz")).error).toBe("No room found.");
    const reopened = await join(state, host);
    expect(knocksShownTo(reopened)).toEqual([]);
  });
});

// SFUs that share a room registry over a real Redis, where one is installed.
const redisServerPath = (() => {
  try {
    return execFileSync("which", ["redis-server"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

describe.skipIf(!redisServerPath)("knockers waiting on an SFU when the next meeting opens on another", () => {
  let redis: { process: ChildProcess; port: number; dir: string } | null = null;
  const registries: RoomRegistry[] = [];
  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    const dir = mkdtempSync(joinPath(tmpdir(), "knock-redis-"));
    redis = {
      process: spawn(
        redisServerPath,
        ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir],
        { stdio: "ignore" },
      ),
      port,
      dir,
    };
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = createConnection({ port, host: "127.0.0.1" });
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        }),
      { timeout: 20_000, interval: 50 },
    );
  }, 30_000);
  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.close();
  });
  afterAll(() => {
    redis?.process.kill();
    if (redis) rmSync(redis.dir, { recursive: true, force: true });
  });

  let prefix = 0;
  // Two SFUs, A and B, that know where each code is through one registry.
  const twoSfus = async () => {
    prefix += 1;
    const sfu = async (instanceId: string) => {
      const registry = createRoomRegistry({
        ...config,
        instanceId,
        instancePublicUrl: `http://${instanceId}.test`,
        socket: { ...config.socket, redisUrl: `redis://127.0.0.1:${redis!.port}` },
        roomRegistry: { ...config.roomRegistry, keyPrefix: `knock:${process.pid}:${prefix}` },
      });
      registries.push(registry);
      await registry.start();
      return makeState(makeDurable(), registry);
    };
    return { a: await sfu("sfu-a"), b: await sfu("sfu-b") };
  };
  const toldToReconnect = (member: Awaited<ReturnType<typeof join>>) =>
    member.peer.emit.mock.calls.some(
      ([event, sent]) =>
        event === "serverRestarting" && (sent as { reconnecting?: boolean }).reconnecting === true,
    ) && member.peer.disconnect.mock.calls.length > 0;

  it("sends them there through the usual route when A drains, and the host on B lets them in", async () => {
    const { a, b } = await twoSfus();
    const created = await join(a, host);
    const knocking = await join(a, knocker);
    expect(knocking.status).toBe("waiting");
    await hangUp(created.peer);
    expect(a.rooms.size).toBe(0);
    await vi.waitFor(async () => expect(await b.roomRegistry.getAssignment(CHANNEL)).toBeNull());

    // A drains. While no meeting is open at the code anywhere, the knocker
    // keeps waiting on A, also when the tab asks again.
    a.isDraining = true;
    await renewRoomOwnerships(a);
    expect(toldToReconnect(knocking)).toBe(false);
    expect((await askAgain(knocking)).status).toBe("waiting");

    // The host reopens the meeting, which the web places on B.
    const reopened = await join(b, host);
    expect(reopened.status).toBe("joined");
    await renewRoomOwnerships(a);
    expect(toldToReconnect(knocking)).toBe(true);
    expect(a.nextMeetingLobbies.size).toBe(0);

    // The tab reconnects through the usual route, which leads to B.
    const there = await join(b, knocker);
    expect(there.status).toBe("waiting");
    expect(reopened.peer.emit).toHaveBeenCalledWith(
      "userRequestedJoin",
      expect.objectContaining({ userId: knocker.userId }),
    );
    expect(await send(reopened.peer, "admitUser", { userId: knocker.userId })).toEqual({
      success: true,
    });
    expect((await join(b, knocker)).status).toBe("joined");
  }, 30_000);
});

describe("a join asked again on the same connection while its room is still opening", () => {
  // Opening a room waits here until the test lets it go on.
  const holdRoomOpening = (state: SfuState) => {
    const [worker] = state.workers;
    const createRouter = worker.createRouter.bind(worker);
    let goOn = () => {};
    const held = new Promise<void>((resolve) => (goOn = resolve));
    const opened = vi.fn();
    (worker as { createRouter: typeof createRouter }).createRouter = async (...args) => {
      opened();
      await held;
      return createRouter(...args);
    };
    return { opened, goOn };
  };
  // One tab's connection, which can ask to join more than once.
  const connect = (state: SfuState, user: SfuAuthPayload) => {
    const peer = makeSocket(`${user.userId}-socket`, user);
    const context = createConnectionContext(io, peer.socket, state);
    registerJoinRoomHandler(context);
    registerDisconnectHandlers(context);
    const ask = async () => {
      const ack = vi.fn();
      await peer.handlers.get("joinRoom")!(
        ...([{ roomId: "abc-mnop-xyz", sessionId: user.sessionId }, ack] as never[]),
      );
      return (ack.mock.calls[0]?.[0] ?? {}) as JoinAck;
    };
    return { peer, context, ask };
  };
  const opener = { ...guest, allowRoomCreation: true };

  it("makes the newer join the host of the room the older one opened, and opens it once", async () => {
    const state = makeState();
    const opening = holdRoomOpening(state);
    const tab = connect(state, opener);
    const firstTry = tab.ask();
    await vi.waitFor(() => expect(opening.opened).toHaveBeenCalled());
    const retry = tab.ask();
    opening.goOn();

    expect((await firstTry).error).toBe("A newer join from this connection took over.");
    expect((await retry).status).toBe("joined");
    expect(tab.context.currentClient).toBeInstanceOf(Admin);
    expect(roomOf(state).getHostUserId()).toBe("guest-visitor#v");
    expect(roomOf(state).isLocked).toBe(true);
    expect(opening.opened).toHaveBeenCalledTimes(1);
  });

  it("answers a join whose room is slow to open before the tab gives up, and the retry hosts it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = makeState();
    const opening = holdRoomOpening(state);
    const tab = connect(state, opener);
    const firstTry = tab.ask();
    await vi.waitFor(() => expect(opening.opened).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await firstTry).error).toBe("The meeting is still opening. Try again in a moment.");

    opening.goOn();
    const retry = tab.ask();
    expect((await retry).status).toBe("joined");
    expect(tab.context.currentClient).toBeInstanceOf(Admin);
    expect(opening.opened).toHaveBeenCalledTimes(1);
  });

  it("closes a room it opened for a tab that left before taking its seat, once nobody takes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = makeState();
    const opening = holdRoomOpening(state);
    const tab = connect(state, opener);
    const firstTry = tab.ask();
    await vi.waitFor(() => expect(opening.opened).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    await firstTry;
    await hangUp(tab.peer);

    opening.goOn();
    await vi.waitFor(() => expect(state.rooms.size).toBe(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.rooms.size).toBe(0);
    vi.useRealTimers();
    const next = await join(state, host);
    expect(next.status).toBe("joined");
    expect(next.context.currentClient).toBeInstanceOf(Admin);
  });

  it("does not seat a tab that left while its room was opening, nor keep its call as one to bring back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = makeState();
    const opening = holdRoomOpening(state);
    const tab = connect(state, opener);
    const firstTry = tab.ask();
    await vi.waitFor(() => expect(opening.opened).toHaveBeenCalled());
    await hangUp(tab.peer);
    opening.goOn();
    await firstTry;

    expect(tab.context.currentClient).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.rooms.size).toBe(0);
    vi.useRealTimers();
    const next = await join(state, host);
    expect(next.status).toBe("joined");
    expect(next.context.currentClient).toBeInstanceOf(Admin);
  });

  it("lets the next visitor who may open the code host the room a tab that left was opening", async () => {
    const state = makeState();
    const opening = holdRoomOpening(state);
    const tab = connect(state, opener);
    const firstTry = tab.ask();
    await vi.waitFor(() => expect(opening.opened).toHaveBeenCalled());
    await hangUp(tab.peer);
    const next = join(state, host);
    opening.goOn();
    await firstTry;

    const hostJoin = await next;
    expect(hostJoin.status).toBe("joined");
    expect(hostJoin.context.currentClient).toBeInstanceOf(Admin);
    expect(tab.context.currentClient).toBeNull();
    expect(roomOf(state).getAdminUserIds()).toEqual(["guest-host#h"]);
    expect(opening.opened).toHaveBeenCalledTimes(1);
  });
});

describe("an invited attendee a host removed from a call the server lost", () => {
  // A host removes the invitee, then the SFU loses the call. Someone who was
  // only knocking recreates the room, and nobody from the call comes back.
  const lostWithTheInviteeRemoved = async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const before = makeState();
    schedule(before);
    const created = await join(before, host);
    expect((await join(before, invitee)).status).toBe("joined");
    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });
    const after = await restart(before);
    const opener = await join(after, { ...knocker, allowRoomCreation: true });
    expect(opener.status).toBe("waiting");
    expect((await join(after, invitee)).status).toBe("waiting");
    return { after, opener };
  };

  it("joins the meeting opened once the lost call's time is up, without knocking", async () => {
    const { after, opener } = await lostWithTheInviteeRemoved();
    vi.advanceTimersByTime(8 * MINUTE_MS);
    expect((await askAgain(opener)).status).toBe("joined");
    expect(opener.context.currentClient).toBeInstanceOf(Admin);

    expect((await join(after, invitee)).status).toBe("joined");
  });

  it("joins it without knocking after the SFU restarts again too", async () => {
    const { after, opener } = await lostWithTheInviteeRemoved();
    vi.advanceTimersByTime(8 * MINUTE_MS);
    await askAgain(opener);
    await Promise.resolve();
    const again = await restart(after);

    await join(again, host);
    expect((await join(again, invitee)).status).toBe("joined");
  });
});

describe("an invited attendee a host lets back in after a failover", () => {
  it("stays let in, though the SFU's own copy of the meeting never saw the removal", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const sfuA = makeState();
    schedule(sfuA);
    const sfuB = await restart(sfuA);
    const created = await join(sfuA, host);
    expect((await join(sfuA, invitee)).status).toBe("joined");
    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });

    // SFU A loses the call. SFU B's fresh read of the schedule finds nothing,
    // while the recovery record brings the removal back with the call.
    sfuB.scheduledMeetingPersistence = {
      ...sfuB.scheduledMeetingPersistence!,
      loadOne: () => null,
    };
    const hostBack = await join(sfuB, host);
    expect(hostBack.context.currentClient).toBeInstanceOf(Admin);
    expect((await join(sfuB, invitee)).status).toBe("waiting");
    expect(await send(hostBack.peer, "admitUser", { userId: "invitee@example.com" })).toEqual({
      success: true,
    });

    const later = await restart(sfuB);
    await join(later, host);
    expect((await join(later, invitee)).status).toBe("joined");
  });
});

describe("an invited attendee removed on one SFU", () => {
  it("still has to be let in again on the SFU the meeting fails over to", async () => {
    // Both SFUs use one schedule store. B loaded the meeting when it started,
    // before the removal.
    const shared = makeDurable();
    const sfuA = makeState(shared);
    schedule(sfuA);
    const sfuB = makeState(shared);
    await initScheduledMeetings(sfuB, shared.schedule);
    const created = await join(sfuA, host);
    await join(sfuA, invitee);
    await send(created.peer, "kickUser", { userId: "invitee@example.com#i" });

    await join(sfuB, host);
    expect((await join(sfuB, invitee)).status).toBe("waiting");
  });
});

describe("a meeting a host ended for everyone", () => {
  const endedMeeting = async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);
    await send(created.peer, "admin:endRoom", {});
    vi.advanceTimersByTime(2_000);
    expect(state.rooms.size).toBe(0);
    return { state, passFromBeforeTheEnd: member.response.roomRecoveryPass };
  };

  it("takes nobody back on a pass from before the end when it is opened again", async () => {
    const { state, passFromBeforeTheEnd } = await endedMeeting();

    const reopened = await join(state, host);
    expect(reopened.status).toBe("joined");
    expect(reopened.context.currentClient).toBeInstanceOf(Admin);
    expect(
      (await join(state, guest, { roomRecoveryPass: passFromBeforeTheEnd })).status,
    ).toBe("waiting");
  });

  it("takes nobody back on such a pass after a restart either", async () => {
    const { state, passFromBeforeTheEnd } = await endedMeeting();
    const after = await restart(state);

    const reopened = await join(after, host);
    expect(reopened.context.currentClient).toBeInstanceOf(Admin);
    expect(
      (await join(after, guest, { roomRecoveryPass: passFromBeforeTheEnd })).status,
    ).toBe("waiting");
  });

  it("signs no more passes while it waits to close, so none outlives the end", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);
    const stopRefreshing = startRoomRecoveryPassRefresh(state, config.sfuSecret);

    vi.advanceTimersByTime(MINUTE_MS - 2_000);
    await send(created.peer, "admin:endRoom", { delayMs: 30_000 });
    const heldAtTheEnd = passesHeldBy(member).length;
    // The renewal falls inside the half minute the room stays open.
    vi.advanceTimersByTime(5_000);
    expect(state.rooms.size).toBe(1);
    expect(passesHeldBy(member)).toHaveLength(heldAtTheEnd);

    vi.advanceTimersByTime(30_000);
    stopRefreshing();
    expect(state.rooms.size).toBe(0);
    await join(state, host);
    for (const pass of passesHeldBy(member)) {
      expect((await join(state, guest, { roomRecoveryPass: pass })).status).toBe("waiting");
    }
  });

  it("opens afresh for whoever comes next, even someone who only has the link", async () => {
    const { state } = await endedMeeting();
    const after = await restart(state);

    const visitor = await join(after, { ...knocker, allowRoomCreation: true });
    expect(visitor.status).toBe("joined");
    expect(visitor.context.currentClient).toBeInstanceOf(Admin);
  });

  it("takes back someone let into the reopened meeting 650 ms after the end", async () => {
    const { state } = await endedMeeting();
    // endedMeeting leaves the clock 2 s past the end. Step back inside the
    // second the meeting ended in.
    vi.setSystemTime(new Date("2026-11-22T08:00:00.650Z"));
    await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);

    const after = await restart(state);
    const back = await join(
      after,
      { ...guest, allowRoomCreation: true },
      { roomRecoveryPass: member.response.roomRecoveryPass },
    );
    expect(back.status).toBe("joined");
  });

  it("still brings back the people in the reopened meeting if the server loses it", async () => {
    const { state } = await endedMeeting();
    vi.advanceTimersByTime(5_000);
    await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);

    const after = await restart(state);
    const back = await join(
      after,
      { ...guest, allowRoomCreation: true },
      { roomRecoveryPass: member.response.roomRecoveryPass },
    );
    expect(back.status).toBe("joined");
    expect(back.context.currentClient).toBeInstanceOf(Admin);
  });
});

describe("a meeting everyone left, opened again at the same code", () => {
  // A host, someone they removed and someone who stayed to the end.
  const emptiedMeeting = async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    roomOf(state).restoreAdmission(second.userId, undefined, { pastLock: true });
    const removed = await join(state, guest);
    const stayed = await join(state, second);
    await send(created.peer, "kickUser", { userId: `${guest.userId}#${guest.sessionId}` });
    await hangUp(stayed.peer);
    await hangUp(created.peer);
    vi.advanceTimersByTime(MINUTE_MS);
    expect(state.rooms.size).toBe(0);
    return {
      state,
      removedPass: removed.response.roomRecoveryPass,
      stayedPass: stayed.response.roomRecoveryPass,
    };
  };

  it("refuses the kept pass of someone a host had removed", async () => {
    const { state, removedPass } = await emptiedMeeting();
    const reopened = await join(state, host);
    expect(reopened.context.currentClient).toBeInstanceOf(Admin);

    expect((await join(state, guest, { roomRecoveryPass: removedPass })).status).toBe(
      "waiting",
    );
  });

  it("refuses that pass after a restart as well", async () => {
    const { state, removedPass } = await emptiedMeeting();
    const after = await restart(state);
    expect((await join(after, host)).context.currentClient).toBeInstanceOf(Admin);

    expect((await join(after, guest, { roomRecoveryPass: removedPass })).status).toBe(
      "waiting",
    );
  });

  it("is a new meeting to the people of the earlier one, who knock like anyone else", async () => {
    const { state, stayedPass } = await emptiedMeeting();
    await join(state, host);

    expect((await join(state, second, { roomRecoveryPass: stayedPass })).status).toBe(
      "waiting",
    );
  });

  it("still brings its own people back if the server then loses it", async () => {
    const { state } = await emptiedMeeting();
    await join(state, host);
    roomOf(state).restoreAdmission(second.userId, undefined, { pastLock: true });
    const member = await join(state, second);

    const after = await restart(state);
    const back = await join(
      after,
      { ...second, allowRoomCreation: true },
      { roomRecoveryPass: member.response.roomRecoveryPass },
    );
    expect(back.status).toBe("joined");
  });
});

describe("someone a host blocked without removing them", () => {
  it("gets no more passes until a host lets them in again", async () => {
    useTestClock();
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).restoreAdmission(guest.userId, undefined, { pastLock: true });
    const member = await join(state, guest);
    const stopRefreshing = startRoomRecoveryPassRefresh(state, config.sfuSecret);

    await send(created.peer, "admin:blockUsers", {
      userKeys: [guest.userId],
      kickPresent: false,
    });
    const heldWhenBlocked = passesHeldBy(member).length;
    vi.advanceTimersByTime(3 * MINUTE_MS);
    expect(passesHeldBy(member)).toHaveLength(heldWhenBlocked);
    expect(passesHeldBy(created).length).toBeGreaterThan(1);

    await send(created.peer, "admin:unblockUsers", { userKeys: [guest.userId] });
    vi.advanceTimersByTime(2 * MINUTE_MS);
    expect(passesHeldBy(member)).toHaveLength(heldWhenBlocked);

    await send(created.peer, "admin:allowUsers", { userKeys: [guest.userId] });
    vi.advanceTimersByTime(2 * MINUTE_MS);
    stopRefreshing();
    expect(passesHeldBy(member).length).toBeGreaterThan(heldWhenBlocked);
  });
});


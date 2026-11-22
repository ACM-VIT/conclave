import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { forceCloseRoom } from "../server/rooms.js";
import {
  createScheduledMeeting,
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

const makeState = (durable: Durable = makeDurable()): SfuState => {
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
  options: { roomId?: string; roomRecoveryPass?: string } = {},
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

    const admitted = await send(created.peer, "admin:allowUsers", {
      userKeys: [agent.userId],
    });
    expect(admitted?.success).toBe(true);

    expect((await join(state, agent)).status).toBe("joined");
    expect((await join(state, knocker)).status).toBe("waiting");
    expect(roomOf(state).isLocked).toBe(true);
  });

  it("cannot be admitted by someone who is not a host", async () => {
    const state = makeState();
    await join(state, host);
    roomOf(state).allowLockedUser(guest.userId);
    const participant = await join(state, guest);
    expect(participant.status).toBe("joined");

    await send(participant.peer, "admin:allowUsers", {
      userKeys: [agent.userId],
    });
    expect((await join(state, agent)).status).toBe("waiting");
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
    roomOf(state).allowLockedUser(guest.userId);
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
    roomOf(state).allowLockedUser(guest.userId);
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

  it("stops renewing a removed member's pass at once, and the one they kept runs out", async () => {
    useTestClock();
    const state = makeState();
    const created = await join(state, host);
    roomOf(state).allowLockedUser(guest.userId);
    const member = await join(state, guest);
    const stopRefreshing = startRoomRecoveryPassRefresh(state, config.sfuSecret);
    vi.advanceTimersByTime(2 * MINUTE_MS);

    await send(created.peer, "kickUser", { userId: "guest-visitor#v" });
    const kept = passesHeldBy(member);
    vi.advanceTimersByTime(MINUTE_MS);
    expect(passesHeldBy(member)).toEqual(kept);
    expect(passesHeldBy(created).length).toBeGreaterThan(3);
    stopRefreshing();

    // Still inside the kept pass's last minutes, a recreated room cannot
    // know about the removal and takes it.
    const soon = makeState();
    await join(soon, rejoining(host));
    expect(
      (await join(soon, guest, { roomRecoveryPass: kept.at(-1) })).status,
    ).toBe("joined");

    vi.setSystemTime(Date.now() + 4 * MINUTE_MS + 1000);
    const later = makeState();
    await join(later, rejoining(host));
    expect(
      (await join(later, guest, { roomRecoveryPass: kept.at(-1) })).status,
    ).toBe("waiting");
  });

  it("gives no pass to a removed member's other device", async () => {
    useTestClock();
    const state = makeState();
    const created = await join(state, host);
    const laptop = { userId: "user-9", email: "sam@example.com", clientId: "conclave", sessionId: "laptop" };
    const phone = { ...laptop, sessionId: "phone" };
    roomOf(state).allowLockedUser("sam@example.com");
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
    roomOf(before).allowLockedUser(guest.userId);
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

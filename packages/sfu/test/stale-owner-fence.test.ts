import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_COMMANDS,
  isValidHostCommand,
  ROOM_LEASE_UNCONFIRMED_ERROR,
  type HostCommand,
} from "@conclave/meeting-core/host-commands";
import { Admin } from "../config/classes/Admin.js";
import { config } from "../config/config.js";
import { initScheduledMeetings } from "../server/init.js";
import {
  createMemoryRoomRecoveryStore,
  createRoomRecoveryLedger,
  type RoomRecoveryStore,
} from "../server/roomRecoveryLedger.js";
import { startRoomRecoveryPassRefresh } from "../server/roomRecoveryPass.js";
import { RoomLeaseExpiredError } from "../server/roomRegistry.js";
import type {
  RoomAssignmentRecord,
  RoomOwnerRecord,
  RoomOwnershipClaim,
  RoomRegistry,
} from "../server/roomRegistry.js";
import { forceCloseRoom, renewRoomOwnerships, ROOM_WRITE_COMMIT_MS } from "../server/rooms.js";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  isScheduledMeetingInvitee,
  loadPersistedMeetings,
  persistScheduledMeetingChanges,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";
import { forceDrainRooms } from "../server/serverShutdown.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext, setSocketContext } from "../server/socket/context.js";
import { INVALID_HOST_COMMAND_ERROR } from "../server/socket/handlers/adminHandlers.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { Logger } from "../utilities/loggers.js";

const CODE = "abc-mnop-xyz";
const CHANNEL = `conclave:${CODE}`;
const LEASE_MS = 45_000;
const LEASE_MARGIN_MS = 5_000;
const INVITEE = "invitee@example.com";
const INVITEE_SEAT = `${INVITEE}#i`;
const host = (sessionId: string): SfuAuthPayload => ({
  userId: "host@example.com",
  email: "host@example.com",
  clientId: "conclave",
  sessionId,
});
const invitee: SfuAuthPayload = { userId: "user-2", email: INVITEE, clientId: "conclave", sessionId: "i" };

type Leases = {
  forInstance: (instanceId: string) => RoomRegistry;
  ownerOf: (channelId: string) => string | null;
  holdRenewals: () => void;
  releaseRenewals: () => void;
  forget: () => void;
};

const sharedLeases = (): Leases => {
  const owners = new Map<string, RoomOwnerRecord>();
  let lastGeneration = 0;
  const live = (channelId: string) => {
    const owner = owners.get(channelId);
    return owner && owner.expiresAt > Date.now() ? owner : null;
  };
  let holding = false;
  const held: Array<() => void> = [];
  const forInstance = (instanceId: string): RoomRegistry => {
    const servesUntil = new Map<string, number>();
    const servesUnder = new Map<string, number>();
    const claimNow = (input: { channelId: string; clientId: string; roomId: string }): RoomOwnershipClaim => {
      const current = live(input.channelId);
      if (current && current.instanceId !== instanceId) return { ok: false, owner: current };
      const now = Date.now();
      const continuous = current !== null && current.generation !== undefined;
      const generation = continuous ? current.generation! : (lastGeneration = Math.max(now, lastGeneration + 1));
      const owner: RoomOwnerRecord = {
        kind: "owner",
        ...input,
        instanceId,
        updatedAt: now,
        expiresAt: now + LEASE_MS,
        generation,
      };
      owners.set(input.channelId, owner);
      servesUntil.set(input.channelId, now + LEASE_MS - LEASE_MARGIN_MS);
      servesUnder.set(input.channelId, generation);
      return { ok: true, owner, continuous, generation };
    };
    const claim = (input: { channelId: string; clientId: string; roomId: string }) =>
      holding
        ? new Promise<RoomOwnershipClaim>((resolve) => held.push(() => resolve(claimNow(input))))
        : Promise.resolve(claimNow(input));
    return {
      mode: "redis",
      instanceId,
      start: async () => undefined,
      close: async () => undefined,
      getOwner: async (channelId) => live(channelId),
      getPlacement: async () => null,
      getAssignment: async (channelId) => live(channelId),
      reservePlacement: async (input) => ({
        ok: true,
        placement: { kind: "placement", ...input, instanceId, updatedAt: Date.now(), expiresAt: Date.now() + LEASE_MS },
      }),
      claimRoom: claim,
      renewRoom: claim,
      releaseRoom: async (channelId) => {
        servesUntil.delete(channelId);
        if (owners.get(channelId)?.instanceId === instanceId) owners.delete(channelId);
      },
      isLocalOwner: (owner: RoomAssignmentRecord | null | undefined) => owner?.instanceId === instanceId,
      holdsLease: (channelId, generation) =>
        (servesUntil.get(channelId) ?? 0) > Date.now() &&
        (generation === undefined || servesUnder.get(channelId) === generation),
    };
  };
  return {
    forInstance,
    ownerOf: (channelId) => live(channelId)?.instanceId ?? null,
    holdRenewals: () => {
      holding = true;
    },
    releaseRenewals: () => {
      holding = false;
      for (const resume of held.splice(0)) resume();
    },
    forget: () => owners.clear(),
  };
};

const io = {
  to: () => ({ emit: vi.fn() }),
  in: () => ({ disconnectSockets: vi.fn() }),
} as unknown as SocketIOServer;

const startSfu = async (
  registry: RoomRegistry,
  options: { recovery?: RoomRecoveryStore; persistence?: ScheduledMeetingPersistence } = {},
): Promise<SfuState> => {
  const makeRouter = async () =>
    ({
      closed: false,
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: vi.fn(),
    }) as unknown as Router;
  const state = createSfuState({
    roomRegistry: registry,
    roomRecoveryStore: options.recovery ?? createMemoryRoomRecoveryStore(),
  });
  state.workers = [{ pid: 1, closed: false, createRouter: vi.fn(makeRouter) } as unknown as Worker];
  await initScheduledMeetings(state, options.persistence ?? createScheduledMeetingPersistence());
  return state;
};

type Answer = { success?: boolean; error?: string; status?: string };

const connect = (state: SfuState, user: SfuAuthPayload) => {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const wire = { connected: true };
  const emit = vi.fn();
  const socket = {
    id: `${user.userId}-${user.sessionId}`,
    data: { user },
    get connected() {
      return wire.connected;
    },
    on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
    emit,
    disconnect: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  const context = createConnectionContext(io, socket, state);
  setSocketContext(socket, context);
  registerJoinRoomHandler(context);
  registerDisconnectHandlers(context);
  const raw = (event: string, ...args: unknown[]) => handlers.get(event)?.(...(args as never[]));
  const send = (event: string, payload: unknown): Promise<Answer> =>
    new Promise((resolve) => {
      void raw(event, payload, resolve);
    });
  const leave = async (reason = "client namespace disconnect") => {
    wire.connected = false;
    await handlers.get("disconnect")?.(...([reason] as never[]));
  };
  const passes = () => emit.mock.calls.filter(([event]) => event === "roomRecoveryPass").length;
  const told = (event: string): unknown[] =>
    (emit.mock.calls as unknown[][]).filter(([name]) => name === event).map(([, body]) => body);
  const ask = (payload: Record<string, unknown> = {}): Promise<Answer> =>
    send("joinRoom", { roomId: CODE, sessionId: user.sessionId, ...payload });
  return { context, send, raw, leave, passes, told, ask };
};

const join = async (state: SfuState, user: SfuAuthPayload, payload: Record<string, unknown> = {}) => {
  const tab = connect(state, user);
  const joined = await tab.ask(payload);
  return { ...tab, status: joined.status, answer: joined };
};

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const useSharedSchedule = () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "stale-owner-"));
  dirs.push(dir);
  vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "sqlite");
  vi.stubEnv("SCHEDULED_MEETINGS_SQLITE_PATH", joinPath(dir, "conclave.sqlite"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", joinPath(dir, "scheduled-meetings.json"));
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("SFU_REDIS_URL", "");
  vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", "");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-25T09:00:00Z"));
};

const book = async () => {
  const booking = createScheduledMeetingStore();
  const meeting = createScheduledMeeting(
    booking,
    {
      title: "Intro call",
      scheduledStartAt: Date.now(),
      roomCode: CODE,
      hostEmail: "host@example.com",
      attendeeEmail: INVITEE,
    },
    {
      clientId: "conclave",
      createdBy: "host@example.com",
      defaultHostEmail: "host@example.com",
      defaultHostUserId: null,
    },
  );
  await persistScheduledMeetingChanges(booking, createScheduledMeetingPersistence(), [meeting]);
};

const inviteeIsInvited = async () => {
  const later = createScheduledMeetingStore();
  await loadPersistedMeetings(later, createScheduledMeetingPersistence());
  return isScheduledMeetingInvitee(later, "conclave", CODE, INVITEE);
};

const settle = () => vi.advanceTimersByTimeAsync(10);

const withGrace = async <T>(graceMs: number, run: () => Promise<T>): Promise<T> => {
  const before = config.socket.disconnectGraceMs;
  config.socket.disconnectGraceMs = graceMs;
  try {
    return await run();
  } finally {
    config.socket.disconnectGraceMs = before;
  }
};

type LeaseState =
  | "held"
  | "renewing"
  | "lapsed but still the owner"
  | "lost"
  | "forgotten, then claimed again"
  | "renewing, then drained"
  | "renewing, then closed";
type Action =
  | "kick the invitee"
  | "admit the invitee"
  | "end the meeting"
  | "the last person leaves"
  | "a participant takes over from a dropped host";

const LEASE_STATES: LeaseState[] = [
  "held",
  "renewing",
  "lapsed but still the owner",
  "lost",
  "forgotten, then claimed again",
  "renewing, then drained",
  "renewing, then closed",
];
const ACTIONS: Array<{ action: Action; command: boolean; inviteeRemovedFirst: boolean; invitedAfter: boolean }> = [
  { action: "kick the invitee", command: true, inviteeRemovedFirst: false, invitedAfter: false },
  { action: "admit the invitee", command: true, inviteeRemovedFirst: true, invitedAfter: true },
  { action: "end the meeting", command: true, inviteeRemovedFirst: true, invitedAfter: true },
  { action: "the last person leaves", command: false, inviteeRemovedFirst: true, invitedAfter: true },
  { action: "a participant takes over from a dropped host", command: false, inviteeRemovedFirst: false, invitedAfter: true },
];

const runCase = async (action: (typeof ACTIONS)[number], lease: LeaseState) => {
  useSharedSchedule();
  await book();
  const leases = sharedLeases();
  const recovery = createMemoryRoomRecoveryStore();
  const sfuA = await startSfu(leases.forInstance("sfu-a"), { recovery });
  const hostOnA = await join(sfuA, host("a"));
  expect(hostOnA.status).toBe("joined");
  if (action.inviteeRemovedFirst || action.action !== "admit the invitee") {
    expect((await join(sfuA, invitee)).status).toBe("joined");
  }
  if (action.inviteeRemovedFirst) {
    expect(await hostOnA.send("kickUser", { userId: INVITEE_SEAT })).toEqual({ success: true });
    await settle();
    expect(await inviteeIsInvited()).toBe(false);
  }
  if (action.action === "admit the invitee") {
    expect((await join(sfuA, invitee)).status).toBe("waiting");
  }

  const renewing = lease.startsWith("renewing");
  if (lease !== "held") await vi.advanceTimersByTimeAsync(LEASE_MS - LEASE_MARGIN_MS + 2_000);
  if (renewing) leases.holdRenewals();
  if (lease === "forgotten, then claimed again") leases.forget();
  if (lease === "lost") {
    await vi.advanceTimersByTimeAsync(LEASE_MARGIN_MS);
    expect((await leases.forInstance("sfu-b").claimRoom({ channelId: CHANNEL, clientId: "conclave", roomId: CODE })).ok).toBe(true);
  }
  const invitedBefore = await inviteeIsInvited();
  const room = sfuA.rooms.get(CHANNEL)!;

  let answer: Promise<Answer> | null = null;
  switch (action.action) {
    case "kick the invitee":
      answer = hostOnA.send("kickUser", { userId: INVITEE_SEAT });
      break;
    case "admit the invitee":
      answer = hostOnA.send("admitUser", { userId: INVITEE });
      break;
    case "end the meeting":
      answer = hostOnA.send("admin:endRoom", {});
      break;
    case "the last person leaves":
      await hostOnA.leave();
      break;
    case "a participant takes over from a dropped host":
      await withGrace(0, () => hostOnA.leave("transport close"));
      break;
  }
  await settle();
  if (lease === "renewing, then drained") await forceDrainRooms(sfuA, io, { message: "Restarting", noticeMs: 0 });
  if (lease === "renewing, then closed") forceCloseRoom(sfuA, room);
  if (renewing) {
    expect(await inviteeIsInvited()).toBe(invitedBefore);
    if (!action.command || lease === "renewing") expect(leases.ownerOf(CHANNEL)).toBe("sfu-a");
    leases.releaseRenewals();
    await settle();
  }
  if (lease === "lost") expect(leases.ownerOf(CHANNEL)).toBe("sfu-b");
  await vi.advanceTimersByTimeAsync(30_000);

  const commandRan =
    lease === "held" ||
    lease === "renewing" ||
    lease === "lapsed but still the owner" ||
    lease === "forgotten, then claimed again";
  const written = action.command ? commandRan : lease !== "lost";
  if (action.command) {
    expect(await answer).toEqual(
      written ? expect.objectContaining({ success: true }) : { error: ROOM_LEASE_UNCONFIRMED_ERROR },
    );
  }
  if (action.action === "a participant takes over from a dropped host") {
    const saved = (await recovery.read(CHANNEL)) as { adminUserKeys?: string[] } | null;
    if (written) expect(saved?.adminUserKeys).toContain(INVITEE);
    else expect(saved?.adminUserKeys ?? []).not.toContain(INVITEE);
  } else {
    expect(await inviteeIsInvited()).toBe(written ? action.invitedAfter : invitedBefore);
  }
  if (written && (action.action === "the last person leaves" || action.action === "end the meeting")) {
    expect(leases.ownerOf(CHANNEL)).toBeNull();
  }
};

describe("what an SFU writes for a room, by the state of the room's lease", () => {
  for (const action of ACTIONS) {
    for (const lease of LEASE_STATES) {
      it(`${action.action}, lease ${lease}`, async () => {
        await runCase(action, lease);
      });
    }
  }
});

describe("an SFU that lost a room's lease while it was paused", () => {
  it.each(["same owner", "reclaimed lease", "replacement owner"])("settles an empty room after a registry outage with %s", async (outcome) => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const registry = leases.forInstance("sfu-a");
    const recovery = createMemoryRoomRecoveryStore();
    const sfuA = await startSfu(registry, { recovery });
    const hostOnA = await join(sfuA, host("a"));
    expect(hostOnA.status).toBe("joined");
    expect((await join(sfuA, invitee)).status).toBe("joined");
    expect(await hostOnA.send("kickUser", { userId: INVITEE_SEAT })).toEqual({ success: true });
    expect(await inviteeIsInvited()).toBe(false);

    await vi.advanceTimersByTimeAsync(LEASE_MS - LEASE_MARGIN_MS + 1);
    const unavailable = vi.spyOn(registry, "renewRoom").mockRejectedValue(new RoomLeaseExpiredError(CHANNEL));
    const leftAt = Date.now();
    await hostOnA.leave();
    await settle();
    expect(sfuA.rooms.has(CHANNEL)).toBe(false);
    expect(await recovery.read(CHANNEL)).toMatchObject({ overAt: null });
    expect(await inviteeIsInvited()).toBe(false);

    if (outcome === "replacement owner") {
      await vi.advanceTimersByTimeAsync(LEASE_MARGIN_MS);
      const sfuB = await startSfu(leases.forInstance("sfu-b"), { recovery });
      const hostOnB = await join(sfuB, host("b"));
      expect(hostOnB.status).toBe("joined");
      const replacement = sfuB.rooms.get(CHANNEL);
      expect(replacement?.getHostUserId()).toBe("host@example.com#b");

      unavailable.mockRestore();
      await renewRoomOwnerships(sfuA);
      await settle();
      expect(leases.ownerOf(CHANNEL)).toBe("sfu-b");
      expect(await recovery.read(CHANNEL)).toMatchObject({ overAt: null, writer: replacement?.incarnationId });
      expect(await inviteeIsInvited()).toBe(false);
    } else {
      if (outcome === "reclaimed lease") await vi.advanceTimersByTimeAsync(LEASE_MARGIN_MS);
      unavailable.mockRestore();
      await renewRoomOwnerships(sfuA);
      await settle();
      expect(await recovery.read(CHANNEL)).toMatchObject({ liveAt: null, overAt: leftAt });
      expect(await inviteeIsInvited()).toBe(true);
      expect(leases.ownerOf(CHANNEL)).toBeNull();
    }
  });

  it("keeps a replacement's invitee removal when an older room's end waited behind a backup", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const recovery = createMemoryRoomRecoveryStore();
    const sfuA = await startSfu(leases.forInstance("sfu-a"), { recovery });
    const hostOnA = await join(sfuA, host("a"));
    expect(hostOnA.status).toBe("joined");
    expect((await join(sfuA, invitee)).status).toBe("joined");
    expect(await hostOnA.send("kickUser", { userId: INVITEE_SEAT })).toEqual({ success: true });
    expect(await inviteeIsInvited()).toBe(false);

    expect(await sfuA.persistenceFence.hold("backup-a", 25_000)).not.toBeNull();
    let replacementRecord: unknown;
    try {
      await hostOnA.leave();
      await settle();
      expect(await inviteeIsInvited()).toBe(false);
      await vi.advanceTimersByTimeAsync(ROOM_WRITE_COMMIT_MS);
      expect(leases.ownerOf(CHANNEL)).toBeNull();

      const sfuB = await startSfu(leases.forInstance("sfu-b"), { recovery });
      const hostOnB = await join(sfuB, host("b"));
      expect(hostOnB.status).toBe("joined");
      const returningInvitee = await join(sfuB, invitee);
      expect(returningInvitee.status).toBe("waiting");
      expect(await hostOnB.send("admitUser", { userId: INVITEE })).toEqual({ success: true });
      expect((await returningInvitee.ask()).status).toBe("joined");
      expect(await hostOnB.send("kickUser", { userId: INVITEE_SEAT })).toEqual({ success: true });
      expect(await inviteeIsInvited()).toBe(false);
      replacementRecord = await recovery.read(CHANNEL);
      expect(replacementRecord).toMatchObject({ writer: sfuB.rooms.get(CHANNEL)?.incarnationId });
      expect(replacementRecord).toHaveProperty("liveAt", expect.any(Number));
    } finally {
      sfuA.persistenceFence.release("backup-a");
    }

    await settle();
    expect(leases.ownerOf(CHANNEL)).toBe("sfu-b");
    expect(await inviteeIsInvited()).toBe(false);
    expect(await recovery.read(CHANNEL)).toEqual(replacementRecord);
  });

  it("signs no recovery pass until the lease is confirmed again", async () => {
    useSharedSchedule();
    await book();
    const sfuA = await startSfu(sharedLeases().forInstance("sfu-a"));
    const hostOnA = await join(sfuA, host("a"));
    const stopRefresh = startRoomRecoveryPassRefresh(sfuA, config.sfuSecret);
    try {
      await vi.advanceTimersByTimeAsync(65_000);
      expect(hostOnA.passes()).toBe(0);
      await vi.advanceTimersByTimeAsync(45_000);
      await renewRoomOwnerships(sfuA);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(hostOnA.passes()).toBe(1);
    } finally {
      stopRefresh();
    }
  });

  it("does not end an invitee's removal that the SFU now running the call made", async () => {
    useSharedSchedule();
    await withGrace(120_000, async () => {
      await book();
      const leases = sharedLeases();
      const sfuA = await startSfu(leases.forInstance("sfu-a"));
      const sfuB = await startSfu(leases.forInstance("sfu-b"));

      const hostOnA = await join(sfuA, host("a"));
      expect(hostOnA.status).toBe("joined");
      await hostOnA.leave("transport close");
      expect(sfuA.rooms.get(CHANNEL)?.clients.size).toBe(1);

      await vi.advanceTimersByTimeAsync(LEASE_MS + 5_000);
      const hostOnB = await join(sfuB, host("b"));
      expect(hostOnB.status).toBe("joined");
      expect((await join(sfuB, invitee)).status).toBe("joined");
      expect(await hostOnB.send("kickUser", { userId: INVITEE_SEAT })).toEqual({ success: true });
      await settle();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(sfuA.rooms.get(CHANNEL)).toBeUndefined();
      expect(await inviteeIsInvited()).toBe(false);
    });
  });

  it("is refused at commit when it pauses between its lease check and its write", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const persistenceA = createScheduledMeetingPersistence();
    const decide = persistenceA.setInviteeReadmission!.bind(persistenceA);
    let resume: () => void = () => {};
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let reachedCommit = false;
    persistenceA.setInviteeReadmission = async (...args) => {
      reachedCommit = true;
      await paused;
      return decide(...args);
    };
    const sfuA = await startSfu(leases.forInstance("sfu-a"), { persistence: persistenceA });
    const sfuB = await startSfu(leases.forInstance("sfu-b"));
    const hostOnA = await join(sfuA, host("a"));
    expect((await join(sfuA, invitee)).status).toBe("joined");

    const kickOnA = hostOnA.send("kickUser", { userId: INVITEE_SEAT });
    await settle();
    expect(reachedCommit).toBe(true);

    await vi.advanceTimersByTimeAsync(LEASE_MS + 5_000);
    const hostOnB = await join(sfuB, host("b"));
    expect(hostOnB.status).toBe("joined");

    resume();
    await settle();
    expect(await kickOnA).toEqual({ error: ROOM_LEASE_UNCONFIRMED_ERROR });
    expect(await inviteeIsInvited()).toBe(true);
    expect((await join(sfuB, invitee)).status).toBe("joined");
  });
});

describe("a room whose fence did not land", () => {
  it("does not open when its booking could not be fenced, and opens once it can", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const persistence = createScheduledMeetingPersistence();
    const fence = persistence.fenceMeeting!.bind(persistence);
    let fails = true;
    persistence.fenceMeeting = (meetingId, generation) =>
      fails ? false : fence(meetingId, generation);
    const sfuA = await startSfu(leases.forInstance("sfu-a"), { persistence });

    const refused = await join(sfuA, host("a"));
    expect(refused.answer).toEqual({ error: ROOM_LEASE_UNCONFIRMED_ERROR });
    expect(sfuA.rooms.has(CHANNEL)).toBe(false);
    expect(leases.ownerOf(CHANNEL)).toBeNull();

    fails = false;
    expect((await join(sfuA, host("b"))).status).toBe("joined");
  });

  it("does not open while another connection holds the booking store's write lock", async () => {
    useSharedSchedule();
    await book();
    const sqlite = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void };
    };
    const locker = new sqlite.DatabaseSync(process.env.SCHEDULED_MEETINGS_SQLITE_PATH!);
    const leases = sharedLeases();
    const sfuA = await startSfu(leases.forInstance("sfu-a"));
    locker.exec("BEGIN IMMEDIATE");
    try {
      expect((await join(sfuA, host("a"))).answer).toEqual({ error: ROOM_LEASE_UNCONFIRMED_ERROR });
      expect(sfuA.rooms.has(CHANNEL)).toBe(false);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    expect((await join(sfuA, host("b"))).status).toBe("joined");
  }, 20_000);

  it("does not open when a newer generation fenced the code's recovery record", async () => {
    useSharedSchedule();
    await book();
    const recovery = createMemoryRoomRecoveryStore();
    const ahead = createRoomRecoveryLedger(recovery);
    expect(
      await ahead.fence({ channelId: CHANNEL, incarnationId: "elsewhere", takesOverRecordOf: null }, Date.now() * 10, null),
    ).toBe(true);
    const leases = sharedLeases();
    const sfuA = await startSfu(leases.forInstance("sfu-a"), { recovery });

    expect((await join(sfuA, host("a"))).answer).toEqual({ error: ROOM_LEASE_UNCONFIRMED_ERROR });
    expect(sfuA.rooms.has(CHANNEL)).toBe(false);
    expect(leases.ownerOf(CHANNEL)).toBeNull();
  });
});

describe("a room still being made", () => {
  type Wait = "the booking's fence to be flushed" | "its recovery record to be read" | "the booking to be read again" | "its router";
  const WAITS: Wait[] = [
    "the booking's fence to be flushed",
    "its recovery record to be read",
    "the booking to be read again",
    "its router",
  ];

  const slowSfu = async (leases: Leases, recovery: RoomRecoveryStore, wait: Wait) => {
    let arrive: () => void = () => {};
    const onItsWay = new Promise<void>((resolve) => (arrive = resolve));
    let fenced = false;
    const held = (what: Wait): Promise<void> | null => (fenced && what === wait ? onItsWay : null);
    const persistence = createScheduledMeetingPersistence();
    const fence = persistence.fenceMeeting!.bind(persistence);
    const readOne = persistence.loadOne!.bind(persistence);
    persistence.fenceMeeting = (...args) => {
      fenced = true;
      return fence(...args);
    };
    persistence.flush = async () => {
      await held("the booking's fence to be flushed");
    };
    persistence.loadOne = async (id) => {
      await held("the booking to be read again");
      return readOne(id);
    };
    const slowRecovery: RoomRecoveryStore = {
      ...recovery,
      read: async (channelId) => {
        await held("its recovery record to be read");
        return recovery.read(channelId);
      },
    };
    const state = await startSfu(leases.forInstance("sfu-a"), { recovery: slowRecovery, persistence });
    const worker = state.workers[0];
    const makeRouter = worker.createRouter.bind(worker);
    const closes: number[] = [];
    worker.createRouter = (async (...args: Parameters<Worker["createRouter"]>) => {
      await held("its router");
      const router = await makeRouter(...args);
      const made = closes.push(0) - 1;
      router.close = () => {
        closes[made] += 1;
      };
      return router;
    }) as Worker["createRouter"];
    return { state, arrive, closes };
  };

  it.each(WAITS)(
    "is not opened here, and sends its joiners on, when another SFU took the code while it waited for %s",
    async (wait) => {
      useSharedSchedule();
      await book();
      const leases = sharedLeases();
      const recovery = createMemoryRoomRecoveryStore();
      const sfuA = await slowSfu(leases, recovery, wait);
      const sfuB = await startSfu(leases.forInstance("sfu-b"), { recovery });

      const opener = connect(sfuA.state, host("a")).ask();
      await settle();
      const retry = connect(sfuA.state, host("a2")).ask();
      await settle();
      expect(sfuA.state.rooms.has(CHANNEL)).toBe(false);

      leases.forget();
      expect((await join(sfuB, host("b"))).status).toBe("joined");
      const roomOnB = sfuB.rooms.get(CHANNEL)!;
      sfuA.arrive();
      await vi.advanceTimersByTimeAsync(1_500);

      expect([await opener, await retry]).toEqual([
        expect.objectContaining({ redirectInstanceId: "sfu-b" }),
        expect.objectContaining({ redirectInstanceId: "sfu-b" }),
      ]);
      expect(sfuA.state.rooms.has(CHANNEL)).toBe(false);
      expect(sfuA.state.roomCreations.has(CHANNEL)).toBe(false);
      expect(sfuA.state.roomRegistry.holdsLease(CHANNEL)).toBe(false);
      expect(leases.ownerOf(CHANNEL)).toBe("sfu-b");
      expect(sfuB.rooms.get(CHANNEL)).toBe(roomOnB);
      expect((await createRoomRecoveryLedger(recovery).recall(CHANNEL)).lastWriter).toBe(
        roomOnB.incarnationId,
      );
      expect(sfuA.closes).toEqual([1]);
    },
  );

  it.each(WAITS.filter((wait) => wait !== "the booking to be read again"))(
    "is given up, and its code opens on the next try, when %s takes too long",
    async (wait) => {
      useSharedSchedule();
      await book();
      const leases = sharedLeases();
      const sfuA = await slowSfu(leases, createMemoryRoomRecoveryStore(), wait);

      let answer: Answer | undefined;
      void connect(sfuA.state, host("a"))
        .ask()
        .then((given) => (answer = given));
      await vi.advanceTimersByTimeAsync(ROOM_WRITE_COMMIT_MS + 1_500);

      expect(answer).toEqual({ error: ROOM_LEASE_UNCONFIRMED_ERROR });
      expect(sfuA.state.rooms.has(CHANNEL)).toBe(false);
      expect(sfuA.state.roomCreations.has(CHANNEL)).toBe(false);
      expect(leases.ownerOf(CHANNEL)).toBeNull();

      sfuA.arrive();
      await settle();
      expect(sfuA.closes).toEqual(wait === "its router" ? [1] : []);
      expect((await join(sfuA.state, host("b"))).status).toBe("joined");
      expect(sfuA.closes).toEqual(wait === "its router" ? [1, 0] : [0]);
    },
  );

  it("is not opened under a generation its lease no longer has, and opens on the next try", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const sfuA = await slowSfu(leases, createMemoryRoomRecoveryStore(), "its router");

    const opener = connect(sfuA.state, host("a")).ask();
    await settle();
    leases.forget();
    await vi.advanceTimersByTimeAsync(1_000);
    sfuA.arrive();
    await settle();

    expect(await opener).toEqual({ error: ROOM_LEASE_UNCONFIRMED_ERROR });
    expect(sfuA.state.rooms.has(CHANNEL)).toBe(false);
    expect(leases.ownerOf(CHANNEL)).toBeNull();
    const again = await join(sfuA.state, host("b"));
    expect(again.status).toBe("joined");
    expect(sfuA.state.roomRegistry.holdsLease(CHANNEL, sfuA.state.rooms.get(CHANNEL)!.ownershipGeneration!)).toBe(true);
  });
});

describe("a host command with arguments it does not take", () => {
  const MALFORMED: unknown[][] = [
    [null],
    [undefined],
    [42],
    ["kick"],
    [[]],
    [{ userId: {} }],
    [{ userId: 7, locked: "yes", enabled: 1, userKeys: [3], message: {} }],
  ];

  for (const lease of ["held", "renewing"] as const) {
    it(`answers each with a failure and keeps serving, lease ${lease}`, async () => {
      useSharedSchedule();
      await book();
      const leases = sharedLeases();
      const sfuA = await startSfu(leases.forInstance("sfu-a"));
      const hostOnA = await join(sfuA, host("a"));
      expect((await join(sfuA, invitee)).status).toBe("joined");
      if (lease === "renewing") {
        await vi.advanceTimersByTimeAsync(LEASE_MS - LEASE_MARGIN_MS + 2_000);
        leases.holdRenewals();
      }
      let tried = 0;
      for (const command of HOST_COMMANDS) {
        for (const payload of MALFORMED) {
          const ack = vi.fn();
          if (isValidHostCommand(command, [...payload, ack])) continue;
          expect(() => hostOnA.raw(command, ...payload, ack)).not.toThrow();
          await settle();
          expect(ack, `${command} ${JSON.stringify(payload)}`).toHaveBeenCalledWith({
            error: INVALID_HOST_COMMAND_ERROR,
          });
          tried += 1;
        }
      }
      expect(tried).toBeGreaterThan(HOST_COMMANDS.length * 3);
      leases.releaseRenewals();
      await settle();
      expect(await hostOnA.send("kickUser", { userId: INVITEE_SEAT })).toEqual({ success: true });
    });
  }
});

const STAGING_WEB = "staging web";
const IOS_63 = "iOS build 63";
const ANDROID_63 = "Android build 63";

const SHIPPED: Array<{ client: string; command: HostCommand; args: unknown[] }> = [
  { client: STAGING_WEB, command: "closeRemoteProducer", args: [{ producerId: "producer-1" }] },
  { client: STAGING_WEB, command: "muteAll", args: [] },
  { client: STAGING_WEB, command: "closeAllVideo", args: [] },
  { client: STAGING_WEB, command: "admin:admitAllPending", args: [] },
  { client: STAGING_WEB, command: "promoteHost", args: [{ userId: INVITEE_SEAT }] },
  { client: STAGING_WEB, command: "kickUser", args: [{ userId: INVITEE_SEAT }] },
  { client: STAGING_WEB, command: "admitUser", args: [{ userId: INVITEE }] },
  { client: STAGING_WEB, command: "rejectUser", args: [{ userId: INVITEE }] },
  { client: STAGING_WEB, command: "lockRoom", args: [{ locked: false }] },
  { client: STAGING_WEB, command: "setNoGuests", args: [{ noGuests: true }] },
  { client: STAGING_WEB, command: "lockChat", args: [{ locked: true }] },
  { client: STAGING_WEB, command: "setTtsDisabled", args: [{ disabled: true }] },
  { client: STAGING_WEB, command: "setDmEnabled", args: [{ enabled: false }] },
  { client: STAGING_WEB, command: "setImageAttachmentsEnabled", args: [{ enabled: false }] },
  { client: STAGING_WEB, command: "setReactionsDisabled", args: [{ disabled: true }] },
  { client: STAGING_WEB, command: "setParticipantMediaPermissions", args: [{ unmuteAllowed: false }] },
  { client: STAGING_WEB, command: "admin:endRoom", args: [{ message: "This meeting has been ended by the host.", delayMs: 0 }] },
  { client: IOS_63, command: "admin:muteUserAudio", args: [{ userId: INVITEE_SEAT }] },
  { client: IOS_63, command: "admin:closeUserMedia", args: [{ userId: INVITEE_SEAT, kinds: ["audio"] }] },
  { client: IOS_63, command: "admin:stopAllScreenShare", args: [] },
  { client: IOS_63, command: "admin:clearRaisedHands", args: [] },
  { client: IOS_63, command: "admin:getRoomState", args: [] },
  { client: IOS_63, command: "admin:allowUsers", args: [{ userKeys: [INVITEE], allowWhenLocked: true }] },
  { client: IOS_63, command: "admin:blockUsers", args: [{ userKeys: [INVITEE], kickPresent: true }] },
  { client: IOS_63, command: "admin:unblockUsers", args: [{ userKeys: [INVITEE] }] },
  { client: IOS_63, command: "admin:revokeAllowedUsers", args: [{ userKeys: [INVITEE], revokeLocked: true }] },
  { client: IOS_63, command: "admin:broadcastNotice", args: [{ message: "Back in five", level: "info" }] },
  { client: IOS_63, command: "admin:setPolicies", args: [{ locked: true }] },
  { client: IOS_63, command: "admin:transferHost", args: [{ userId: INVITEE_SEAT }] },
  { client: IOS_63, command: "redirectUser", args: [{ userId: INVITEE_SEAT, newRoomId: "def-ghij-klm" }] },
  { client: IOS_63, command: "admin:endRoom", args: [{ delayMs: 0 }] },
  { client: ANDROID_63, command: "admin:blockUsers", args: [{ userKeys: [INVITEE], kickPresent: false, reason: null }] },
  { client: ANDROID_63, command: "admin:closeUserMedia", args: [{ userId: INVITEE_SEAT, kinds: null, types: null, reason: null }] },
  { client: ANDROID_63, command: "admin:setPolicies", args: [{ locked: null, noGuests: true, chatLocked: null }] },
  { client: ANDROID_63, command: "admin:endRoom", args: [{ message: null, delayMs: 0 }] },
  { client: ANDROID_63, command: "admin:closeRoom", args: [{ message: null, delayMs: null }] },
];

describe("a host command as the apps in the field send it", () => {
  it.each(SHIPPED)("$client: $command", async ({ command, args }) => {
    useSharedSchedule();
    await book();
    const sfuA = await startSfu(sharedLeases().forInstance("sfu-a"));
    const hostOnA = await join(sfuA, host("a"));
    expect((await join(sfuA, invitee)).status).toBe("joined");
    const ack = vi.fn();
    expect(isValidHostCommand(command, [...args, ack])).toBe(true);
    await hostOnA.raw(command, ...args, ack);
    await settle();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0]?.[0]).not.toEqual({ error: INVALID_HOST_COMMAND_ERROR });
  });
});

describe("a tab of the web on staging, on this SFU before the web deploys", () => {
  const stagingJoin = (displayName: string) => ({
    displayName,
    mediaCapabilities: { webcamCodecs: ["vp8"] },
  });
  const fromCodePage = (userId: string, sessionId: string): SfuAuthPayload => ({
    userId,
    clientId: "conclave",
    sessionId,
    allowRoomCreation: true,
  });

  it("opens an empty code as its host and makes it nobody's", async () => {
    useSharedSchedule();
    const recovery = createMemoryRoomRecoveryStore();
    const sfuA = await startSfu(sharedLeases().forInstance("sfu-a"), { recovery });
    const opener = await join(
      sfuA,
      { ...fromCodePage("ana@example.com", "a"), email: "ana@example.com" },
      stagingJoin("Ana"),
    );

    expect(opener.status).toBe("joined");
    expect(opener.context.currentClient).toBeInstanceOf(Admin);
    expect(sfuA.rooms.get(CHANNEL)?.ownerEmail).toBeNull();
    expect((await createRoomRecoveryLedger(recovery).recall(CHANNEL)).owner).toEqual({ email: null });
  });

  it("knocks in a room that starts locked, shows its host the knock, and is let in", async () => {
    useSharedSchedule();
    const sfuA = await startSfu(sharedLeases().forInstance("sfu-a"));
    const opener = await join(
      sfuA,
      { ...fromCodePage("ana@example.com", "a"), email: "ana@example.com" },
      stagingJoin("Ana"),
    );
    expect(opener.status).toBe("joined");
    expect(sfuA.rooms.get(CHANNEL)?.isLocked).toBe(true);

    const knocker = await join(sfuA, fromCodePage("guest-ben", "b"), stagingJoin("Ben"));
    expect(knocker.status).toBe("waiting");
    expect(knocker.told("waitingRoomStatus")).not.toHaveLength(0);

    const pendingUsers = new Map<string, string>();
    for (const { userId, displayName } of opener.told("userRequestedJoin") as Array<{
      userId: string;
      displayName: string;
    }>) {
      pendingUsers.set(userId, displayName);
    }
    expect([...pendingUsers.values()]).toEqual(["Ben"]);

    const [userId] = [...pendingUsers.keys()];
    expect(await opener.send("admitUser", { userId })).toEqual(expect.objectContaining({ success: true }));
    expect(knocker.told("joinApproved")).toHaveLength(1);
    expect(
      await knocker.send("joinRoom", { roomId: CODE, sessionId: "b", ...stagingJoin("Ben") }),
    ).toEqual(expect.objectContaining({ status: "joined" }));
  });
});

describe("who a code belongs to", () => {
  const ana = (sessionId: string, claims: Partial<SfuAuthPayload> = {}): SfuAuthPayload => ({
    userId: "ana@example.com",
    email: "ana@example.com",
    clientId: "conclave",
    sessionId,
    allowRoomCreation: true,
    ...claims,
  });
  const ownerOnRecord = async (recovery: RoomRecoveryStore) =>
    (await createRoomRecoveryLedger(recovery).recall(CHANNEL)).owner;

  it("is the account whose join the web marked as creating the code", async () => {
    useSharedSchedule();
    const recovery = createMemoryRoomRecoveryStore();
    const sfuA = await startSfu(sharedLeases().forInstance("sfu-a"), { recovery });
    expect((await join(sfuA, ana("a", { createsCode: true }))).status).toBe("joined");

    expect(sfuA.rooms.get(CHANNEL)?.ownerEmail).toBe("ana@example.com");
    expect(await ownerOnRecord(recovery)).toEqual({ email: "ana@example.com" });
  });

  it("is nobody when a join says only in its own message that it creates the code", async () => {
    useSharedSchedule();
    const recovery = createMemoryRoomRecoveryStore();
    const sfuA = await startSfu(sharedLeases().forInstance("sfu-a"), { recovery });
    expect((await join(sfuA, ana("a"), { createsCode: true, createsMeeting: true })).status).toBe("joined");

    expect(sfuA.rooms.get(CHANNEL)?.ownerEmail).toBeNull();
    expect(await ownerOnRecord(recovery)).toEqual({ email: null });
  });

  it("stays nobody when a join marked as creating comes to a code that already had a room", async () => {
    useSharedSchedule();
    const recovery = createMemoryRoomRecoveryStore();
    const sfuA = await startSfu(sharedLeases().forInstance("sfu-a"), { recovery });
    const first = await join(sfuA, { userId: "guest-ben", clientId: "conclave", sessionId: "b", allowRoomCreation: true });
    expect(first.status).toBe("joined");
    await first.leave();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sfuA.rooms.has(CHANNEL)).toBe(false);

    expect((await join(sfuA, ana("a", { createsCode: true }))).status).toBe("joined");
    expect(sfuA.rooms.get(CHANNEL)?.ownerEmail).toBeNull();
    expect(await ownerOnRecord(recovery)).toEqual({ email: null });
  });
});

describe("a room whose lease the shared registry forgot", () => {
  const ben: SfuAuthPayload = { userId: "guest-ben", clientId: "conclave", sessionId: "b" };
  const knockOn = async (state: SfuState) => {
    const knocker = await join(state, ben);
    expect(knocker.status).toBe("waiting");
    return knocker;
  };
  const sentOn = (knocker: Awaited<ReturnType<typeof join>>) => ({
    told: knocker.told("serverRestarting"),
    disconnected: (knocker.context.socket.disconnect as ReturnType<typeof vi.fn>).mock.calls,
  });

  it("keeps its seats and its waiting guests when its own SFU claims the code again", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const sfuA = await startSfu(leases.forInstance("sfu-a"));
    const hostOnA = await join(sfuA, host("a"));
    const knocker = await knockOn(sfuA);
    const room = sfuA.rooms.get(CHANNEL)!;
    const before = room.ownershipGeneration;

    leases.forget();
    await vi.advanceTimersByTimeAsync(1_000);
    await renewRoomOwnerships(sfuA);
    await settle();

    expect(sfuA.rooms.get(CHANNEL)).toBe(room);
    expect(room.ownershipGeneration).not.toBe(before);
    expect(sentOn(knocker)).toEqual({ told: [], disconnected: [] });
    const [request] = hostOnA.told("userRequestedJoin") as Array<{ userId: string }>;
    expect(await hostOnA.send("admitUser", { userId: request.userId })).toEqual(
      expect.objectContaining({ success: true }),
    );
    expect(knocker.told("joinApproved")).toHaveLength(1);
  });

  it.each(["fence", "read"] as const)(
    "ends its meeting, and the removals made in it, when its last person leaves while the booking's %s is still on its way",
    async (waitsOn) => {
      useSharedSchedule();
      await book();
      const leases = sharedLeases();
      const recovery = createMemoryRoomRecoveryStore();
      const persistence = createScheduledMeetingPersistence();
      const fence = persistence.fenceMeeting!.bind(persistence);
      const read = persistence.loadOne!.bind(persistence);
      let arrived: () => void = () => {};
      let onItsWay: Promise<void> | null = null;
      persistence.fenceMeeting = async (...args) => {
        if (waitsOn === "fence") await onItsWay;
        return fence(...args);
      };
      persistence.loadOne = async (id) => {
        if (waitsOn === "read") await onItsWay;
        return read(id);
      };
      const sfuA = await startSfu(leases.forInstance("sfu-a"), { recovery, persistence });
      const hostOnA = await join(sfuA, host("a"));
      expect((await join(sfuA, invitee)).status).toBe("joined");
      expect(await hostOnA.send("kickUser", { userId: INVITEE_SEAT })).toEqual({ success: true });
      await settle();
      expect(await inviteeIsInvited()).toBe(false);

      leases.forget();
      await vi.advanceTimersByTimeAsync(1_000);
      onItsWay = new Promise<void>((resolve) => (arrived = resolve));
      const renewing = renewRoomOwnerships(sfuA);
      await settle();
      expect(sfuA.roomRegistry.holdsLease(CHANNEL)).toBe(true);

      await hostOnA.leave();
      await settle();
      arrived();
      await renewing;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sfuA.rooms.has(CHANNEL)).toBe(false);
      const recalled = await createRoomRecoveryLedger(recovery).recall(CHANNEL);
      expect(recalled.lost).toBeNull();
      expect(recalled.passesVoidUntil).not.toBeNull();
      expect(await inviteeIsInvited()).toBe(true);
      expect(leases.ownerOf(CHANNEL)).toBeNull();
    },
  );

  it("signs no pass and runs no host command while it is being claimed again, and runs the command once it is", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const persistence = createScheduledMeetingPersistence();
    const fence = persistence.fenceMeeting!.bind(persistence);
    let arrived: () => void = () => {};
    let onItsWay: Promise<void> | null = null;
    persistence.fenceMeeting = async (...args) => {
      await onItsWay;
      return fence(...args);
    };
    const sfuA = await startSfu(leases.forInstance("sfu-a"), { persistence });
    const hostOnA = await join(sfuA, host("a"));
    expect((await join(sfuA, invitee)).status).toBe("joined");
    const room = sfuA.rooms.get(CHANNEL)!;
    const before = room.ownershipGeneration;
    const stopRefresh = startRoomRecoveryPassRefresh(sfuA, config.sfuSecret);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await renewRoomOwnerships(sfuA);
      await vi.advanceTimersByTimeAsync(28_000);
      leases.forget();
      onItsWay = new Promise<void>((resolve) => (arrived = resolve));
      await renewRoomOwnerships(sfuA);
      await settle();
      expect(sfuA.roomRegistry.holdsLease(CHANNEL)).toBe(true);
      expect(room.ownershipGeneration).toBe(before);

      const kick = hostOnA.send("kickUser", { userId: INVITEE_SEAT });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await inviteeIsInvited()).toBe(true);
      expect(room.clients.size).toBe(2);
      expect(hostOnA.passes()).toBe(0);

      arrived();
      await settle();
      expect(room.ownershipGeneration).not.toBe(before);
      expect(await kick).toEqual({ success: true });
      await settle();
      expect(await inviteeIsInvited()).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await renewRoomOwnerships(sfuA);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(hostOnA.passes()).toBe(1);
    } finally {
      stopRefresh();
    }
  });

  it("hands off, and writes nothing it decided meanwhile, when its fences have not landed in time", async () => {
    vi.spyOn(Logger, "error").mockImplementation(() => undefined);
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const recovery = createMemoryRoomRecoveryStore();
    const persistence = createScheduledMeetingPersistence();
    const fence = persistence.fenceMeeting!.bind(persistence);
    let stalls = false;
    persistence.fenceMeeting = (...args) =>
      stalls ? new Promise<boolean>(() => undefined) : fence(...args);
    const sfuA = await startSfu(leases.forInstance("sfu-a"), { recovery, persistence });
    const hostOnA = await join(sfuA, host("a"));
    expect((await join(sfuA, invitee)).status).toBe("joined");
    const knocker = await knockOn(sfuA);

    leases.forget();
    await vi.advanceTimersByTimeAsync(1_000);
    stalls = true;
    await renewRoomOwnerships(sfuA);
    await settle();
    const kick = hostOnA.send("kickUser", { userId: INVITEE_SEAT });
    await vi.advanceTimersByTimeAsync(ROOM_WRITE_COMMIT_MS + 1_000);

    expect(await kick).toEqual({ error: ROOM_LEASE_UNCONFIRMED_ERROR });
    expect(sfuA.rooms.has(CHANNEL)).toBe(false);
    expect(sentOn(knocker).told).toEqual([expect.objectContaining({ reconnecting: true })]);
    expect(await inviteeIsInvited()).toBe(true);
    expect((await createRoomRecoveryLedger(recovery).recall(CHANNEL)).lost).not.toBeNull();
  });

  it("sends its waiting guests on with its seats when another SFU took the code", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const sfuA = await startSfu(leases.forInstance("sfu-a"));
    const sfuB = await startSfu(leases.forInstance("sfu-b"));
    await join(sfuA, host("a"));
    const knocker = await knockOn(sfuA);

    leases.forget();
    expect((await join(sfuB, host("b"))).status).toBe("joined");
    await renewRoomOwnerships(sfuA).catch(() => undefined);
    await settle();

    expect(sfuA.rooms.has(CHANNEL)).toBe(false);
    expect(sentOn(knocker)).toEqual({
      told: [expect.objectContaining({ reconnecting: true })],
      disconnected: [[true]],
    });
  });

  it("sends everyone on when another room wrote the code's record while the lease was gone", async () => {
    useSharedSchedule();
    await book();
    const leases = sharedLeases();
    const recovery = createMemoryRoomRecoveryStore();
    const sfuA = await startSfu(leases.forInstance("sfu-a"), { recovery });
    const sfuB = await startSfu(leases.forInstance("sfu-b"), { recovery });
    await join(sfuA, host("a"));
    const knocker = await knockOn(sfuA);

    leases.forget();
    const hostOnB = await join(sfuB, host("b"));
    expect(hostOnB.status).toBe("joined");
    await hostOnB.leave();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sfuB.rooms.has(CHANNEL)).toBe(false);
    expect(leases.ownerOf(CHANNEL)).toBeNull();

    await renewRoomOwnerships(sfuA);
    await settle();

    expect(sfuA.rooms.has(CHANNEL)).toBe(false);
    expect(sentOn(knocker).told).toEqual([expect.objectContaining({ reconnecting: true })]);
  });
});

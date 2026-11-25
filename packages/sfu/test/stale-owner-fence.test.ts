import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { initScheduledMeetings } from "../server/init.js";
import { createMemoryRoomRecoveryStore } from "../server/roomRecoveryLedger.js";
import { startRoomRecoveryPassRefresh } from "../server/roomRecoveryPass.js";
import type {
  RoomAssignmentRecord,
  RoomOwnerRecord,
  RoomOwnershipClaim,
  RoomRegistry,
} from "../server/roomRegistry.js";
import { ROOM_LEASE_UNCONFIRMED_ERROR } from "../server/rooms.js";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  isScheduledMeetingInvitee,
  loadPersistedMeetings,
  persistScheduledMeetingChanges,
} from "../server/scheduledMeetings.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext, setSocketContext } from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";

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
};

const sharedLeases = (): Leases => {
  const owners = new Map<string, RoomOwnerRecord>();
  const live = (channelId: string) => {
    const owner = owners.get(channelId);
    return owner && owner.expiresAt > Date.now() ? owner : null;
  };
  let holding = false;
  const held: Array<() => void> = [];
  const forInstance = (instanceId: string): RoomRegistry => {
    const servesUntil = new Map<string, number>();
    const claimNow = (input: { channelId: string; clientId: string; roomId: string }): RoomOwnershipClaim => {
      const current = live(input.channelId);
      if (current && current.instanceId !== instanceId) return { ok: false, owner: current };
      const now = Date.now();
      const owner: RoomOwnerRecord = { kind: "owner", ...input, instanceId, updatedAt: now, expiresAt: now + LEASE_MS };
      owners.set(input.channelId, owner);
      servesUntil.set(input.channelId, now + LEASE_MS - LEASE_MARGIN_MS);
      return { ok: true, owner, continuous: current !== null };
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
      holdsLease: (channelId) => (servesUntil.get(channelId) ?? 0) > Date.now(),
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
  };
};

const io = {
  to: () => ({ emit: vi.fn() }),
  in: () => ({ disconnectSockets: vi.fn() }),
} as unknown as SocketIOServer;

const startSfu = async (registry: RoomRegistry): Promise<SfuState> => {
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: vi.fn(),
  } as unknown as Router;
  const state = createSfuState({ roomRegistry: registry, roomRecoveryStore: createMemoryRoomRecoveryStore() });
  state.workers = [{ pid: 1, closed: false, createRouter: vi.fn(async () => router) } as unknown as Worker];
  await initScheduledMeetings(state, createScheduledMeetingPersistence());
  return state;
};

type Answer = { success?: boolean; error?: string; status?: string };

const join = async (state: SfuState, user: SfuAuthPayload) => {
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
  const send = (event: string, payload: unknown): Promise<Answer> =>
    new Promise((resolve) => {
      void handlers.get(event)?.(...([payload, resolve] as never[]));
    });
  const joined = await send("joinRoom", { roomId: CODE, sessionId: user.sessionId });
  const leave = async (reason = "client namespace disconnect") => {
    wire.connected = false;
    await handlers.get("disconnect")?.(...([reason] as never[]));
  };
  const passes = () => emit.mock.calls.filter(([event]) => event === "roomRecoveryPass").length;
  return { context, send, leave, passes, status: joined.status };
};

const dirs: string[] = [];
afterEach(() => {
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

type LeaseState = "held" | "renewing" | "lapsed but still the owner" | "lost";
type Action = "kick the invitee" | "admit the invitee" | "end the meeting" | "the last person leaves";

const LEASE_STATES: LeaseState[] = ["held", "renewing", "lapsed but still the owner", "lost"];
const ACTIONS: Array<{
  action: Action;
  inviteeRemovedFirst: boolean;
  invitedAfter: boolean;
  answers: boolean;
}> = [
  { action: "kick the invitee", inviteeRemovedFirst: false, invitedAfter: false, answers: true },
  { action: "admit the invitee", inviteeRemovedFirst: true, invitedAfter: true, answers: true },
  { action: "end the meeting", inviteeRemovedFirst: true, invitedAfter: true, answers: true },
  { action: "the last person leaves", inviteeRemovedFirst: true, invitedAfter: true, answers: false },
];

const runCase = async (action: (typeof ACTIONS)[number], lease: LeaseState) => {
  useSharedSchedule();
  await book();
  const leases = sharedLeases();
  const sfuA = await startSfu(leases.forInstance("sfu-a"));
  const hostOnA = await join(sfuA, host("a"));
  expect(hostOnA.status).toBe("joined");
  if (action.inviteeRemovedFirst || action.action === "kick the invitee") {
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

  if (lease !== "held") await vi.advanceTimersByTimeAsync(LEASE_MS - LEASE_MARGIN_MS + 2_000);
  if (lease === "renewing") leases.holdRenewals();
  if (lease === "lost") {
    await vi.advanceTimersByTimeAsync(LEASE_MARGIN_MS);
    expect((await leases.forInstance("sfu-b").claimRoom({ channelId: CHANNEL, clientId: "conclave", roomId: CODE })).ok).toBe(true);
  }
  const invitedBefore = await inviteeIsInvited();

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
  }
  await settle();
  if (lease === "renewing") {
    expect(await inviteeIsInvited()).toBe(invitedBefore);
    expect(leases.ownerOf(CHANNEL)).toBe("sfu-a");
    leases.releaseRenewals();
    await settle();
  }
  if (lease === "lost") expect(leases.ownerOf(CHANNEL)).toBe("sfu-b");
  await vi.advanceTimersByTimeAsync(30_000);

  const written = lease !== "lost";
  if (action.answers) {
    expect(await answer).toEqual(
      written ? expect.objectContaining({ success: true }) : { error: ROOM_LEASE_UNCONFIRMED_ERROR },
    );
  }
  expect(await inviteeIsInvited()).toBe(written ? action.invitedAfter : invitedBefore);
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
      await sfuA.roomRegistry.renewRoom({ channelId: CHANNEL, clientId: "conclave", roomId: CODE });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(hostOnA.passes()).toBe(1);
    } finally {
      stopRefresh();
    }
  });

  it("does not end an invitee's removal that the SFU now running the call made", async () => {
    useSharedSchedule();
    const graceBefore = config.socket.disconnectGraceMs;
    config.socket.disconnectGraceMs = 120_000;
    try {
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
    } finally {
      config.socket.disconnectGraceMs = graceBefore;
    }
  });
});

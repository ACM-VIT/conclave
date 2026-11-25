import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../config/classes/Admin.js";
import { config } from "../config/config.js";
import { initScheduledMeetings } from "../server/init.js";
import { createMemoryRoomRecoveryStore } from "../server/roomRecoveryLedger.js";
import { startRoomRecoveryPassRefresh } from "../server/roomRecoveryPass.js";
import type {
  RoomAssignmentRecord,
  RoomOwnerRecord,
  RoomRegistry,
} from "../server/roomRegistry.js";
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
const host = (sessionId: string): SfuAuthPayload => ({
  userId: "host@example.com",
  email: "host@example.com",
  clientId: "conclave",
  sessionId,
});
const invitee: SfuAuthPayload = { userId: "user-2", email: INVITEE, clientId: "conclave", sessionId: "i" };

const sharedLeases = () => {
  const owners = new Map<string, RoomOwnerRecord>();
  const live = (channelId: string) => {
    const owner = owners.get(channelId);
    return owner && owner.expiresAt > Date.now() ? owner : null;
  };
  return (instanceId: string): RoomRegistry => {
    const servesUntil = new Map<string, number>();
    const claim = async (input: { channelId: string; clientId: string; roomId: string }) => {
      const current = live(input.channelId);
      if (current && current.instanceId !== instanceId) return { ok: false as const, owner: current };
      const now = Date.now();
      const owner: RoomOwnerRecord = {
        kind: "owner",
        ...input,
        instanceId,
        updatedAt: now,
        expiresAt: now + LEASE_MS,
      };
      owners.set(input.channelId, owner);
      servesUntil.set(input.channelId, now + LEASE_MS - LEASE_MARGIN_MS);
      return { ok: true as const, owner };
    };
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
        placement: {
          kind: "placement",
          ...input,
          instanceId,
          updatedAt: Date.now(),
          expiresAt: Date.now() + LEASE_MS,
        },
      }),
      claimRoom: claim,
      renewRoom: claim,
      releaseRoom: async (channelId) => {
        servesUntil.delete(channelId);
        if (owners.get(channelId)?.instanceId === instanceId) owners.delete(channelId);
      },
      isLocalOwner: (owner: RoomAssignmentRecord | null | undefined) =>
        owner?.instanceId === instanceId,
      holdsLease: (channelId) => (servesUntil.get(channelId) ?? 0) > Date.now(),
    };
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
  const ack = vi.fn();
  await handlers.get("joinRoom")!(...([{ roomId: CODE, sessionId: user.sessionId }, ack] as never[]));
  const drop = async () => {
    wire.connected = false;
    await handlers.get("disconnect")?.(...(["transport close"] as never[]));
  };
  const send = async (event: string, payload: unknown) => {
    const answer = vi.fn();
    await handlers.get(event)?.(...([payload, answer] as never[]));
    return answer.mock.calls[0]?.[0] as { success?: boolean; error?: string } | undefined;
  };
  const passes = () => emit.mock.calls.filter(([event]) => event === "roomRecoveryPass").length;
  return { context, ack, drop, send, passes, status: (ack.mock.calls[0]?.[0] as { status?: string })?.status };
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

describe("an SFU that lost a room's lease while it was paused", () => {
  it("writes nothing shared about the room: no invitee's removal, no recovery pass", async () => {
    useSharedSchedule();
    await book();
    const sfuA = await startSfu(sharedLeases()("sfu-a"));
    const hostOnA = await join(sfuA, host("a"));
    const inviteeOnA = await join(sfuA, invitee);
    expect(inviteeOnA.status).toBe("joined");
    const stopRefresh = startRoomRecoveryPassRefresh(sfuA, config.sfuSecret);
    try {
      await vi.advanceTimersByTimeAsync(LEASE_MS);
      expect(await hostOnA.send("kickUser", { userId: `${INVITEE}#i` })).toEqual({ success: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sfuA.rooms.get(CHANNEL)?.needsReadmission(INVITEE)).toBe(true);
      expect(await inviteeIsInvited()).toBe(true);
      expect(hostOnA.passes()).toBe(0);

      await sfuA.roomRegistry.renewRoom({ channelId: CHANNEL, clientId: "conclave", roomId: CODE });
      await vi.advanceTimersByTimeAsync(60_000);
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
      const sfuA = await startSfu(leases("sfu-a"));
      const sfuB = await startSfu(leases("sfu-b"));

      const hostOnA = await join(sfuA, host("a"));
      expect(hostOnA.status).toBe("joined");
      await hostOnA.drop();
      expect(sfuA.rooms.get(CHANNEL)?.clients.size).toBe(1);

      await vi.advanceTimersByTimeAsync(LEASE_MS + 5_000);
      const hostOnB = await join(sfuB, host("b"));
      expect(hostOnB.status).toBe("joined");
      expect(hostOnB.context.currentClient).toBeInstanceOf(Admin);
      const inviteeOnB = await join(sfuB, invitee);
      expect(inviteeOnB.status).toBe("joined");
      expect(await hostOnB.send("kickUser", { userId: `${INVITEE}#i` })).toEqual({ success: true });
      await vi.advanceTimersByTimeAsync(10);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(sfuA.rooms.get(CHANNEL)).toBeUndefined();

      expect(await inviteeIsInvited()).toBe(false);
    } finally {
      config.socket.disconnectGraceMs = graceBefore;
    }
  });
});

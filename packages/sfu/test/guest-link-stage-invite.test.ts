import { describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { seatIdOf } from "../server/identity.js";
import { advanceScheduledWebinars, notifyRoomConfig } from "../server/scheduledWebinarScheduler.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { getOrCreateWebinarRoomConfig, setCustomWebinarLinkSlug } from "../server/webinar.js";
import type { ScheduledWebinar } from "../types.js";
import { seed } from "./support/controlPlane.js";

type Handler = (...args: never[]) => void | Promise<void>;

const broadcast = vi.fn();
const io = { to: () => ({ emit: broadcast }) } as unknown as SocketIOServer;

const makeState = (): SfuState => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "guest-link-stage-invite-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: vi.fn(),
  } as unknown as Router;
  state.workers = [
    { pid: 1, closed: false, createRouter: async () => router } as unknown as Worker,
  ];
  return state;
};

let sockets = 0;
const join = async (state: SfuState, user: SfuAuthPayload, roomId = "room", admissionCode?: string) => {
  const handlers = new Map<string, Handler>();
  const emit = vi.fn();
  const joinChannel = vi.fn();
  const socket = {
    id: `socket-${++sockets}`,
    data: { user: "guestRoom" in user ? user : { ...user, guestRoom: roomId } },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit,
    disconnect: vi.fn(),
    connected: true,
    join: joinChannel,
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  const context = createConnectionContext(io, socket, state);
  registerJoinRoomHandler(context);
  const ack = vi.fn();
  await handlers.get("joinRoom")!(...[{ roomId, sessionId: user.sessionId, admissionCode }, ack] as never[]);
  return { context, ack, emit, joinChannel };
};

const joined: unknown = expect.objectContaining({ status: "joined" });

const host = {
  userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA.tab-1",
  clientId: "conclave",
  sessionId: "tab-1",
  allowRoomCreation: true,
  guestProof: "proof-of-the-host-pass",
  guestRoom: "room",
} satisfies SfuAuthPayload;
const invitedViewer = {
  userId: "guest-gp_KKKKKKKKKKKKKKKKKKKKKK",
  clientId: "conclave",
  sessionId: "view-1",
  joinMode: "webinar_attendee",
  guestProof: "proof-of-the-invited-pass",
} satisfies SfuAuthPayload;
const otherViewer = {
  userId: "guest-gp_MMMMMMMMMMMMMMMMMMMMMM",
  clientId: "conclave",
  sessionId: "view-2",
  joinMode: "webinar_attendee",
  guestProof: "proof-of-the-other-pass",
} satisfies SfuAuthPayload;
const onStage = {
  userId: "guest-gp_LLLLLLLLLLLLLLLLLLLLLL",
  clientId: "conclave",
  sessionId: "stage-1",
  joinMode: "meeting",
  guestProof: otherViewer.guestProof,
  guestRoom: "room",
  guestWas: [{ userKey: invitedViewer.userId, guestProof: invitedViewer.guestProof }],
} satisfies SfuAuthPayload;

const scheduleWebinarFor = (state: SfuState) => {
  const now = Date.now();
  const webinar: ScheduledWebinar = {
    id: "webinar-1",
    clientId: "conclave",
    roomId: "room",
    linkSlug: "scheduled-launch",
    title: "Launch",
    description: "",
    hostEmail: "host@example.com",
    hostName: "Host",
    hostUserId: null,
    coHosts: [],
    scheduledStartAt: now,
    scheduledEndAt: now + 60 * 60 * 1000,
    status: "live",
    publicAccess: true,
    maxAttendees: 500,
    requiresInviteCode: false,
    waitingRoomEnabled: true,
    earlyEntryMinutes: 10,
    qaEnabled: true,
    notes: "",
    createdAt: now,
    createdBy: "host@example.com",
    updatedAt: now,
    liveStartedAt: now,
    endedAt: null,
    totalJoinCount: 0,
    peakAttendeeCount: 0,
    webinarLink: "http://localhost:3000/w/scheduled-launch",
    coHostInviteTokenHash: null,
    coHostInviteTokenCreatedAt: null,
  };
  return seed(state.controlPlane, "webinar", webinar);
};

const lockedWebinarWithAnInvite = async (mergeFits: (call: number) => boolean, commits = true) => {
  const state = makeState();
  expect((await join(state, host)).ack).toHaveBeenCalledWith(joined);
  const room = state.rooms.get("conclave:room")!;
  const config = getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId);
  config.enabled = true;
  config.publicAccess = true;
  setCustomWebinarLinkSlug({
    webinarConfig: config,
    webinarLinks: state.webinarLinks,
    room: { channelId: room.channelId, id: room.id, clientId: room.clientId },
    slug: "launch",
  });
  expect((await join(state, invitedViewer, "launch")).ack).toHaveBeenCalledWith(joined);
  expect((await join(state, otherViewer, "launch")).ack).toHaveBeenCalledWith(joined);
  room.setLocked(true);
  room.promoteWebinarUserKey(invitedViewer.userId);
  room.holdGuestIdentityOf(invitedViewer.userId);
  room.holdGuestIdentityOf(otherViewer.userId);
  let calls = 0;
  room.setGuestIdentityMerger(() => (mergeFits((calls += 1)) ? { commit: () => commits } : null));
  return { state, room };
};

describe("a stage invite held under another of a guest's passes (Greptile)", () => {
  it("lets the guest onto the stage when the room's apps can merge its passes", async () => {
    const { state, room } = await lockedWebinarWithAnInvite(() => true);

    const attempt = await join(state, onStage);

    expect(attempt.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", webinarRole: "participant" }),
    );
    expect(room.guestIdentityOf(onStage.userId)).toBe(room.guestIdentityOf(invitedViewer.userId));
  });

  it("is not used when the merge stops fitting while the join waits for the room", async () => {
    const { state, room } = await lockedWebinarWithAnInvite((call) => call === 1);

    const attempt = await join(state, onStage);

    expect(attempt.ack).not.toHaveBeenCalledWith(joined);
    expect(room.getClient(`${onStage.userId}#${onStage.sessionId}`)).toBeUndefined();
    expect(room.guestIdentityOf(invitedViewer.userId)).toBe(invitedViewer.guestProof);
    expect(room.isWebinarPromotedUserKey(onStage.userId)).toBe(false);
  });

  it("is not used when the link the join relied on cannot be committed (Sol)", async () => {
    const { state, room } = await lockedWebinarWithAnInvite(() => true, false);

    const attempt = await join(state, onStage);

    expect(attempt.ack).not.toHaveBeenCalledWith(joined);
    expect(attempt.ack).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) as unknown }));
    expect(room.getClient(`${onStage.userId}#${onStage.sessionId}`)).toBeUndefined();
    expect(room.guestIdentityOf(invitedViewer.userId)).toBe(invitedViewer.guestProof);
    expect(room.isWebinarPromotedUserKey(onStage.userId)).toBe(false);
  });

  it.each([
    ["can merge its passes", () => true, true],
    ["stop fitting while the join waits for the room", (call: number) => call === 1, false],
  ])("in a scheduled webinar, lets the guest onto the stage only when the room's apps %s", async (_case, mergeFits, onTheStage) => {
    const { state, room } = await lockedWebinarWithAnInvite(mergeFits);
    await scheduleWebinarFor(state);

    const attempt = await join(state, onStage);

    expect(attempt.ack).toHaveBeenCalledWith(
      onTheStage
        ? expect.objectContaining({ status: "joined", webinarRole: "participant" })
        : { error: "Use the public webinar link to join as an attendee." },
    );
    expect(room.getClient(`${onStage.userId}#${onStage.sessionId}`) !== undefined).toBe(onTheStage);
  });
});

describe("a join whose guest link cannot commit", () => {
  it.each(["host", "admitted", "stage invite", "webinar promoted", "locked waiting"] as const)(
    "leaves room state and sockets unchanged on the %s path",
    async (path) => {
      const { state, room } = await lockedWebinarWithAnInvite(() => true, false);
      if (path !== "webinar promoted") room.declineStageInvite(invitedViewer.userId);
      const guestWas = [...onStage.guestWas];
      if (path === "host") {
        room.holdGuestIdentityOf(host.userId);
        guestWas.push({ userKey: host.userId, guestProof: host.guestProof });
      }
      const joining = { ...onStage, guestWas };
      if (path === "stage invite") room.promoteWebinarUserKey(joining.userId);
      if (path === "webinar promoted") await scheduleWebinarFor(state);
      const admissionCode = path === "admitted" ? room.createAdmission().admissionCode : undefined;
      const oldEmit = vi.fn();
      const oldDisconnect = vi.fn();
      const oldSocket = {
        id: "old-waiting-socket",
        emit: oldEmit,
        disconnect: oldDisconnect,
        connected: true,
      } as unknown as Socket;
      room.addPendingClient(
        invitedViewer.userId,
        seatIdOf(invitedViewer.userId, joining.sessionId),
        oldSocket,
        "Previous request",
        invitedViewer.guestProof,
      );
      room.startCleanupTimer(vi.fn());
      const timer = room.cleanupDeadline;
      const hostKey = room.hostUserKey;
      const pending = [...room.pendingClients.entries()];
      const clients = [...room.clients.keys()];
      const decisions = room.decisionRecordCount;
      const bindings = room.boundGuestIdentityCount;
      const emitters = [...room.clients.values()].map((client) => vi.spyOn(client.socket, "emit"));
      for (const emit of emitters) emit.mockClear();
      broadcast.mockClear();

      try {
        const attempt = await join(state, joining, "room", admissionCode);

        expect(attempt.ack).toHaveBeenCalledWith({
          error: "Your other tabs in this meeting changed while this one joined. Join again.",
        });
        expect(room.hostUserKey).toBe(hostKey);
        expect(room.isAdminUserKey(joining.userId)).toBe(false);
        expect(room.cleanupDeadline).toBe(timer);
        expect([...room.pendingClients.entries()]).toEqual(pending);
        expect([...room.clients.keys()]).toEqual(clients);
        expect(room.decisionRecordCount).toBe(decisions);
        expect(room.boundGuestIdentityCount).toBe(bindings);
        expect(room.isLockedAllowed(joining.userId, joining.guestProof)).toBe(false);
        expect(room.guestIdentityOf(invitedViewer.userId)).toBe(invitedViewer.guestProof);
        expect(attempt.context.currentUserKey).toBeNull();
        expect(attempt.emit).not.toHaveBeenCalled();
        expect(attempt.joinChannel).not.toHaveBeenCalled();
        expect(oldEmit).not.toHaveBeenCalled();
        expect(oldDisconnect).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
        for (const emit of emitters) expect(emit).not.toHaveBeenCalled();

        if (path === "webinar promoted") {
          const notify = notifyRoomConfig(state, () => io);
          await advanceScheduledWebinars(state, Date.now(), notify);
          await advanceScheduledWebinars(state, Date.now(), notify);
          expect(broadcast.mock.calls).toEqual([
            ["webinar:configChanged", expect.objectContaining({ linkSlug: "scheduled-launch" })],
          ]);
        }

        if (admissionCode) {
          room.setGuestIdentityMerger(() => ({ commit: () => true }));
          expect((await join(state, joining, "room", admissionCode)).ack).toHaveBeenCalledWith(joined);
        }
      } finally {
        room.stopCleanupTimer();
      }
    },
  );
});

it("settles other tabs' waiting requests using the admission redeemed by the successful join", async () => {
  const { state, room } = await lockedWebinarWithAnInvite(() => true);
  room.declineStageInvite(invitedViewer.userId);
  const waiting = await join(state, {
    ...invitedViewer,
    joinMode: "meeting",
    guestRoom: room.id,
    sessionId: "waiting-tab",
  });
  expect(waiting.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));
  const { admissionCode } = room.createAdmission();

  expect((await join(state, onStage, "room", admissionCode)).ack).toHaveBeenCalledWith(joined);

  expect(waiting.emit).toHaveBeenCalledWith("joinApproved", { roomId: room.id });
  expect(room.pendingClients.has(invitedViewer.userId)).toBe(false);
});

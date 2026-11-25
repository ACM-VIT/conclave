import { describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { getOrCreateWebinarRoomConfig, setCustomWebinarLinkSlug } from "../server/webinar.js";
import type { ScheduledWebinar } from "../types.js";

type Handler = (...args: never[]) => void | Promise<void>;

const io = { to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer;

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
const join = async (state: SfuState, user: SfuAuthPayload, roomId = "room") => {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: `socket-${++sockets}`,
    data: { user: "guestRoom" in user ? user : { ...user, guestRoom: roomId } },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    join: vi.fn(),
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  const context = createConnectionContext(io, socket, state);
  registerJoinRoomHandler(context);
  const ack = vi.fn();
  await handlers.get("joinRoom")!(...[{ roomId, sessionId: user.sessionId }, ack] as never[]);
  return { context, ack };
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
  state.scheduledWebinars.byId.set(webinar.id, webinar);
  state.scheduledWebinars.bySlug.set(webinar.linkSlug, webinar.id);
  state.scheduledWebinars.byRoomChannel.set("conclave:room", webinar.id);
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
    scheduleWebinarFor(state);

    const attempt = await join(state, onStage);

    expect(attempt.ack).toHaveBeenCalledWith(
      onTheStage
        ? expect.objectContaining({ status: "joined", webinarRole: "participant" })
        : { error: "Use the public webinar link to join as an attendee." },
    );
    expect(room.getClient(`${onStage.userId}#${onStage.sessionId}`) !== undefined).toBe(onTheStage);
  });
});

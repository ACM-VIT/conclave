import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import type { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { cleanupDeadWorkerRooms, initScheduledMeetings } from "../server/init.js";
import { ROOM_OPEN_DEADLINE_MS } from "../server/joinDeadlines.js";
import {
  createMemoryRoomRecoveryStore,
  type RoomRecoveryStore,
} from "../server/roomRecoveryLedger.js";
import { startRoomRecoveryPassRefresh } from "../server/roomRecoveryPass.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { renewRoomOwnerships } from "../server/rooms.js";
import {
  createScheduledMeeting,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import {
  createConnectionContext,
  getSocketContext,
  setSocketContext,
  type ConnectionContext,
} from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { forceDrainRooms, handOffRooms } from "../server/serverShutdown.js";
import { createScheduledWebinar } from "../server/scheduledWebinars.js";
import { ensureWebinarRoomConfig } from "../server/scheduledWebinarScheduler.js";
import { createSfuState, type SfuState } from "../server/state.js";
import type { ScheduledMeeting } from "../types.js";
import { Logger } from "../utilities/loggers.js";

const CODE = "abc-mnop-xyz";
const CHANNEL = `conclave:${CODE}`;
const OTHER_CODE = "zzz-yyyy-xxx";
const OTHER_CHANNEL = `conclave:${OTHER_CODE}`;
const GRACES_MS = [0, 15_000, 120_000];
const WEBINAR_SLUG = "model-webinar";
const WEBINAR_CODE = "right-code";
type WebinarGate = "code" | "locked" | "full";
const SEQUENCES = Number(process.env.ROOM_LIFECYCLE_SEQUENCES ?? "300");
const FIRST_SEED = Number(process.env.ROOM_LIFECYCLE_FIRST_SEED ?? "1");
const STEPS_PER_SEQUENCE = 32;
const START = new Date("2026-11-23T09:00:00Z");
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const BETWEEN_STEPS_MS = 50;

type ActorName = "owner" | "alice" | "bob" | "carol" | "invitee" | "dana" | "olddana";
const ACTOR_NAMES: ActorName[] = ["owner", "alice", "bob", "carol", "invitee", "dana", "olddana"];
const DANA = "pass:proof-dana";
const DANA_KEY_PREFIX = "guest-gp_dana-";
const DANA_PASSES = ["proof-dana", "proof-dana-b"];
const OLD_DANA_KEY = "guest-olddana";
const personOf = (key: string): string => (key.startsWith(DANA_KEY_PREFIX) ? DANA : key);
const removalPersonOf = (key: string): string => (key === OLD_DANA_KEY ? DANA : personOf(key));
const USERS: Record<ActorName, SfuAuthPayload> = {
  owner: {
    userId: "owner@example.com",
    email: "owner@example.com",
    clientId: "conclave",
    sessionId: "o",
    allowRoomCreation: true,
  },
  alice: { userId: "guest-alice", clientId: "conclave", sessionId: "a", allowRoomCreation: true },
  bob: { userId: "guest-bob", clientId: "conclave", sessionId: "b", allowRoomCreation: true },
  carol: { userId: "guest-carol", clientId: "conclave", sessionId: "c" },
  invitee: {
    userId: "invitee@example.com",
    email: "invitee@example.com",
    clientId: "conclave",
    sessionId: "i",
  },
  dana: {
    userId: `${DANA_KEY_PREFIX}d`,
    clientId: "conclave",
    sessionId: "d",
    guestProof: "proof-dana",
    guestRoom: CODE,
    allowRoomCreation: true,
  },
  olddana: {
    userId: OLD_DANA_KEY,
    clientId: "conclave",
    sessionId: "od",
    guestProof: "proof-dana",
    allowRoomCreation: true,
  },
};

type Handler = (...args: unknown[]) => unknown;
type Peer = {
  socket: Socket;
  wire: { connected: boolean };
  handlers: Map<string, Handler>;
  events: Array<{ event: string; payload: unknown }>;
  holdLeave: boolean;
  holdJoin: boolean;
};
type Sfu = {
  generation: number;
  state: SfuState;
  io: SocketIOServer;
  channels: Map<string, Set<Peer>>;
  peers: Set<Peer>;
  heldLeaves: Array<() => void>;
  heldJoins: Array<() => void>;
  membership: Map<Room, number>;
  ranThisStep: Map<string, string>;
  stopRefresh: () => void;
};
type Tab = {
  user: SfuAuthPayload;
  peer: Peer;
  context: ConnectionContext;
  generation: number;
  approvalsSeen: number;
  toldSince: number;
};
type Actor = {
  name: ActorName;
  user: SfuAuthPayload;
  key: string;
  removalKey: string;
  tabsOpened: number;
  tab: Tab | null;
  second: Tab | null;
  pass: string | null;
  passKey: string | null;
  lastUser: SfuAuthPayload | null;
};
type JoinAck = { status?: string; error?: string; roomRecoveryPass?: string };
type Completion = {
  actor: Actor;
  channelId: string;
  response: JoinAck;
  admin: boolean;
  claim: boolean;
  incarnation: string | null;
  ownerEmail: string | null;
  seatId: string | null;
};
type Phase =
  | { kind: "none" }
  | { kind: "running"; incarnation: string; since: number }
  | {
      kind: "lost";
      callSince: number;
      since: number;
      until: number;
      hosts: Set<string>;
      members: Set<string>;
      removals: Set<string>;
    };
type Shadow = {
  phase: Phase;
  removed: Set<string>;
  ejected: Set<string>;
  members: Set<string>;
  cohosts: Set<string>;
};

type HostAction =
  | "admit"
  | "reject"
  | "kick"
  | "promote"
  | "transfer"
  | "block"
  | "blockStay"
  | "revoke"
  | "allow"
  | "lock"
  | "unlock";
type Shutdown = "drain" | "stop" | "worker" | "handoff";
type Step =
  | {
      kind: "open";
      actor: ActorName;
      pass: boolean;
      hold: boolean;
      reload?: boolean;
      claim?: boolean;
    }
  | { kind: "again"; actor: ActorName; pass: boolean }
  | {
      kind: "second";
      actor: ActorName;
      action: "open" | "leave";
      claim?: boolean;
      dropsWhileJoining?: boolean;
    }
  | { kind: "leave"; actor: ActorName }
  | { kind: "drop"; actor: ActorName }
  | { kind: "together"; actors: [ActorName, ActorName] }
  | { kind: "hold" }
  | { kind: "release"; alongside: ActorName | null }
  | { kind: "host"; action: HostAction; by: ActorName; target: ActorName }
  | { kind: "end"; by: ActorName }
  | { kind: "restart"; elsewhere?: boolean }
  | { kind: "shutdown"; how: Shutdown; leaver: ActorName | null; noticeMs?: number }
  | { kind: "tick"; ms: number }
  | { kind: "untilDeadline"; beforeMs: number }
  | { kind: "switch"; actor: ActorName; overtaken: null | "disconnect" | "newer" }
  | { kind: "attend"; code: "none" | "wrong" | "right" }
  | { kind: "expect"; actor: ActorName; tab: "main" | "second"; role: "host" | "participant" | "out" };

type World = {
  random: () => number;
  follows: () => boolean;
  durable: { recovery: RoomRecoveryStore; schedule: string };
  sfu: Sfu;
  generation: number;
  held: Array<() => void>;
  holdNext: boolean;
  actors: Record<ActorName, Actor>;
  shadow: Shadow;
  trace: string[];
  completions: Completion[];
  failures: string[];
  firstSeen: Map<string, number>;
  openers: Map<string, Set<string>>;
  tabs: number;
  webinar: WebinarGate | null;
  hostClaims: boolean;
  claimed: Set<string>;
};

const loggedErrors: string[] = [];
const quietLogs: Array<{ mockClear: () => unknown }> = [];
beforeAll(() => {
  quietLogs.push(
    vi.spyOn(Logger, "info").mockImplementation(() => undefined),
    vi.spyOn(Logger, "success").mockImplementation(() => undefined),
    vi.spyOn(Logger, "warn").mockImplementation(() => undefined),
    vi.spyOn(Logger, "debug").mockImplementation(() => undefined),
    vi.spyOn(Logger, "error").mockImplementation((message: string) => {
      loggedErrors.push(message);
    }),
  );
});
afterAll(() => {
  vi.restoreAllMocks();
});

const seeded = (seed: number): (() => number) => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const closePeer = (sfu: Sfu, peer: Peer, reason: string): void => {
  if (!peer.wire.connected) return;
  peer.wire.connected = false;
  for (const members of sfu.channels.values()) members.delete(peer);
  void peer.handlers.get("disconnect")?.(reason);
};

const makePeer = (sfu: Sfu, id: string, user: SfuAuthPayload): Peer => {
  const handlers = new Map<string, Handler>();
  const events: Peer["events"] = [];
  const wire = { connected: true };
  const peer = { handlers, events, wire, holdLeave: false, holdJoin: false } as Peer;
  sfu.peers.add(peer);
  const socket = {
    id,
    data: { user },
    get connected() {
      return wire.connected;
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    emit: (event: string, payload: unknown) => {
      events.push({ event, payload });
      return true;
    },
    disconnect: () => closePeer(sfu, peer, "server namespace disconnect"),
    join: (channel: string) => {
      const members = sfu.channels.get(channel) ?? new Set<Peer>();
      members.add(peer);
      sfu.channels.set(channel, members);
      if (!peer.holdJoin) return undefined;
      peer.holdJoin = false;
      return new Promise<void>((resolve) => sfu.heldJoins.push(resolve));
    },
    leave: (channel: string) => {
      sfu.channels.get(channel)?.delete(peer);
      if (!peer.holdLeave) return undefined;
      peer.holdLeave = false;
      return new Promise<void>((resolve) => sfu.heldLeaves.push(resolve));
    },
    to: (channel: string) => ({
      emit: (event: string, payload: unknown) => {
        for (const member of sfu.channels.get(channel) ?? []) {
          if (member !== peer) member.events.push({ event, payload });
        }
        return true;
      },
    }),
  };
  peer.socket = socket as unknown as Socket;
  return peer;
};

const makeIo = (sfu: Sfu): SocketIOServer =>
  ({
    to: (channel: string) => ({
      emit: (event: string, payload: unknown) => {
        for (const member of sfu.channels.get(channel) ?? []) {
          member.events.push({ event, payload });
        }
        return true;
      },
    }),
    in: (channel: string) => ({
      disconnectSockets: () => {
        for (const peer of [...(sfu.channels.get(channel) ?? [])]) {
          closePeer(sfu, peer, "server namespace disconnect");
        }
      },
    }),
  }) as unknown as SocketIOServer;

const boot = async (world: World): Promise<Sfu> => {
  world.generation += 1;
  const generation = world.generation;
  const alive = () => world.generation === generation;
  const recovery: RoomRecoveryStore = {
    read: (channelId) => world.durable.recovery.read(channelId),
    write: (channelId, record, takesOver) =>
      alive()
        ? world.durable.recovery.write(channelId, record, takesOver)
        : new Promise<boolean>(() => undefined),
  };
  const meetings = () => JSON.parse(world.durable.schedule) as ScheduledMeeting[];
  const schedule: ScheduledMeetingPersistence = {
    save: (snapshot) => {
      if (alive()) world.durable.schedule = JSON.stringify(snapshot);
    },
    load: () => meetings(),
    loadOne: (id) => meetings().find((meeting) => meeting.id === id) ?? null,
  };
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: () => undefined,
  } as unknown as Router;
  const worker = {
    pid: 1,
    closed: false,
    createRouter: async () => {
      if (world.holdNext) {
        world.holdNext = false;
        await new Promise<void>((resolve) => world.held.push(resolve));
      }
      return router;
    },
  } as unknown as Worker;
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: `model-sfu-${generation}`,
      instanceUrl: "http://localhost",
      ttlMs: 45_000,
    }),
    roomRecoveryStore: recovery,
  });
  state.workers = [worker];
  await initScheduledMeetings(state, schedule);
  const sfu: Sfu = {
    generation,
    state,
    channels: new Map(),
    peers: new Set(),
    heldLeaves: [],
    heldJoins: [],
    membership: new Map(),
    ranThisStep: new Map(),
    io: undefined as unknown as SocketIOServer,
    stopRefresh: () => undefined,
  };
  sfu.io = makeIo(sfu);
  const addRoom = state.rooms.set.bind(state.rooms);
  state.rooms.set = (channelId, room) => {
    observeRoom(sfu, room);
    return addRoom(channelId, room);
  };
  sfu.stopRefresh = startRoomRecoveryPassRefresh(state, config.sfuSecret);
  if (world.webinar) scheduleWebinar(state, world.webinar);
  return sfu;
};

const scheduleWebinar = (state: SfuState, gate: WebinarGate): void => {
  const { webinar, inviteCodeHash } = createScheduledWebinar(
    state.scheduledWebinars,
    {
      title: "Model webinar",
      scheduledStartAt: Date.now(),
      hostEmail: USERS.owner.email!,
      linkSlug: WEBINAR_SLUG,
      publicAccess: true,
      inviteCode: gate === "code" ? WEBINAR_CODE : null,
    },
    { clientId: "conclave", createdBy: USERS.owner.email!, defaultHostEmail: USERS.owner.email! },
  );
  webinar.status = "live";
  const roomConfig = ensureWebinarRoomConfig(state, webinar, inviteCodeHash);
  if (gate === "locked") roomConfig.locked = true;
  if (gate === "full") roomConfig.maxAttendees = 0;
};

const attend = (world: World, code: "none" | "wrong" | "right"): void => {
  const sfu = world.sfu;
  world.tabs += 1;
  const user = {
    userId: `guest-attendee-${world.tabs}`,
    clientId: "conclave",
    sessionId: `w${world.tabs}`,
    joinMode: "webinar_attendee",
  } satisfies SfuAuthPayload;
  const peer = makePeer(sfu, `attendee-tab-${world.tabs}`, user);
  const context = createConnectionContext(sfu.io, peer.socket, sfu.state);
  setSocketContext(peer.socket, context);
  registerJoinRoomHandler(context);
  registerDisconnectHandlers(context);
  const payload = {
    roomId: WEBINAR_SLUG,
    sessionId: user.sessionId,
    ...(code === "none" ? {} : { webinarInviteCode: code === "right" ? WEBINAR_CODE : "wrong-code" }),
  };
  void Promise.resolve(peer.handlers.get("joinRoom")?.(payload, () => undefined)).catch(
    (error: unknown) => {
      world.failures.push(`an attendee's join threw: ${String(error)}`);
    },
  );
};

const createWorld = async (options: {
  random: () => number;
  follows: () => boolean;
  scheduled: boolean;
  webinar?: WebinarGate | null;
  hostClaims?: boolean;
}): Promise<World> => {
  const actors = Object.fromEntries(
    ACTOR_NAMES.map((name) => [
      name,
      {
        name,
        user: name === "invitee" && options.scheduled ? { ...USERS.invitee, allowRoomCreation: true } : USERS[name],
        key: name === "dana" ? DANA : (USERS[name].email ?? USERS[name].userId!),
        removalKey: name === "dana" || name === "olddana" ? DANA : (USERS[name].email ?? USERS[name].userId!),
        tabsOpened: 0,
        tab: null,
        second: null,
        pass: null,
        passKey: null,
        lastUser: null,
      } satisfies Actor,
    ]),
  ) as Record<ActorName, Actor>;
  const world: World = {
    random: options.random,
    follows: options.follows,
    durable: { recovery: createMemoryRoomRecoveryStore(), schedule: "[]" },
    sfu: undefined as unknown as Sfu,
    generation: 0,
    held: [],
    holdNext: false,
    actors,
    shadow: {
      phase: { kind: "none" },
      removed: new Set(),
      ejected: new Set(),
      members: new Set(),
      cohosts: new Set(),
    },
    trace: [],
    completions: [],
    failures: [],
    firstSeen: new Map(),
    openers: new Map(),
    tabs: 0,
    webinar: options.webinar ?? null,
    hostClaims: options.hostClaims ?? false,
    claimed: new Set(),
  };
  world.sfu = await boot(world);
  if (options.scheduled) {
    const state = world.sfu.state;
    createScheduledMeeting(
      state.scheduledMeetings,
      {
        title: "Model call",
        scheduledStartAt: Date.now(),
        roomCode: CODE,
        hostEmail: USERS.owner.email!,
        attendeeEmail: USERS.invitee.email!,
      },
      {
        clientId: "conclave",
        createdBy: USERS.owner.email!,
        defaultHostEmail: USERS.owner.email!,
        defaultHostUserId: null,
      },
    );
    await state.scheduledMeetingPersistence?.save([...state.scheduledMeetings.byId.values()]);
  }
  world.trace.push(options.scheduled ? "a booked code" : "a code nobody booked");
  if (world.hostClaims) world.trace.push("and an app whose joins may claim the host's seat");
  if (world.webinar) {
    world.trace.push(
      {
        code: "and a live webinar that asks for an invite code",
        locked: "and a live webinar that is locked",
        full: "and a live webinar that is full",
      }[world.webinar],
    );
  }
  return world;
};

const liveRoom = (world: World): Room | undefined => world.sfu.state.rooms.get(CHANNEL);

const seatedKeys = (room: Room | undefined): Set<string> => {
  const keys = new Set<string>();
  if (!room) return keys;
  for (const userId of room.clients.keys()) {
    const key = room.userKeysById.get(userId);
    if (key) keys.add(personOf(key));
  }
  return keys;
};

const hostKeys = (room: Room | undefined): Set<string> =>
  new Set(
    [...(room?.adminUserKeys ?? []), ...(room?.hostUserKey ? [room.hostUserKey] : [])].map(personOf),
  );

const seatOf = (room: Room, person: string, except: string | null = null): string | null => {
  for (const userId of room.clients.keys()) {
    const key = room.userKeysById.get(userId);
    if (userId !== except && key !== undefined && personOf(key) === person) return userId;
  }
  return null;
};

const pendingKeyOf = (room: Room, person: string): string | null =>
  [...room.pendingClients.keys()].find((key) => personOf(key) === person) ?? null;

const keyOf = (world: World, actor: Actor, room: Room): string => {
  if (actor.name !== "dana") return actor.key;
  const seat = seatOf(room, actor.key);
  return (
    (seat ? room.userKeysById.get(seat) : undefined) ??
    pendingKeyOf(room, actor.key) ??
    liveTab(world, actor)?.user.userId ??
    liveSecondTab(world, actor)?.user.userId ??
    actor.lastUser?.userId ??
    USERS.dana.userId!
  );
};

const ownsCode = (actor: Actor, ownerEmail: string | null | undefined): boolean =>
  Boolean(actor.user.email) && ownerEmail === actor.user.email;

const isLive = (world: World, tab: Tab | null): tab is Tab =>
  Boolean(tab && tab.generation === world.sfu.generation && tab.peer.wire.connected);

const liveTab = (world: World, actor: Actor): Tab | null =>
  isLive(world, actor.tab) ? actor.tab : null;

const liveSecondTab = (world: World, actor: Actor): Tab | null =>
  isLive(world, actor.second) ? actor.second : null;

const liveTabsOf = (world: World, actor: Actor): Tab[] =>
  [actor.tab, actor.second].filter((tab): tab is Tab => isLive(world, tab));

const hostsLiveRoom = (world: World, actor: Actor): boolean => {
  const tab = liveTab(world, actor);
  const room = liveRoom(world);
  return Boolean(
    tab &&
      room &&
      tab.context.currentRoom === room &&
      tab.context.currentClient instanceof Admin &&
      !tab.context.currentClient.isObserver,
  );
};

const danaTab = (tab: number, nth: number): SfuAuthPayload => ({
  ...USERS.dana,
  userId: `${DANA_KEY_PREFIX}${tab}`,
  sessionId: `d${tab}`,
  guestProof: DANA_PASSES[nth % 2],
  guestWas: [{ userKey: `${DANA_KEY_PREFIX}${tab}-was`, guestProof: DANA_PASSES[(nth + 1) % 2] }],
});

const openTab = (
  world: World,
  actor: Actor,
  which: "main" | "second" = "main",
  reload = false,
  claim = false,
): Tab => {
  const sfu = world.sfu;
  world.tabs += 1;
  const reloading = reload && which === "main" && actor.lastUser;
  if (!reloading) actor.tabsOpened += 1;
  const opened =
    reloading && actor.lastUser
      ? actor.lastUser
      : actor.name === "dana"
        ? danaTab(world.tabs, actor.tabsOpened - 1)
        : actor.name === "olddana"
          ? {
              ...actor.user,
              sessionId: which === "second" ? `${actor.user.sessionId}2` : actor.user.sessionId,
              guestProof: DANA_PASSES[Math.max(0, world.actors.dana.tabsOpened - 1) % 2],
            }
          : which === "second"
          ? { ...actor.user, sessionId: `${actor.user.sessionId}2` }
          : actor.user;
  if (which === "main") actor.lastUser = opened;
  const user = claim ? { ...opened, isHost: true } : opened;
  const peer = makePeer(sfu, `${actor.name}-tab-${world.tabs}`, user);
  const context = createConnectionContext(sfu.io, peer.socket, sfu.state);
  setSocketContext(peer.socket, context);
  registerJoinRoomHandler(context);
  registerDisconnectHandlers(context);
  const tab: Tab = {
    user,
    peer,
    context,
    generation: sfu.generation,
    approvalsSeen: 0,
    toldSince: 0,
  };
  if (which === "second") actor.second = tab;
  else actor.tab = tab;
  return tab;
};

const approvalsOf = (tab: Tab): number =>
  tab.peer.events.filter(({ event }) => event === "joinApproved").length;

const startJoin = (
  world: World,
  actor: Actor,
  tab: Tab,
  presentPass: boolean,
  roomId: string = CODE,
): void => {
  tab.approvalsSeen = approvalsOf(tab);
  const toldFrom = tab.peer.events.length;
  const handler = tab.peer.handlers.get("joinRoom");
  if (!handler) throw new Error(`${actor.name}'s tab has no join handler`);
  let answered = false;
  const ack = (response: JoinAck) => {
    if (tab.generation !== world.sfu.generation) return;
    if (answered) {
      world.failures.push(`${actor.name}'s join was answered twice`);
      return;
    }
    answered = true;
    if (response.status === "joined") tab.toldSince = toldFrom;
    if (response.roomRecoveryPass) {
      actor.pass = response.roomRecoveryPass;
      actor.passKey = tab.user.userId ?? null;
    }
    world.completions.push({
      actor,
      channelId: `conclave:${roomId}`,
      response,
      admin: tab.context.currentClient instanceof Admin,
      claim: tab.user.isHost === true,
      incarnation: tab.context.currentRoom?.incarnationId ?? null,
      ownerEmail: tab.context.currentRoom?.ownerEmail ?? null,
      seatId: tab.context.currentClient?.id ?? null,
    });
  };
  const payload = {
    roomId,
    sessionId: tab.user.sessionId,
    ...(presentPass && actor.pass && actor.passKey === tab.user.userId
      ? { roomRecoveryPass: actor.pass }
      : {}),
  };
  void Promise.resolve(handler(payload, ack)).catch((error: unknown) => {
    if (tab.generation === world.sfu.generation) {
      world.failures.push(`${actor.name}'s join threw: ${String(error)}`);
    }
  });
};

const joinNow = (world: World, actor: Actor): void => {
  startJoin(world, actor, liveTab(world, actor) ?? openTab(world, actor), true);
};

const hostAct = async (
  world: World,
  by: Actor,
  event: string,
  payload: unknown,
): Promise<{ success?: boolean; error?: string } | undefined> => {
  const tab = liveTab(world, by);
  const handler = tab?.peer.handlers.get(event);
  if (!handler) return undefined;
  let answer: { success?: boolean; error?: string } | undefined;
  await handler(payload, (response: { success?: boolean; error?: string }) => {
    answer = response;
  });
  return answer;
};

const keepNewestPasses = (world: World): void => {
  for (const actor of Object.values(world.actors)) {
    for (const tab of liveTabsOf(world, actor)) {
      for (const { event, payload } of tab.peer.events) {
        if (event !== "roomRecoveryPass") continue;
        actor.pass = (payload as { roomRecoveryPass: string }).roomRecoveryPass;
        actor.passKey = tab.user.userId ?? null;
      }
    }
  }
};

const followApprovals = async (world: World): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    let asked = false;
    for (const actor of Object.values(world.actors)) {
      for (const tab of liveTabsOf(world, actor)) {
        if (approvalsOf(tab) <= tab.approvalsSeen) continue;
        if (!world.follows()) {
          tab.approvalsSeen = approvalsOf(tab);
          continue;
        }
        world.trace.push(`  ${actor.name}'s tab asks again after being let in`);
        startJoin(world, actor, tab, true);
        asked = true;
      }
    }
    if (!asked) return;
    await settle();
  }
};

const describeStep = (step: Step): string => {
  switch (step.kind) {
    case "open":
      return `${step.actor} ${step.reload ? "reloads their tab" : "opens a tab"} and joins${step.claim ? " claiming the host's seat" : ""}${step.pass ? " with a pass" : ""}${step.hold ? ", the room opening is held" : ""}`;
    case "again":
      return `${step.actor} asks again on the same tab${step.pass ? " with a pass" : ""}`;
    case "second":
      return step.action === "open"
        ? `${step.actor} opens a second tab and joins${step.claim ? " claiming the host's seat" : ""}${step.dropsWhileJoining ? ", and it drops while the join finishes" : ""}`
        : `${step.actor} closes their second tab`;
    case "leave":
      return `${step.actor} closes the tab`;
    case "drop":
      return `${step.actor}'s network drops`;
    case "together":
      return `${step.actors[0]} and ${step.actors[1]} join at the same moment`;
    case "hold":
      return "the next room opening is held";
    case "release":
      return step.alongside
        ? `held room openings finish as ${step.alongside} joins`
        : "held room openings finish";
    case "host":
      return step.action === "lock" || step.action === "unlock"
        ? `${step.by} ${step.action}s the room`
        : `${step.by} ${step.action}s ${step.target}`;
    case "expect":
      return `  (expect ${step.actor}'s ${step.tab} tab to be ${step.role === "out" ? "out of the meeting" : `a ${step.role}`})`;
    case "attend":
      return {
        none: "someone opens the webinar link",
        wrong: "someone opens the webinar link with a wrong invite code",
        right: "someone opens the webinar link with its invite code",
      }[step.code];
    case "switch":
      return `${step.actor}'s tab switches to the other meeting${
        step.overtaken === "disconnect"
          ? ", and the tab drops while it leaves"
          : step.overtaken === "newer"
            ? ", and the tab asks again while it leaves"
            : ""
      }`;
    case "end":
      return `${step.by} ends the meeting for everyone`;
    case "restart":
      return step.elsewhere
        ? "the call moves to an SFU that has no record of it"
        : "the SFU restarts";
    case "shutdown":
      return {
        drain: "the SFU is force drained",
        stop: "the SFU is stopped (SIGTERM)",
        worker: "the room's media worker dies",
        handoff: "another SFU takes the room over",
      }[step.how] +
        (step.how === "drain" ? ` with ${(step.noticeMs ?? DRAIN_NOTICE_MS) / SECOND_MS} s notice` : "") +
        (step.leaver ? `, and ${step.leaver} leaves during the notice` : "");
    case "tick":
      return `${step.ms / SECOND_MS} s pass`;
    case "untilDeadline":
      return `time runs to ${step.beforeMs / SECOND_MS} s before the room's next deadline`;
  }
};

const callOver = (world: World, why: string): void => {
  world.trace.push(`  (the call is over: ${why})`);
  world.shadow.phase = { kind: "none" };
  world.shadow.removed.clear();
  world.shadow.ejected.clear();
  world.shadow.members.clear();
  world.shadow.cohosts.clear();
  world.claimed.clear();
};

const oldAppLinkedToDana = (room: Room | undefined): boolean =>
  Boolean(
    room
      ?.identitiesOfSameGuest(OLD_DANA_KEY, "removal")
      .some((key) => key.startsWith(DANA_KEY_PREFIX)),
  );

const removalKeyIn = (room: Room | undefined, actor: Actor): string =>
  actor.name === "olddana" && !oldAppLinkedToDana(room) ? actor.key : actor.removalKey;

const removalPersonIn = (room: Room | undefined, key: string): string =>
  key === OLD_DANA_KEY && !oldAppLinkedToDana(room) ? key : removalPersonOf(key);

const removalReachOf = (room: Room, target: Actor): string => removalKeyIn(room, target);

const rightsPeopleWithin = (world: World, room: Room, reach: string): string[] =>
  Object.values(world.actors)
    .filter((actor) => actor.key === reach || removalKeyIn(room, actor) === reach)
    .map((actor) => actor.key);

const removes = (world: World, target: Actor, known: boolean, reach: string): void => {
  if (world.shadow.phase.kind !== "running" || !known) return;
  if (ownsCode(target, liveRoom(world)?.ownerEmail)) return;
  world.shadow.removed.add(reach);
};

const performHostAction = async (
  world: World,
  step: Extract<Step, { kind: "host" }>,
): Promise<void> => {
  const by = world.actors[step.by];
  const target = world.actors[step.target];
  const room = liveRoom(world);
  if (!room) return;
  const ownSeat = by === target ? (liveTab(world, by)?.context.currentClient?.id ?? null) : null;
  const seat = seatOf(room, target.key, ownSeat);
  const targetKey = keyOf(world, target, room);
  const waitingKey = pendingKeyOf(room, target.key) ?? targetKey;
  const known = target.name !== "dana" || room.guestProofOf(targetKey) !== undefined;
  const reach = removalReachOf(room, target);
  const reachedPeople = rightsPeopleWithin(world, room, reach);
  const reached = Object.values(world.actors).filter(
    (actor) => actor === target || (known && removalKeyIn(room, actor) === reach),
  );
  const seatedTabs = reached.flatMap((actor) => [actor.tab, actor.second]).filter(
    (tab): tab is Tab =>
      tab !== null &&
      tab.generation === world.sfu.generation &&
      tab.context.currentRoom === room &&
      room.clients.has(tab.context.currentClient?.id ?? ""),
  );
  const answer = await (async () => {
    switch (step.action) {
      case "admit":
        return hostAct(world, by, "admitUser", { userId: waitingKey });
      case "reject":
        return hostAct(world, by, "rejectUser", { userId: waitingKey });
      case "kick":
        return seat ? hostAct(world, by, "kickUser", { userId: seat }) : undefined;
      case "promote":
        return seat ? hostAct(world, by, "promoteHost", { userId: seat }) : undefined;
      case "transfer":
        return seat ? hostAct(world, by, "admin:transferHost", { userId: seat }) : undefined;
      case "block":
        return hostAct(world, by, "admin:blockUsers", { userKeys: [targetKey], kickPresent: true });
      case "blockStay":
        return hostAct(world, by, "admin:blockUsers", { userKeys: [targetKey], kickPresent: false });
      case "revoke":
        return hostAct(world, by, "admin:revokeAllowedUsers", { userKeys: [targetKey] });
      case "allow":
        return hostAct(world, by, "admin:allowUsers", { userKeys: [targetKey] });
      case "lock":
      case "unlock":
        return hostAct(world, by, "lockRoom", { locked: step.action === "lock" });
    }
  })();
  if (!answer?.success) {
    world.trace.push(`  (refused: ${answer?.error ?? "no answer"})`);
    return;
  }
  if (step.action === "kick" && by === target) {
    world.failures.push(`${by.name} removed themselves from another of their tabs`);
  }
  if (step.action === "kick" || step.action === "block") {
    for (const tab of seatedTabs) {
      if (!tab.peer.events.some(({ event }) => event === "kicked")) {
        world.failures.push(`${tab.peer.socket.id} was not told ${target.name} was removed`);
      }
    }
    if (world.shadow.phase.kind === "running" && known && !ownsCode(target, room.ownerEmail)) {
      world.shadow.ejected.add(reach);
    }
  }
  if (step.action === "admit" || step.action === "allow") {
    for (const lifted of [reach, target.key, ...reachedPeople]) {
      world.shadow.removed.delete(lifted);
      world.shadow.ejected.delete(lifted);
    }
  }
  const removal = ["kick", "block", "blockStay", "revoke"].includes(step.action);
  if (removal) removes(world, target, known, reach);
  if (removal && step.action !== "revoke") {
    for (const person of reachedPeople) {
      world.shadow.cohosts.delete(person);
      world.claimed.delete(person);
    }
  }
  if (
    (step.action === "promote" || step.action === "transfer") &&
    world.shadow.phase.kind === "running" &&
    !ownsCode(target, room.ownerEmail)
  ) {
    world.shadow.cohosts.add(target.key);
  }
};

const seatedHostKeys = (room: Room): Set<string> => {
  const keys = new Set<string>();
  for (const [userId, client] of room.clients) {
    const key = room.userKeysById.get(userId);
    if (key && client instanceof Admin && !client.isObserver) keys.add(key);
  }
  return keys;
};

type CallSnapshot = { hosts: Set<string>; members: Set<string>; removals: Set<string> };

const snapshotCall = (world: World): CallSnapshot => {
  const room = world.sfu.state.rooms.get(CHANNEL);
  return {
    hosts: hostKeys(room),
    members: new Set([...world.shadow.members, ...seatedKeys(room)]),
    removals: new Set(world.shadow.removed),
  };
};

const switchProcess = async (world: World): Promise<void> => {
  world.sfu.stopRefresh();
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
  world.held = [];
  world.holdNext = false;
  world.sfu = await boot(world);
};

const callIsLost = async (world: World, snapshot: CallSnapshot, cause: string): Promise<void> => {
  const phase = world.shadow.phase;
  if (phase.kind !== "running") return;
  const recalled = await world.sfu.state.roomRecovery.recall(CHANNEL);
  if (!recalled.lost) {
    world.failures.push(`${cause} ended a running call: the server kept no record of it`);
    return;
  }
  const kept = new Set(
    [
      ...recalled.lost.adminUserKeys,
      ...(recalled.lost.hostUserKey ? [recalled.lost.hostUserKey] : []),
    ].map(personOf),
  );
  for (const key of snapshot.hosts) {
    if (!kept.has(key)) world.failures.push(`${cause} cleared the call's host ${key}`);
  }
  for (const key of kept) {
    if (!snapshot.hosts.has(key)) world.failures.push(`${cause} made ${key} a host of the call`);
  }
  for (const key of snapshot.removals) {
    if (
      !recalled.lost.readmissionRequiredUserKeys.some(
        (removed) => personOf(removed) === key || removalPersonOf(removed) === key,
      )
    ) {
      world.failures.push(`${cause} cleared the removal of ${key}`);
    }
  }
  if (recalled.passesVoidUntil !== null && recalled.passesVoidUntil >= phase.since) {
    world.failures.push(`${cause} voided the call's recovery passes`);
  }
  world.shadow.phase = {
    kind: "lost",
    callSince: phase.since,
    since: Date.now(),
    until: recalled.lost.claimableUntil,
    hosts: snapshot.hosts,
    members: snapshot.members,
    removals: snapshot.removals,
  };
};

const restart = async (world: World): Promise<void> => {
  const snapshot = snapshotCall(world);
  await switchProcess(world);
  await callIsLost(world, snapshot, "the restart");
};

const restartElsewhere = async (world: World): Promise<void> => {
  world.durable.recovery = createMemoryRoomRecoveryStore();
  await switchProcess(world);
  callOver(world, "an SFU with no record of it took over, so only passes carry over");
};

const DRAIN_NOTICE_MS = 2_000;

const SHUTDOWNS = {
  drain: (sfu: Sfu, noticeMs: number) =>
    forceDrainRooms(sfu.state, sfu.io, { message: "Restarting", noticeMs }),
  stop: (sfu: Sfu) => {
    handOffRooms(sfu.state);
    for (const peer of [...sfu.peers]) closePeer(sfu, peer, "server shutting down");
  },
  worker: (sfu: Sfu) =>
    cleanupDeadWorkerRooms(sfu.state, sfu.io, sfu.state.workers[0], "model-worker"),
  handoff: async (sfu: Sfu) => {
    const registry = sfu.state.roomRegistry;
    const moved = vi.spyOn(registry, "renewRoom").mockImplementation(async (room) => ({
      ok: false as const,
      owner: {
        ...room,
        instanceId: "model-other-sfu",
        updatedAt: Date.now(),
        expiresAt: Date.now() + 45_000,
      },
    }));
    try {
      await renewRoomOwnerships(sfu.state);
    } finally {
      moved.mockRestore();
    }
  },
};

const shutDown = async (world: World, step: Extract<Step, { kind: "shutdown" }>): Promise<void> => {
  const snapshot = snapshotCall(world);
  const sfu = world.sfu;
  const cause = describeStep(step);
  switch (step.how) {
    case "drain": {
      const noticeMs = step.noticeMs ?? DRAIN_NOTICE_MS;
      const drained = SHUTDOWNS.drain(sfu, noticeMs);
      await settle();
      const leaver = step.leaver ? liveTab(world, world.actors[step.leaver]) : null;
      if (leaver) closePeer(sfu, leaver.peer, "client namespace disconnect");
      await vi.advanceTimersByTimeAsync(noticeMs);
      await drained;
      await settle();
      await switchProcess(world);
      break;
    }
    case "stop":
      SHUTDOWNS.stop(sfu);
      await settle();
      await switchProcess(world);
      break;
    case "worker": {
      const cleaned = SHUTDOWNS.worker(sfu);
      await vi.advanceTimersByTimeAsync(1_500);
      await cleaned;
      break;
    }
    case "handoff":
      await SHUTDOWNS.handoff(sfu);
      break;
  }
  await settle();
  await callIsLost(world, snapshot, cause);
};

const roomsOf = (world: World): Room[] => [...world.sfu.state.rooms.values()];

type Roles = Map<Room, Map<string, boolean>>;

const rolesOf = (world: World): Roles => {
  const roles: Roles = new Map();
  for (const room of roomsOf(world)) {
    const seats = new Map<string, boolean>();
    for (const [seatId, client] of room.clients) {
      if (client.isObserver || client.isWebinarAttendee) continue;
      seats.set(seatId, client instanceof Admin);
    }
    roles.set(room, seats);
  }
  return roles;
};

const latestTold = (
  tab: Tab,
  event: string,
  roomId: string,
): { index: number; payload: Record<string, unknown> } | null => {
  for (let index = tab.peer.events.length - 1; index >= tab.toldSince; index -= 1) {
    const entry = tab.peer.events[index];
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (entry.event === event && payload?.roomId === roomId) return { index, payload };
  }
  return null;
};

const perform = async (world: World, step: Step): Promise<void> => {
  world.trace.push(describeStep(step));
  const before = liveRoom(world);
  const beforeIncarnation = before?.incarnationId ?? null;
  const beforeHosts = hostKeys(before);
  const beforeSeated = new Set(before?.clients.keys() ?? []);
  const beforeLiveHosts = new Set([...(before ? seatedHostKeys(before) : [])].map(personOf));
  const beforeRoles = rolesOf(world);
  const beforeMembership = new Map(world.sfu.membership);
  world.sfu.ranThisStep.clear();
  const beforeGeneration = world.generation;
  switch (step.kind) {
    case "second": {
      const actor = world.actors[step.actor];
      if (step.action === "open") {
        const tab = openTab(world, actor, "second", false, step.claim ?? false);
        tab.peer.holdJoin = step.dropsWhileJoining ?? false;
        startJoin(world, actor, tab, true);
        if (step.dropsWhileJoining) {
          await settle();
          closePeer(world.sfu, tab.peer, "transport close");
          tab.peer.holdJoin = false;
          for (const resume of world.sfu.heldJoins.splice(0)) resume();
        }
      } else {
        const tab = liveSecondTab(world, actor);
        if (!tab) throw new Error(`${actor.name} has no second tab`);
        closePeer(world.sfu, tab.peer, "client namespace disconnect");
      }
      break;
    }
    case "open": {
      const actor = world.actors[step.actor];
      if (step.hold) world.holdNext = true;
      startJoin(
        world,
        actor,
        openTab(world, actor, "main", step.reload ?? false, step.claim ?? false),
        step.pass,
      );
      break;
    }
    case "again": {
      const actor = world.actors[step.actor];
      const tab = liveTab(world, actor);
      if (!tab) throw new Error(`${actor.name} has no open tab to ask again on`);
      startJoin(world, actor, tab, step.pass);
      break;
    }
    case "leave":
    case "drop": {
      const tab = liveTab(world, world.actors[step.actor]);
      if (!tab) throw new Error(`${step.actor} has no open tab`);
      closePeer(world.sfu, tab.peer, step.kind === "leave" ? "client namespace disconnect" : "transport close");
      break;
    }
    case "together":
      for (const name of step.actors) joinNow(world, world.actors[name]);
      break;
    case "hold":
      world.holdNext = true;
      break;
    case "release":
      for (const resume of world.held.splice(0)) resume();
      if (step.alongside) joinNow(world, world.actors[step.alongside]);
      break;
    case "host":
      await performHostAction(world, step);
      break;
    case "end": {
      const answer = await hostAct(world, world.actors[step.by], "admin:endRoom", {});
      if (answer?.success) callOver(world, "a host ended it for everyone");
      break;
    }
    case "restart":
      if (step.elsewhere) await restartElsewhere(world);
      else await restart(world);
      break;
    case "shutdown":
      await shutDown(world, step);
      break;
    case "tick":
      await vi.advanceTimersByTimeAsync(step.ms);
      break;
    case "attend":
      attend(world, step.code);
      break;
    case "expect": {
      const actor = world.actors[step.actor];
      const tab = step.tab === "main" ? liveTab(world, actor) : liveSecondTab(world, actor);
      const room = liveRoom(world);
      const client = tab?.context.currentClient;
      const seated = Boolean(room && tab?.context.currentRoom === room && client && room.getClient(client.id) === client);
      const role = !seated ? "out" : client instanceof Admin ? "host" : "participant";
      if (role !== step.role) {
        world.failures.push(`${actor.name}'s ${step.tab} tab is ${role === "out" ? "out of the meeting" : `a ${role}`}, not ${step.role === "out" ? "out" : `a ${step.role}`}`);
      }
      break;
    }
    case "switch": {
      const actor = world.actors[step.actor];
      const tab = liveTab(world, actor);
      if (!tab) throw new Error(`${actor.name} has no open tab to switch`);
      const inOther = tab.context.currentRoom?.channelId === OTHER_CHANNEL;
      const from = inOther ? OTHER_CODE : CODE;
      tab.peer.holdLeave = step.overtaken !== null;
      startJoin(world, actor, tab, false, inOther ? CODE : OTHER_CODE);
      await settle();
      if (step.overtaken === "disconnect") closePeer(world.sfu, tab.peer, "transport close");
      if (step.overtaken === "newer") startJoin(world, actor, tab, true, from);
      await settle();
      tab.peer.holdLeave = false;
      for (const resume of world.sfu.heldLeaves.splice(0)) resume();
      break;
    }
    case "untilDeadline": {
      const now = Date.now();
      const deadlines = roomDeadlines(world).filter((deadline) => deadline - step.beforeMs > now);
      const target = deadlines.length > 0 ? Math.min(...deadlines) - step.beforeMs : now + SECOND_MS;
      await vi.advanceTimersByTimeAsync(target - now);
      break;
    }
  }
  await settle();
  await followApprovals(world);
  await settle();
  keepNewestPasses(world);
  await check(world, {
    beforeIncarnation,
    beforeHosts,
    beforeSeated,
    beforeLiveHosts,
    beforeRoles: world.generation === beforeGeneration ? beforeRoles : (new Map() as Roles),
    beforeMembership,
  });
};

const creditClaims = (world: World): void => {
  const room = liveRoom(world);
  if (!world.hostClaims || !room || room.hasEnded || room.isHandingOff) return;
  for (const actor of Object.values(world.actors)) {
    const claimTabs = [actor.tab, actor.second].filter((tab) => tab?.user.isHost === true);
    if (claimTabs.length === 0 || ownsCode(actor, room.ownerEmail)) continue;
    if (room.hostReasonOf(keyOf(world, actor, room)) !== "cohost") continue;
    world.shadow.cohosts.add(actor.key);
    world.claimed.add(actor.key);
  }
};

const observeRoom = (sfu: Sfu, room: Room): void => {
  if (sfu.membership.has(room)) return;
  sfu.membership.set(room, 0);
  room.onLifecycle((event) => {
    if (event !== "membership") return;
    sfu.membership.set(room, (sfu.membership.get(room) ?? 0) + 1);
    if (room.recordsItsCall && room.hasActiveAdmin()) {
      sfu.ranThisStep.set(room.incarnationId, room.channelId);
    }
  });
};

const checkRooms = (
  world: World,
  now: number,
  before: { beforeRoles: Roles; beforeMembership: Map<Room, number> },
  fail: (message: string) => void,
): void => {
  for (const room of roomsOf(world)) {
    if (!world.firstSeen.has(room.incarnationId)) world.firstSeen.set(room.incarnationId, now);
    observeRoom(world.sfu, room);
    if (room.hasEnded || room.isHandingOff) continue;
    const label =
      room.channelId === CHANNEL
        ? "the meeting"
        : room.channelId === OTHER_CHANNEL
          ? "the other meeting"
          : "the webinar's room";
    const openedAt = world.firstSeen.get(room.incarnationId) ?? now;

    if (
      room.clients.size === 0 &&
      room.pendingClients.size === 0 &&
      now - openedAt > ROOM_OPEN_DEADLINE_MS + SECOND_MS
    ) {
      fail(`${label} has stayed open with nobody in it for ${Math.round((now - openedAt) / SECOND_MS)} s`);
    }

    const inMeeting = room.clients.size - room.getWebinarAttendeeCount();
    if ((inMeeting > 0 || room.pendingClients.size > 0) && !room.hasActiveAdmin()) {
      const opening =
        room.awaitingOpener !== null && room.openingDeadline !== null && now <= room.openingDeadline;
      const recovering = room.restorerState(now) === "awaited";
      const waitingForHost = room.cleanupDeadline !== null && now <= room.cleanupDeadline;
      if (!opening && !recovering && !waitingForHost) {
        fail(
          `${label} has nobody to host it and no deadline that will give it a host (${room.clients.size} in it, ${room.pendingClients.size} waiting; opening ${room.awaitingOpener ? "unclaimed" : "claimed"}, open deadline ${room.openingDeadline === null ? "none" : `in ${room.openingDeadline - now} ms`}, lost call ${room.restorerState(now)})`,
        );
      }
    }

    const running = room.awaitingOpener === null && room.restorerState(now) === "none";
    if (running && !room.hasActiveAdmin()) {
      for (const [seatId, client] of room.clients) {
        const key = room.userKeysById.get(seatId);
        if (!key || client.isObserver || client.isWebinarAttendee) continue;
        const proof = room.guestProofOf(key);
        if (!room.needsReadmission(key, proof) && !room.isBlocked(key, proof)) {
          fail(`${key} could host ${label}, which has no host, and nobody made them host`);
          break;
        }
      }
    }

    for (const [seatId, client] of room.clients) {
      if (!(client instanceof Admin) || client.isObserver || !client.socket.connected) continue;
      const seatContext = getSocketContext(client.socket);
      if (
        !seatContext?.adminHandlersRegistered ||
        seatContext.currentClient !== client ||
        seatContext.currentRoom !== room
      ) {
        fail(`${seatId} hosts ${label} but its tab cannot act as a host`);
      }
    }

    const roles = new Map<string, Set<boolean>>();
    for (const [seatId, client] of room.clients) {
      const key = room.userKeysById.get(seatId);
      if (!key || client.isObserver || client.isWebinarAttendee) continue;
      const person = personOf(key);
      const seen = roles.get(person) ?? new Set<boolean>();
      seen.add(client instanceof Admin);
      roles.set(person, seen);
    }
    for (const [key, seen] of roles) {
      if (seen.size > 1) fail(`${key}'s tabs do not all have the same role`);
    }

    const admins = [...room.getAdminUserIds()].sort().join(", ");
    const host = room.getHostUserId();
    for (const actor of Object.values(world.actors)) {
      for (const tab of liveTabsOf(world, actor)) {
        const client = tab.context.currentClient;
        if (tab.context.currentRoom !== room || !client || room.getClient(client.id) !== client) continue;
        if (client.isObserver || client.isWebinarAttendee) continue;
        const roster = latestTold(tab, "adminUsersChanged", room.id);
        const toldHosts = roster
          ? [...((roster.payload.hostUserIds as string[] | undefined) ?? [])].sort().join(", ")
          : "";
        if (toldHosts !== admins) {
          fail(`${actor.name}'s tab in ${label} was last told the hosts are [${toldHosts}], not [${admins}]`);
        }
        const toldMain = latestTold(tab, "hostChanged", room.id)?.payload.hostUserId ?? null;
        if (toldMain !== host) {
          fail(`${actor.name}'s tab in ${label} was last told the main host is ${String(toldMain)}, not ${String(host)}`);
        }
        const assigned = latestTold(tab, "hostAssigned", room.id)?.index ?? -1;
        const removed = latestTold(tab, "hostRemoved", room.id)?.index ?? -1;
        if (client instanceof Admin !== assigned > removed) {
          fail(
            `${actor.name}'s tab in ${label} is ${client instanceof Admin ? "a host" : "a participant"}, but was last told otherwise`,
          );
        }
      }
    }

    const rolesBefore = before.beforeRoles.get(room);
    if (rolesBefore) {
      let changed = false;
      for (const [seatId, client] of room.clients) {
        if (client.isObserver || client.isWebinarAttendee) continue;
        const was = rolesBefore.get(seatId);
        if (was !== undefined && was !== client instanceof Admin) changed = true;
      }
      const told = (world.sfu.membership.get(room) ?? 0) > (before.beforeMembership.get(room) ?? 0);
      if (changed && !told) fail(`a seat in ${label} changed role and the room's apps were not told`);
    }
  }
};

const check = async (
  world: World,
  before: {
    beforeIncarnation: string | null;
    beforeHosts: Set<string>;
    beforeSeated: Set<string>;
    beforeLiveHosts: Set<string>;
    beforeRoles: Roles;
    beforeMembership: Map<Room, number>;
  },
): Promise<void> => {
  const now = Date.now();
  const shadow = world.shadow;
  const fail = (message: string) => world.failures.push(message);
  const opened = liveRoom(world);
  const earlier = shadow.phase;
  if (earlier.kind === "lost" && now >= earlier.until) {
    callOver(world, "the lost call's time ran out");
  }
  if (earlier.kind === "running" && opened?.incarnationId !== earlier.incarnation) {
    callOver(world, "the room it ran in closed");
  }
  creditClaims(world);
  for (const done of world.completions.splice(0)) {
    if (done.channelId !== CHANNEL || done.response.status !== "joined") continue;
    const { actor } = done;
    const owner = ownsCode(actor, done.ownerEmail);
    const sameRoom = done.incarnation !== null && done.incarnation === before.beforeIncarnation;
    const sameSeat = sameRoom && done.seatId !== null && before.beforeSeated.has(done.seatId);
    const presentHost = sameRoom && before.beforeLiveHosts.has(actor.key);
    const removed =
      shadow.removed.has(removalKeyIn(liveRoom(world), actor)) || shadow.removed.has(actor.key);
    if (removed && !owner && !sameSeat && !presentHost) {
      fail(`${actor.name} was removed and got back in without a host letting them in`);
    }
    if (!done.admin || done.incarnation === null) continue;
    const phase = shadow.phase;
    const lostHost = phase.kind === "lost" && phase.hosts.has(actor.key);
    const fallback =
      sameRoom && before.beforeLiveHosts.size === 0 && phase.kind === "running";
    const claimed = world.claimed.has(actor.key);
    const justified =
      owner || (sameRoom && before.beforeHosts.has(actor.key)) || lostHost || fallback || claimed;
    if (!justified) {
      const openers = world.openers.get(done.incarnation) ?? new Set<string>();
      openers.add(actor.key);
      world.openers.set(done.incarnation, openers);
      if (openers.size > 1) {
        fail(`more than one person opened the same room as its host: ${[...openers].join(", ")}`);
      }
    }
  }

  const ranHere = [...world.sfu.ranThisStep].find(([, channelId]) => channelId === CHANNEL);
  if (shadow.phase.kind === "lost" && ranHere) {
    const lost = shadow.phase;
    world.trace.push("  (the lost call came back)");
    shadow.phase = { kind: "running", incarnation: ranHere[0], since: lost.callSince };
    if (liveRoom(world)?.incarnationId !== ranHere[0]) {
      callOver(world, "it came back and the room it ran in closed");
    }
  }
  const room = liveRoom(world);
  checkRooms(world, now, before, fail);

  if (shadow.phase.kind === "lost") {
    const lost = shadow.phase;
    if (now < lost.until && room) {
      for (const key of [...seatedKeys(room)]) {
        const seat = seatOf(room, key);
        const client = seat ? room.clients.get(seat) : undefined;
        if (!(client instanceof Admin)) continue;
        const allowed =
          lost.hosts.has(key) ||
          (lost.members.has(key) &&
            !shadow.removed.has(key) &&
            !shadow.removed.has(removalPersonIn(room, key))) ||
          world.claimed.has(key) ||
          room.ownerEmail === key;
        if (!allowed) fail(`${key} hosts a call the server lost without having been in it`);
      }
    }
    if (room?.hasActiveAdmin()) {
      world.trace.push("  (the lost call is back)");
      shadow.phase = { kind: "running", incarnation: room.incarnationId, since: lost.callSince };
    }
  }
  if (shadow.phase.kind === "none" && room?.hasActiveAdmin() && !room.hasEnded) {
    shadow.phase = { kind: "running", incarnation: room.incarnationId, since: now };
  }
  if (shadow.phase.kind === "running") {
    for (const key of seatedKeys(room)) shadow.members.add(key);
  }

  if (shadow.phase.kind === "lost" && now < shadow.phase.until) {
    const lost = shadow.phase;
    const recalled = await world.sfu.state.roomRecovery.recall(CHANNEL);
    if (!recalled.lost) {
      fail("a call the server lost was forgotten inside its recovery window");
    } else {
      const kept = new Set(
        [
          ...recalled.lost.adminUserKeys,
          ...(recalled.lost.hostUserKey ? [recalled.lost.hostUserKey] : []),
        ].map(personOf),
      );
      for (const key of lost.hosts) {
        if (!kept.has(key)) fail(`the lost call forgot its host ${key} inside its recovery window`);
      }
      for (const key of lost.removals) {
        if (
          !recalled.lost.readmissionRequiredUserKeys.some(
            (removed) => personOf(removed) === key || removalPersonOf(removed) === key,
          )
        ) {
          fail(`the lost call forgot that ${key} was removed inside its recovery window`);
        }
      }
    }
    if (recalled.passesVoidUntil !== null && recalled.passesVoidUntil >= lost.callSince) {
      fail("passes from a call the server lost were voided inside its recovery window");
    }
  }

  if (room && !room.hasEnded && room.ownerEmail && seatedHostKeys(room).has(room.ownerEmail)) {
    for (const key of room.adminUserKeys) {
      if (key === room.ownerEmail || shadow.cohosts.has(personOf(key))) continue;
      fail(`${key} still hosts with the code's owner here, and no host made them a co-host`);
    }
  }

  if (room && !room.hasEnded) {
    for (const key of seatedKeys(room)) {
      if (shadow.ejected.has(key) || shadow.ejected.has(removalPersonIn(room, key))) {
        fail(`${key} still holds a seat after a host removed them`);
      }
    }
  }

  if (room && !room.hasEnded) {
    const priorHosts =
      room.incarnationId === before.beforeIncarnation ? before.beforeHosts : new Set<string>();
    for (const key of seatedHostKeys(room)) {
      if (priorHosts.has(personOf(key))) continue;
      const reason = room.hostReasonOf(key);
      if (reason !== "temporary" && reason !== "opener") continue;
      const proof = room.guestProofOf(key);
      if (
        room.needsReadmission(key, proof) ||
        room.isBlocked(key, proof) ||
        shadow.removed.has(personOf(key)) ||
        shadow.removed.has(removalPersonIn(room, key))
      ) {
        fail(`${key} was handed a host's seat as a fallback although a host removed them`);
      }
    }
  }

  if (room && !room.hasEnded) {
    const recordedHosts = hostKeys(room);
    for (const key of seatedHostKeys(room)) {
      if (!recordedHosts.has(personOf(key))) fail(`${key} has a host's seat with no recorded reason`);
    }
    const reasonsOfPerson = new Map<string, Set<string>>();
    for (const [key, reason] of room.hostReasons) {
      const reasons = reasonsOfPerson.get(personOf(key)) ?? new Set<string>();
      reasons.add(reason);
      reasonsOfPerson.set(personOf(key), reasons);
    }
    for (const [person, reasons] of reasonsOfPerson) {
      if (reasons.size > 1) fail(`${person} hosts for more than one reason at once: ${[...reasons].join(", ")}`);
    }
    for (const key of room.adminUserKeys) {
      const expected =
        key === room.ownerEmail
          ? "owner"
          : shadow.cohosts.has(personOf(key))
            ? "cohost"
            : room.ownerEmail
              ? "temporary"
              : "opener";
      const recorded = room.hostReasonOf(key);
      if (recorded !== expected) {
        fail(`${key} hosts as ${recorded ?? "nobody"}, where the model says ${expected}`);
      }
    }
  }

  for (const message of loggedErrors.splice(0)) fail(`the SFU logged an error: ${message}`);
};

const pick = <T>(random: () => number, options: Array<[number, () => T]>): T => {
  const total = options.reduce((sum, [weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [weight, make] of options) {
    roll -= weight;
    if (roll < 0) return make();
  }
  return options[options.length - 1][1]();
};

const roomDeadlines = (world: World): number[] => {
  const room = liveRoom(world);
  if (!room) return [];
  const now = Date.now();
  const openedAt = world.firstSeen.get(room.incarnationId);
  return [
    room.cleanupDeadline,
    room.restorerState(now) === "awaited" ? room.restorerDeadline : null,
    room.awaitingOpener && openedAt !== undefined ? openedAt + ROOM_OPEN_DEADLINE_MS : null,
  ].filter((deadline): deadline is number => deadline !== null && deadline > now);
};

const pastNextDeadline = (world: World): number | null => {
  const deadlines = roomDeadlines(world);
  return deadlines.length > 0 ? Math.min(...deadlines) - Date.now() + SECOND_MS : null;
};

const nextStep = (world: World): Step => {
  const random = world.random;
  const room = liveRoom(world);
  const options: Array<[number, () => Step]> = [];
  for (const actor of Object.values(world.actors)) {
    const name = actor.name;
    if (!liveTab(world, actor)) {
      options.push([
        3,
        () => ({
          kind: "open",
          actor: name,
          pass: random() < 0.7,
          hold: random() < 0.2,
          reload: random() < 0.4,
          claim: world.hostClaims && random() < 0.25,
        }),
      ]);
      continue;
    }
    options.push([1.5, () => ({ kind: "again", actor: name, pass: random() < 0.7 })]);
    options.push([
      0.6,
      () =>
        liveSecondTab(world, actor)
          ? { kind: "second", actor: name, action: "leave" }
          : {
              kind: "second",
              actor: name,
              action: "open",
              claim: world.hostClaims && random() < 0.3,
              dropsWhileJoining: random() < 0.25,
            },
    ]);
    options.push([1.2, () => ({ kind: "leave", actor: name })]);
    options.push([0.4, () => ({ kind: "drop", actor: name })]);
    if (name !== "dana") {
      options.push([
        0.5,
        () => ({
          kind: "switch",
          actor: name,
          overtaken: random() < 0.6 ? null : random() < 0.5 ? "disconnect" : "newer",
        }),
      ]);
    }
    if (!room || !hostsLiveRoom(world, actor)) continue;
    options.push([0.25, () => ({ kind: "end", by: name })]);
    options.push([
      0.3,
      () => ({ kind: "host", action: room.isLocked ? "unlock" : "lock", by: name, target: name }),
    ]);
    for (const other of Object.values(world.actors)) {
      if (other === actor) continue;
      const target = other.name;
      const host = (action: HostAction): Step => ({ kind: "host", action, by: name, target });
      if (pendingKeyOf(room, other.key)) {
        options.push([3, () => host("admit")]);
        options.push([0.8, () => host("reject")]);
      }
      if (seatOf(room, other.key)) {
        options.push([1.2, () => host("kick")]);
        options.push([1, () => host("promote")]);
        options.push([0.4, () => host("transfer")]);
        options.push([0.4, () => host("block")]);
      }
      if (seatOf(room, other.key)) options.push([0.3, () => host("blockStay")]);
      options.push([0.2, () => host("revoke")]);
      options.push([0.2, () => host("allow")]);
    }
    options.push([0.15, () => ({ kind: "host", action: "block", by: name, target: name })]);
    const ownSeat = liveTab(world, actor)?.context.currentClient?.id ?? null;
    if (seatOf(room, actor.key, ownSeat)) {
      options.push([0.4, () => ({ kind: "host", action: "kick", by: name, target: name })]);
    }
  }
  const anyone = () => ACTOR_NAMES[Math.floor(random() * ACTOR_NAMES.length)];
  if (world.held.length > 0) {
    options.push([2, () => ({ kind: "release", alongside: null })]);
    options.push([1, () => ({ kind: "release", alongside: anyone() })]);
  }
  options.push([
    0.8,
    () => {
      const first = anyone();
      const second = ACTOR_NAMES.filter((name) => name !== first)[
        Math.floor(random() * (ACTOR_NAMES.length - 1))
      ];
      return { kind: "together", actors: [first, second] };
    },
  ]);
  options.push([0.4, () => ({ kind: "hold" })]);
  if (world.webinar) {
    options.push([
      0.4,
      () => ({ kind: "attend", code: (["none", "wrong", "right"] as const)[Math.floor(random() * 3)] }),
    ]);
  }
  options.push([0.6, () => ({ kind: "restart" })]);
  options.push([0.2, () => ({ kind: "restart", elsewhere: true })]);
  for (const how of ["drain", "stop", "worker", "handoff"] as const) {
    options.push([
      0.2,
      () => ({
        kind: "shutdown",
        how,
        leaver: how === "drain" && random() < 0.5 ? anyone() : null,
        noticeMs: random() < 0.5 ? DRAIN_NOTICE_MS : 30_000,
      }),
    ]);
  }
  const outlasting = pastNextDeadline(world);
  if (outlasting !== null) {
    options.push([
      1.5,
      () => ({
        kind: "shutdown",
        how: "drain",
        leaver: random() < 0.3 ? anyone() : null,
        noticeMs: outlasting,
      }),
    ]);
  }
  options.push([1.5, () => ({ kind: "tick", ms: SECOND_MS })]);
  options.push([1.2, () => ({ kind: "tick", ms: ROOM_OPEN_DEADLINE_MS + SECOND_MS })]);
  options.push([0.6, () => ({ kind: "tick", ms: MINUTE_MS + SECOND_MS })]);
  options.push([0.5, () => ({ kind: "tick", ms: 8 * MINUTE_MS })]);
  options.push([
    0.6,
    () => ({ kind: "untilDeadline", beforeMs: [500, 5_000, 20_000][Math.floor(random() * 3)] }),
  ]);
  return pick(random, options);
};

type Outcome = { trace: string[]; failures: string[] };

const withModelClock = async (run: () => Promise<Outcome>): Promise<Outcome> => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(START);
  loggedErrors.length = 0;
  for (const log of quietLogs) log.mockClear();
  try {
    return await run();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
};

const withDisconnectGrace = async <T>(graceMs: number, run: () => Promise<T>): Promise<T> => {
  const before = config.socket.disconnectGraceMs;
  config.socket.disconnectGraceMs = graceMs;
  try {
    return await run();
  } finally {
    config.socket.disconnectGraceMs = before;
  }
};

const withHostClaims = async <T>(allowed: boolean, run: () => Promise<T>): Promise<T> => {
  const policy = config.clientPolicies.conclave;
  const before = policy.allowHostJoin;
  policy.allowHostJoin = allowed;
  try {
    return await run();
  } finally {
    policy.allowHostJoin = before;
  }
};

const runSequence = (seed: number): Promise<Outcome> =>
  withModelClock(async () => {
    const random = seeded(seed);
    const graceMs = GRACES_MS[Math.floor(random() * GRACES_MS.length)];
    const hostClaims = random() < 0.3;
    return withDisconnectGrace(graceMs, () =>
      withHostClaims(hostClaims, () => runSeeded(random, graceMs, hostClaims)),
    );
  });

const runSeeded = async (
  random: () => number,
  graceMs: number,
  hostClaims: boolean,
): Promise<Outcome> => {
  const world = await createWorld({
    random,
    follows: () => random() < 0.8,
    scheduled: random() < 0.5,
    webinar: random() < 0.3 ? (["code", "locked", "full"] as const)[Math.floor(random() * 3)] : null,
    hostClaims,
  });
  world.trace.push(`  (a dropped tab keeps its seat for ${graceMs / SECOND_MS} s)`);
  const prelude = random() < 0.25 ? leftWaitingForHost(random) : [];
  for (let index = 0; index < STEPS_PER_SEQUENCE && world.failures.length === 0; index += 1) {
    await vi.advanceTimersByTimeAsync(BETWEEN_STEPS_MS);
    await perform(world, prelude[index] ?? nextStep(world));
  }
  return { trace: world.trace, failures: world.failures };
};

type ScriptOptions = {
  tabsAskAgain?: boolean;
  webinar?: WebinarGate;
  graceMs?: number;
  hostClaims?: boolean;
};

const runScript = (scheduled: boolean, steps: Step[], options: ScriptOptions = {}): Promise<Outcome> =>
  withModelClock(() =>
    withDisconnectGrace(options.graceMs ?? config.socket.disconnectGraceMs, () =>
      withHostClaims(options.hostClaims ?? false, () => runScripted(scheduled, steps, options)),
    ),
  );

const runScripted = async (
  scheduled: boolean,
  steps: Step[],
  options: ScriptOptions,
): Promise<Outcome> => {
  const tabsAskAgain = options.tabsAskAgain ?? true;
  const world = await createWorld({
    random: seeded(0),
    follows: () => tabsAskAgain,
    scheduled,
    webinar: options.webinar ?? null,
    hostClaims: options.hostClaims ?? false,
  });
  for (const step of steps) {
    await vi.advanceTimersByTimeAsync(BETWEEN_STEPS_MS);
    await perform(world, step);
    if (world.failures.length > 0) break;
  }
  return { trace: world.trace, failures: world.failures };
};

const report = (outcome: Outcome): string =>
  [...outcome.trace, ...outcome.failures.map((failure) => `FAILED: ${failure}`)].join("\n");

const open = (actor: ActorName, options: { pass?: boolean; hold?: boolean } = {}): Step => ({
  kind: "open",
  actor,
  pass: options.pass ?? true,
  hold: options.hold ?? false,
});
const host = (by: ActorName, action: HostAction, target: ActorName): Step => ({
  kind: "host",
  action,
  by,
  target,
});

const leftWaitingForHost = (random: () => number): Step[] => {
  const opener = random() < 0.5 ? "alice" : "owner";
  const stayer = random() < 0.5 ? "bob" : "carol";
  return [
    open(opener),
    open(stayer),
    host(opener, "admit", stayer),
    host(opener, random() < 0.5 ? "revoke" : "blockStay", stayer),
    { kind: "leave", actor: opener },
  ];
};

describe("the room lifecycle model", () => {
  it("keeps the recovery of a lost call when the tab reopening it goes away before the room is claimed", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("invitee"),
      open("bob"),
      host("alice", "kick", "invitee"),
      { kind: "restart" },
      open("bob", { hold: true }),
      { kind: "leave", actor: "bob" },
      { kind: "release", alongside: null },
      { kind: "tick", ms: ROOM_OPEN_DEADLINE_MS + SECOND_MS },
      open("bob"),
      open("invitee"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps a removed temporary host out when the code's owner arrives", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "promote", "carol"),
      host("carol", "kick", "alice"),
      open("owner"),
      open("alice"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps a co-host whose admission a host took back from walking back in as host", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "promote", "carol"),
      host("alice", "revoke", "carol"),
      { kind: "leave", actor: "carol" },
      open("carol"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("gives a room nobody claimed in time to someone already in it", async () => {
    const outcome = await runScript(true, [
      open("owner", { hold: true }),
      { kind: "tick", ms: ROOM_OPEN_DEADLINE_MS + SECOND_MS },
      { kind: "release", alongside: null },
      open("invitee"),
      { kind: "expect", actor: "invitee", tab: "main", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("closes a room whose lost call ran out with nobody in it, even if a knocker's tab never asks again", async () => {
    const outcome = await runScript(
      true,
      [
        open("alice"),
        { kind: "restart" },
        open("bob"),
        { kind: "tick", ms: 8 * MINUTE_MS },
      ],
      { tabsAskAgain: false },
    );
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("lets whoever claims a room host it once the lost call it was opened for has run out", async () => {
    const outcome = await runScript(false, [
      open("bob"),
      { kind: "restart" },
      open("alice", { hold: true }),
      { kind: "leave", actor: "alice" },
      { kind: "tick", ms: 8 * MINUTE_MS },
      { kind: "release", alongside: null },
      open("alice"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("records what a host of the lost call does in a room another tab is still opening", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "promote", "carol"),
      open("invitee"),
      host("alice", "admit", "invitee"),
      { kind: "restart" },
      open("alice", { hold: true }),
      { kind: "leave", actor: "alice" },
      { kind: "release", alongside: null },
      open("carol"),
      open("invitee"),
      host("carol", "kick", "invitee"),
      { kind: "restart" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("takes host rights back from a member who took over a lost call when the code's owner arrives", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      { kind: "restart" },
      open("bob"),
      open("carol"),
      open("owner"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("takes host rights back from someone the lapse made host when the code's owner arrives", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      { kind: "restart" },
      open("bob"),
      open("invitee"),
      { kind: "tick", ms: 8 * MINUTE_MS },
      open("owner"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("takes host rights back from someone made host when the last host left once the code's owner arrives", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      { kind: "leave", actor: "alice" },
      open("owner"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps a co-host a host promoted when the code's owner arrives", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "promote", "carol"),
      open("bob"),
      host("alice", "admit", "bob"),
      host("alice", "promote", "bob"),
      { kind: "restart" },
      open("bob"),
      open("owner"),
      { kind: "expect", actor: "bob", tab: "main", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("drops a lost call's hosts once its window runs out before anyone claims the room", async () => {
    const outcome = await runScript(true, [
      open("owner"),
      open("invitee"),
      host("owner", "promote", "invitee"),
      { kind: "restart" },
      open("bob", { hold: true }),
      { kind: "tick", ms: 8 * MINUTE_MS },
      { kind: "release", alongside: null },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it.each(["drain", "stop", "worker", "handoff"] as const)(
    "keeps a call recoverable, with its hosts and removals, through a server-initiated %s",
    async (how) => {
      const outcome = await runScript(false, [
        open("alice"),
        open("carol"),
        host("alice", "admit", "carol"),
        open("invitee"),
        host("alice", "admit", "invitee"),
        host("alice", "kick", "invitee"),
        { kind: "shutdown", how, leaver: null },
        open("bob"),
        open("carol"),
        open("invitee"),
      ]);
      expect(outcome.failures, report(outcome)).toEqual([]);
    },
  );

  it("takes host rights from every tab of a host when one of their tabs is removed", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      { kind: "second", actor: "alice", action: "open" },
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "promote", "carol"),
      host("carol", "kick", "alice"),
      open("owner"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("takes host rights back from a temporary host when a host promotes the code's owner", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("owner"),
      { kind: "second", actor: "owner", action: "open" },
      host("owner", "blockStay", "owner"),
      host("alice", "allow", "owner"),
      host("alice", "promote", "owner"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
    expect(outcome.trace.filter((line) => line.includes("refused")), report(outcome)).toEqual([]);
  });

  it("makes every tab of a person a host promotes a host", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      { kind: "second", actor: "carol", action: "open" },
      host("alice", "promote", "carol"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("does not let a host-wait timer end the meeting while the SFU drains", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "revoke", "carol"),
      { kind: "leave", actor: "alice" },
      { kind: "untilDeadline", beforeMs: 20_000 },
      { kind: "shutdown", how: "drain", leaver: null, noticeMs: 30_000 },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("removes every tab of a person a host kicks, and tells each tab why", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      { kind: "second", actor: "carol", action: "open" },
      host("alice", "kick", "carol"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("never makes a removed person's remaining tab host when the last host leaves", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      { kind: "second", actor: "carol", action: "open" },
      host("alice", "revoke", "carol"),
      { kind: "leave", actor: "alice" },
      { kind: "expect", actor: "carol", tab: "second", role: "participant" },
      { kind: "tick", ms: 2 * MINUTE_MS + SECOND_MS },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("hands the room on when its only host is blocked", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      open("bob"),
      host("alice", "block", "alice"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("hands the room on when a host blocks someone without removing them and then leaves", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      open("invitee"),
      host("alice", "admit", "invitee"),
      host("alice", "blockStay", "carol"),
      { kind: "leave", actor: "alice" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("makes nobody host as a stopping SFU's people disconnect", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      { kind: "shutdown", how: "stop", leaver: null },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("does not end a call whose last person leaves while the SFU is draining", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      { kind: "shutdown", how: "drain", leaver: "alice" },
      open("bob"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("gives no recovery pass to someone let in while the room waits for its lost call", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      { kind: "restart" },
      open("bob"),
      open("invitee"),
      { kind: "restart" },
      open("bob"),
      open("invitee"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it.each([
    ["asks for an invite code", "code", "wrong"],
    ["is locked", "locked", "none"],
    ["is full", "full", "none"],
  ] as const)(
    "closes the room an attendee opened and was turned away from, when the webinar %s",
    async (_how, webinar, code) => {
      const outcome = await runScript(
        false,
        [{ kind: "attend", code }, { kind: "tick", ms: ROOM_OPEN_DEADLINE_MS + 2 * SECOND_MS }],
        { webinar },
      );
      expect(outcome.failures, report(outcome)).toEqual([]);
    },
  );

  it("hands the room on when its last host switches to another meeting on the same tab", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      open("bob"),
      { kind: "switch", actor: "alice", overtaken: null },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it.each(["disconnect", "newer"] as const)(
    "keeps the host wait of a room a host switches into when the switch is overtaken by a %s",
    async (overtaken) => {
      const outcome = await runScript(false, [
        open("alice"),
        open("carol"),
        host("alice", "admit", "carol"),
        host("alice", "revoke", "carol"),
        { kind: "switch", actor: "alice", overtaken: null },
        { kind: "switch", actor: "alice", overtaken },
      ]);
      expect(outcome.failures, report(outcome)).toEqual([]);
    },
  );

  it("tells a host blocked without being removed, and the room, that they no longer host", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "promote", "carol"),
      host("alice", "blockStay", "carol"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("gives a co-host's second tab the co-host's role after a host took their admission back in an open room", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "promote", "carol"),
      host("alice", "unlock", "alice"),
      host("alice", "revoke", "carol"),
      { kind: "second", actor: "carol", action: "open" },
      { kind: "expect", actor: "carol", tab: "second", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps someone a host removed knocking even after the room is opened up", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("carol"),
      host("alice", "admit", "carol"),
      host("alice", "unlock", "alice"),
      host("alice", "kick", "carol"),
      open("carol"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("makes someone who may host a meeting waiting for a host its host as soon as they arrive", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("bob"),
      host("alice", "admit", "bob"),
      host("alice", "revoke", "bob"),
      { kind: "leave", actor: "alice" },
      open("invitee"),
      { kind: "expect", actor: "invitee", tab: "main", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("hands the room on once a dropped last host's grace runs out", async () => {
    const outcome = await runScript(
      false,
      [
        open("alice"),
        open("carol"),
        host("alice", "admit", "carol"),
        { kind: "drop", actor: "alice" },
        { kind: "tick", ms: 15 * SECOND_MS + SECOND_MS },
      ],
      { graceMs: 15 * SECOND_MS },
    );
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("gives a room whose lost call ran out while it was being made a host from the people in it", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      { kind: "restart" },
      open("alice", { hold: true }),
      { kind: "leave", actor: "alice" },
      { kind: "tick", ms: 8 * MINUTE_MS },
      { kind: "release", alongside: null },
      open("invitee"),
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps a co-host's second tab, under a key of its own, a co-host when the code's owner arrives", async () => {
    const outcome = await runScript(true, [
      open("alice"),
      open("dana"),
      host("alice", "admit", "dana"),
      host("alice", "promote", "dana"),
      { kind: "second", actor: "dana", action: "open" },
      { kind: "expect", actor: "dana", tab: "second", role: "host" },
      open("owner"),
      { kind: "expect", actor: "dana", tab: "main", role: "host" },
      { kind: "expect", actor: "dana", tab: "second", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("refuses a host who tries to remove themselves from their other tab", async () => {
    const outcome = await runScript(false, [
      open("dana"),
      { kind: "second", actor: "dana", action: "open" },
      host("dana", "kick", "dana"),
      { kind: "expect", actor: "dana", tab: "second", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
    expect(outcome.trace.filter((line) => line.includes("refused")), report(outcome)).toHaveLength(1);
  });

  it("keeps a removed guest knocking when they come back in a fresh tab after a restart", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("dana"),
      host("alice", "admit", "dana"),
      host("alice", "kick", "dana"),
      { kind: "restart" },
      open("alice"),
      host("alice", "unlock", "alice"),
      open("dana"),
      { kind: "expect", actor: "dana", tab: "main", role: "out" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("gives a guest host who reloads their tab after a restart the host's seat back", async () => {
    const outcome = await runScript(false, [
      open("dana"),
      open("bob"),
      host("dana", "admit", "bob"),
      { kind: "restart" },
      { kind: "open", actor: "dana", pass: true, hold: false, reload: true },
      { kind: "expect", actor: "dana", tab: "main", role: "host" },
      open("bob"),
      { kind: "expect", actor: "bob", tab: "main", role: "participant" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("gives a guest host a fresh tab after a restart the host's seat back", async () => {
    const outcome = await runScript(false, [
      open("dana"),
      open("bob"),
      host("dana", "admit", "bob"),
      { kind: "restart" },
      open("dana"),
      { kind: "expect", actor: "dana", tab: "main", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps an old app's tab knocking although it shows the pass of the guest who hosts", async () => {
    const outcome = await runScript(false, [
      open("dana"),
      open("olddana"),
      { kind: "open", actor: "olddana", pass: true, hold: false, reload: true },
      { kind: "expect", actor: "olddana", tab: "main", role: "out" },
      { kind: "expect", actor: "dana", tab: "main", role: "host" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps a removed guest knocking when they come back on an old app in an open room", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("dana"),
      host("alice", "admit", "dana"),
      host("alice", "kick", "dana"),
      host("alice", "unlock", "alice"),
      open("olddana"),
      { kind: "expect", actor: "olddana", tab: "main", role: "out" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("takes an old app's tab out with the guest a host kicks", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      host("alice", "unlock", "alice"),
      open("olddana"),
      open("dana"),
      host("alice", "kick", "dana"),
      { kind: "expect", actor: "olddana", tab: "main", role: "out" },
      { kind: "expect", actor: "dana", tab: "main", role: "out" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("makes a guest's seated tab a host when their other tab joins with a host claim", async () => {
    const outcome = await runScript(
      false,
      [
        open("alice"),
        open("dana"),
        host("alice", "admit", "dana"),
        { kind: "second", actor: "dana", action: "open", claim: true },
        { kind: "expect", actor: "dana", tab: "second", role: "host" },
        { kind: "expect", actor: "dana", tab: "main", role: "host" },
      ],
      { hostClaims: true },
    );
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("lets a tab act as host when the other tab whose claim made it one drops while joining", async () => {
    const outcome = await runScript(
      false,
      [
        open("alice"),
        open("bob"),
        host("alice", "admit", "bob"),
        { kind: "second", actor: "bob", action: "open", claim: true, dropsWhileJoining: true },
        { kind: "expect", actor: "bob", tab: "main", role: "host" },
        host("bob", "kick", "alice"),
        { kind: "expect", actor: "alice", tab: "main", role: "out" },
      ],
      { hostClaims: true },
    );
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps a removed person knocking when their join claims the host's seat", async () => {
    const outcome = await runScript(
      false,
      [
        open("alice"),
        open("bob"),
        host("alice", "admit", "bob"),
        host("alice", "kick", "bob"),
        { kind: "open", actor: "bob", pass: true, hold: false, claim: true },
        { kind: "expect", actor: "bob", tab: "main", role: "out" },
      ],
      { hostClaims: true },
    );
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("links a guest's two passes into one person, whichever pass a tab joins under", async () => {
    const outcome = await runScript(false, [
      open("dana"),
      { kind: "second", actor: "dana", action: "open" },
      { kind: "expect", actor: "dana", tab: "second", role: "host" },
      open("bob"),
      host("dana", "admit", "bob"),
      host("bob", "kick", "dana"),
    ]);
    expect(outcome.failures.filter((failure) => !failure.includes("refused")), report(outcome)).toEqual([]);
  });

  it("gives entry, not the host's seat, to passes on an SFU with no record of their call", async () => {
    const outcome = await runScript(false, [
      open("alice"),
      open("bob"),
      host("alice", "admit", "bob"),
      { kind: "restart", elsewhere: true },
      open("bob"),
      { kind: "expect", actor: "bob", tab: "main", role: "participant" },
      open("alice"),
      { kind: "expect", actor: "alice", tab: "main", role: "participant" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it("keeps a removed invitee knocking when they are first back on an SFU with no record of the call", async () => {
    const outcome = await runScript(true, [
      open("owner"),
      open("invitee"),
      host("owner", "kick", "invitee"),
      { kind: "restart", elsewhere: true },
      open("invitee"),
      { kind: "expect", actor: "invitee", tab: "main", role: "out" },
    ]);
    expect(outcome.failures, report(outcome)).toEqual([]);
  });

  it(
    `keeps every invariant over ${SEQUENCES} random sequences from seed ${FIRST_SEED}`,
    async () => {
      for (let seed = FIRST_SEED; seed < FIRST_SEED + SEQUENCES; seed += 1) {
        const outcome = await runSequence(seed);
        if (outcome.failures.length > 0) {
          expect.fail(`seed ${seed}\n${report(outcome)}`);
        }
      }
    },
    Math.max(60_000, SEQUENCES * 200),
  );
});

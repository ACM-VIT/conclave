import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import type { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { initScheduledMeetings } from "../server/init.js";
import { ROOM_OPEN_DEADLINE_MS } from "../server/joinDeadlines.js";
import {
  createMemoryRoomRecoveryStore,
  type RoomRecoveryStore,
} from "../server/roomRecoveryLedger.js";
import { startRoomRecoveryPassRefresh } from "../server/roomRecoveryPass.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  createScheduledMeeting,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import {
  createConnectionContext,
  setSocketContext,
  type ConnectionContext,
} from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";
import type { ScheduledMeeting } from "../types.js";
import { Logger } from "../utilities/loggers.js";

const CODE = "abc-mnop-xyz";
const CHANNEL = `conclave:${CODE}`;
const SEQUENCES = Number(process.env.ROOM_LIFECYCLE_SEQUENCES ?? "300");
const FIRST_SEED = Number(process.env.ROOM_LIFECYCLE_FIRST_SEED ?? "1");
const STEPS_PER_SEQUENCE = 32;
const START = new Date("2026-11-23T09:00:00Z");
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const BETWEEN_STEPS_MS = 50;

type ActorName = "owner" | "alice" | "bob" | "carol" | "invitee";
const ACTOR_NAMES: ActorName[] = ["owner", "alice", "bob", "carol", "invitee"];
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
};

type Handler = (...args: unknown[]) => unknown;
type Peer = {
  socket: Socket;
  wire: { connected: boolean };
  handlers: Map<string, Handler>;
  events: Array<{ event: string; payload: unknown }>;
};
type Sfu = {
  generation: number;
  state: SfuState;
  io: SocketIOServer;
  channels: Map<string, Set<Peer>>;
  stopRefresh: () => void;
};
type Tab = {
  peer: Peer;
  context: ConnectionContext;
  generation: number;
  approvalsSeen: number;
};
type Actor = {
  name: ActorName;
  user: SfuAuthPayload;
  key: string;
  tab: Tab | null;
  pass: string | null;
};
type JoinAck = { status?: string; error?: string; roomRecoveryPass?: string };
type Completion = {
  actor: Actor;
  response: JoinAck;
  admin: boolean;
  incarnation: string | null;
  ownerEmail: string | null;
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
type Shadow = { phase: Phase; removed: Set<string>; members: Set<string> };

type HostAction =
  | "admit"
  | "reject"
  | "kick"
  | "promote"
  | "transfer"
  | "block"
  | "revoke"
  | "allow";
type Step =
  | { kind: "open"; actor: ActorName; pass: boolean; hold: boolean }
  | { kind: "again"; actor: ActorName; pass: boolean }
  | { kind: "leave"; actor: ActorName }
  | { kind: "drop"; actor: ActorName }
  | { kind: "together"; actors: [ActorName, ActorName] }
  | { kind: "hold" }
  | { kind: "release"; alongside: ActorName | null }
  | { kind: "host"; action: HostAction; by: ActorName; target: ActorName }
  | { kind: "end"; by: ActorName }
  | { kind: "restart" }
  | { kind: "tick"; ms: number };

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
  const peer = { handlers, events, wire } as Peer;
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
    },
    leave: (channel: string) => {
      sfu.channels.get(channel)?.delete(peer);
    },
    to: () => ({ emit: () => true }),
  };
  peer.socket = socket as unknown as Socket;
  return peer;
};

const makeIo = (sfu: Sfu): SocketIOServer =>
  ({
    to: () => ({ emit: () => true }),
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
    io: undefined as unknown as SocketIOServer,
    stopRefresh: () => undefined,
  };
  sfu.io = makeIo(sfu);
  sfu.stopRefresh = startRoomRecoveryPassRefresh(state, config.sfuSecret);
  return sfu;
};

const createWorld = async (options: {
  random: () => number;
  follows: () => boolean;
  scheduled: boolean;
}): Promise<World> => {
  const actors = Object.fromEntries(
    ACTOR_NAMES.map((name) => [
      name,
      {
        name,
        user: USERS[name],
        key: USERS[name].email ?? USERS[name].userId!,
        tab: null,
        pass: null,
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
    shadow: { phase: { kind: "none" }, removed: new Set(), members: new Set() },
    trace: [],
    completions: [],
    failures: [],
    firstSeen: new Map(),
    openers: new Map(),
    tabs: 0,
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
  return world;
};

const liveRoom = (world: World): Room | undefined => world.sfu.state.rooms.get(CHANNEL);

const seatedKeys = (room: Room | undefined): Set<string> => {
  const keys = new Set<string>();
  if (!room) return keys;
  for (const userId of room.clients.keys()) {
    const key = room.userKeysById.get(userId);
    if (key) keys.add(key);
  }
  return keys;
};

const hostKeys = (room: Room | undefined): Set<string> =>
  new Set([
    ...(room?.adminUserKeys ?? []),
    ...(room?.hostUserKey ? [room.hostUserKey] : []),
  ]);

const seatOf = (room: Room, key: string): string | null => {
  for (const userId of room.clients.keys()) {
    if (room.userKeysById.get(userId) === key) return userId;
  }
  return null;
};

const ownsCode = (actor: Actor, ownerEmail: string | null | undefined): boolean =>
  Boolean(actor.user.email) && ownerEmail === actor.user.email;

const liveTab = (world: World, actor: Actor): Tab | null => {
  const tab = actor.tab;
  if (!tab || tab.generation !== world.sfu.generation || !tab.peer.wire.connected) return null;
  return tab;
};

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

const openTab = (world: World, actor: Actor): Tab => {
  const sfu = world.sfu;
  world.tabs += 1;
  const peer = makePeer(sfu, `${actor.name}-tab-${world.tabs}`, actor.user);
  const context = createConnectionContext(sfu.io, peer.socket, sfu.state);
  setSocketContext(peer.socket, context);
  registerJoinRoomHandler(context);
  registerDisconnectHandlers(context);
  const tab: Tab = { peer, context, generation: sfu.generation, approvalsSeen: 0 };
  actor.tab = tab;
  return tab;
};

const approvalsOf = (tab: Tab): number =>
  tab.peer.events.filter(({ event }) => event === "joinApproved").length;

const startJoin = (world: World, actor: Actor, tab: Tab, presentPass: boolean): void => {
  tab.approvalsSeen = approvalsOf(tab);
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
    if (response.roomRecoveryPass) actor.pass = response.roomRecoveryPass;
    world.completions.push({
      actor,
      response,
      admin: tab.context.currentClient instanceof Admin,
      incarnation: tab.context.currentRoom?.incarnationId ?? null,
      ownerEmail: tab.context.currentRoom?.ownerEmail ?? null,
    });
  };
  const payload = {
    roomId: CODE,
    sessionId: actor.user.sessionId,
    ...(presentPass && actor.pass ? { roomRecoveryPass: actor.pass } : {}),
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
    const tab = liveTab(world, actor);
    if (!tab) continue;
    for (const { event, payload } of tab.peer.events) {
      if (event !== "roomRecoveryPass") continue;
      actor.pass = (payload as { roomRecoveryPass: string }).roomRecoveryPass;
    }
  }
};

const followApprovals = async (world: World): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    let asked = false;
    for (const actor of Object.values(world.actors)) {
      const tab = liveTab(world, actor);
      if (!tab || approvalsOf(tab) <= tab.approvalsSeen) continue;
      if (!world.follows()) {
        tab.approvalsSeen = approvalsOf(tab);
        continue;
      }
      world.trace.push(`  ${actor.name}'s tab asks again after being let in`);
      startJoin(world, actor, tab, true);
      asked = true;
    }
    if (!asked) return;
    await settle();
  }
};

const describeStep = (step: Step): string => {
  switch (step.kind) {
    case "open":
      return `${step.actor} opens a tab and joins${step.pass ? " with a pass" : ""}${step.hold ? ", the room opening is held" : ""}`;
    case "again":
      return `${step.actor} asks again on the same tab${step.pass ? " with a pass" : ""}`;
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
      return `${step.by} ${step.action}s ${step.target}`;
    case "end":
      return `${step.by} ends the meeting for everyone`;
    case "restart":
      return "the SFU restarts";
    case "tick":
      return `${step.ms / SECOND_MS} s pass`;
  }
};

const callOver = (world: World, why: string): void => {
  world.trace.push(`  (the call is over: ${why})`);
  world.shadow.phase = { kind: "none" };
  world.shadow.removed.clear();
  world.shadow.members.clear();
};

const removes = (world: World, target: Actor): void => {
  if (world.shadow.phase.kind !== "running") return;
  if (ownsCode(target, liveRoom(world)?.ownerEmail)) return;
  world.shadow.removed.add(target.key);
};

const performHostAction = async (
  world: World,
  step: Extract<Step, { kind: "host" }>,
): Promise<void> => {
  const by = world.actors[step.by];
  const target = world.actors[step.target];
  const room = liveRoom(world);
  if (!room) return;
  const seat = seatOf(room, target.key);
  const answer = await (async () => {
    switch (step.action) {
      case "admit":
        return hostAct(world, by, "admitUser", { userId: target.key });
      case "reject":
        return hostAct(world, by, "rejectUser", { userId: target.key });
      case "kick":
        return seat ? hostAct(world, by, "kickUser", { userId: seat }) : undefined;
      case "promote":
        return seat ? hostAct(world, by, "promoteHost", { userId: seat }) : undefined;
      case "transfer":
        return seat ? hostAct(world, by, "admin:transferHost", { userId: seat }) : undefined;
      case "block":
        return hostAct(world, by, "admin:blockUsers", { userKeys: [target.key], kickPresent: true });
      case "revoke":
        return hostAct(world, by, "admin:revokeAllowedUsers", { userKeys: [target.key] });
      case "allow":
        return hostAct(world, by, "admin:allowUsers", { userKeys: [target.key] });
    }
  })();
  if (!answer?.success) {
    world.trace.push(`  (refused: ${answer?.error ?? "no answer"})`);
    return;
  }
  if (step.action === "admit" || step.action === "allow") world.shadow.removed.delete(target.key);
  if (step.action === "kick" || step.action === "block" || step.action === "revoke") {
    removes(world, target);
  }
};

const restart = async (world: World): Promise<void> => {
  const old = world.sfu;
  const room = old.state.rooms.get(CHANNEL);
  const hosts = hostKeys(room);
  const members = new Set([...world.shadow.members, ...seatedKeys(room)]);
  old.stopRefresh();
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
  world.held = [];
  world.holdNext = false;
  world.sfu = await boot(world);
  const phase = world.shadow.phase;
  if (phase.kind !== "running") return;
  const recalled = await world.sfu.state.roomRecovery.recall(CHANNEL);
  if (!recalled.lost) {
    world.failures.push("the server kept no record of a running call when it restarted");
    return;
  }
  world.shadow.phase = {
    kind: "lost",
    callSince: phase.since,
    since: Date.now(),
    until: recalled.lost.claimableUntil,
    hosts,
    members,
    removals: new Set(world.shadow.removed),
  };
};

const perform = async (world: World, step: Step): Promise<void> => {
  world.trace.push(describeStep(step));
  const before = liveRoom(world);
  const beforeIncarnation = before?.incarnationId ?? null;
  const beforeHosts = hostKeys(before);
  const beforeSeated = seatedKeys(before);
  switch (step.kind) {
    case "open": {
      const actor = world.actors[step.actor];
      if (step.hold) world.holdNext = true;
      startJoin(world, actor, openTab(world, actor), step.pass);
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
      await restart(world);
      break;
    case "tick":
      await vi.advanceTimersByTimeAsync(step.ms);
      break;
  }
  await settle();
  await followApprovals(world);
  await settle();
  keepNewestPasses(world);
  await check(world, { beforeIncarnation, beforeHosts, beforeSeated });
};

const check = async (
  world: World,
  before: { beforeIncarnation: string | null; beforeHosts: Set<string>; beforeSeated: Set<string> },
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
  for (const done of world.completions.splice(0)) {
    if (done.response.status !== "joined") continue;
    const { actor } = done;
    const owner = ownsCode(actor, done.ownerEmail);
    const sameRoom = done.incarnation !== null && done.incarnation === before.beforeIncarnation;
    if (shadow.removed.has(actor.key) && !owner && !(sameRoom && before.beforeSeated.has(actor.key))) {
      fail(`${actor.name} was removed and got back in without a host letting them in`);
    }
    if (!done.admin || done.incarnation === null) continue;
    const phase = shadow.phase;
    const lostHost = phase.kind === "lost" && phase.hosts.has(actor.key);
    const justified = owner || (sameRoom && before.beforeHosts.has(actor.key)) || lostHost;
    if (!justified) {
      const openers = world.openers.get(done.incarnation) ?? new Set<string>();
      openers.add(actor.key);
      world.openers.set(done.incarnation, openers);
      if (openers.size > 1) {
        fail(`more than one person opened the same room as its host: ${[...openers].join(", ")}`);
      }
    }
  }

  const room = liveRoom(world);
  if (room && !world.firstSeen.has(room.incarnationId)) world.firstSeen.set(room.incarnationId, now);

  if (shadow.phase.kind === "lost") {
    const lost = shadow.phase;
    if (now < lost.until && room) {
      for (const key of [...seatedKeys(room)]) {
        const seat = seatOf(room, key);
        const client = seat ? room.clients.get(seat) : undefined;
        if (!(client instanceof Admin)) continue;
        const allowed =
          lost.hosts.has(key) ||
          (lost.members.has(key) && !shadow.removed.has(key)) ||
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
      const kept = new Set([
        ...recalled.lost.adminUserKeys,
        ...(recalled.lost.hostUserKey ? [recalled.lost.hostUserKey] : []),
      ]);
      for (const key of lost.hosts) {
        if (!kept.has(key)) fail(`the lost call forgot its host ${key} inside its recovery window`);
      }
      for (const key of lost.removals) {
        if (!recalled.lost.readmissionRequiredUserKeys.includes(key)) {
          fail(`the lost call forgot that ${key} was removed inside its recovery window`);
        }
      }
    }
    if (recalled.passesVoidUntil !== null && recalled.passesVoidUntil >= lost.callSince) {
      fail("passes from a call the server lost were voided inside its recovery window");
    }
  }

  if (room && room.isLocked && !room.hasActiveAdmin() && !room.hasEnded) {
    const openedAt = world.firstSeen.get(room.incarnationId) ?? now;
    const opening = room.awaitingOpener !== null && now - openedAt <= ROOM_OPEN_DEADLINE_MS;
    const recovering = room.restorerState(now) === "awaited";
    if (!opening && !recovering) {
      fail(
        `the room has been locked with nobody to let anyone in for ${Math.round((now - openedAt) / SECOND_MS)} s (${room.clients.size} in it, ${room.pendingClients.size} waiting)`,
      );
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

const nextStep = (world: World): Step => {
  const random = world.random;
  const room = liveRoom(world);
  const options: Array<[number, () => Step]> = [];
  for (const actor of Object.values(world.actors)) {
    const name = actor.name;
    if (!liveTab(world, actor)) {
      options.push([3, () => ({ kind: "open", actor: name, pass: random() < 0.7, hold: random() < 0.2 })]);
      continue;
    }
    options.push([1.5, () => ({ kind: "again", actor: name, pass: random() < 0.7 })]);
    options.push([1.2, () => ({ kind: "leave", actor: name })]);
    options.push([0.4, () => ({ kind: "drop", actor: name })]);
    if (!room || !hostsLiveRoom(world, actor)) continue;
    options.push([0.25, () => ({ kind: "end", by: name })]);
    for (const other of Object.values(world.actors)) {
      if (other === actor) continue;
      const target = other.name;
      const host = (action: HostAction): Step => ({ kind: "host", action, by: name, target });
      if (room.pendingClients.has(other.key)) {
        options.push([3, () => host("admit")]);
        options.push([0.8, () => host("reject")]);
      }
      if (seatOf(room, other.key)) {
        options.push([1.2, () => host("kick")]);
        options.push([1, () => host("promote")]);
        options.push([0.4, () => host("transfer")]);
        options.push([0.4, () => host("block")]);
      }
      options.push([0.2, () => host("revoke")]);
      options.push([0.2, () => host("allow")]);
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
      const second = ACTOR_NAMES.filter((name) => name !== first)[Math.floor(random() * 4)];
      return { kind: "together", actors: [first, second] };
    },
  ]);
  options.push([0.4, () => ({ kind: "hold" })]);
  options.push([0.6, () => ({ kind: "restart" })]);
  options.push([1.5, () => ({ kind: "tick", ms: SECOND_MS })]);
  options.push([1.2, () => ({ kind: "tick", ms: ROOM_OPEN_DEADLINE_MS + SECOND_MS })]);
  options.push([0.6, () => ({ kind: "tick", ms: MINUTE_MS + SECOND_MS })]);
  options.push([0.5, () => ({ kind: "tick", ms: 8 * MINUTE_MS })]);
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

const runSequence = (seed: number): Promise<Outcome> =>
  withModelClock(async () => {
    const random = seeded(seed);
    const world = await createWorld({
      random,
      follows: () => random() < 0.8,
      scheduled: random() < 0.5,
    });
    for (let index = 0; index < STEPS_PER_SEQUENCE && world.failures.length === 0; index += 1) {
      await vi.advanceTimersByTimeAsync(BETWEEN_STEPS_MS);
      await perform(world, nextStep(world));
    }
    return { trace: world.trace, failures: world.failures };
  });

const runScript = (
  scheduled: boolean,
  steps: Step[],
  options: { tabsAskAgain?: boolean } = {},
): Promise<Outcome> =>
  withModelClock(async () => {
    const tabsAskAgain = options.tabsAskAgain ?? true;
    const world = await createWorld({ random: seeded(0), follows: () => tabsAskAgain, scheduled });
    for (const step of steps) {
      await vi.advanceTimersByTimeAsync(BETWEEN_STEPS_MS);
      await perform(world, step);
      if (world.failures.length > 0) break;
    }
    return { trace: world.trace, failures: world.failures };
  });

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
      { kind: "leave", actor: "owner" },
      { kind: "release", alongside: null },
      open("invitee"),
      open("carol"),
      { kind: "tick", ms: ROOM_OPEN_DEADLINE_MS + SECOND_MS },
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
    Math.max(60_000, SEQUENCES * 60),
  );
});

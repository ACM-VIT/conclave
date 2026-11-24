import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { RoomApps } from "../server/roomApps.js";
import { RoomAppsWork } from "../server/roomAppsWork.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerAppsHandlers } from "../server/socket/handlers/appsHandlers.js";
import { RATE_LIMITS } from "../server/socket/rateLimit.js";
import { createSfuState } from "../server/state.js";
import type { AppsState } from "../types.js";
import { seededRandom } from "./support/appsRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Handler = (...args: unknown[]) => unknown;
type Received = { event: string; payload: unknown; at: number; direct: boolean };
type WriteCall = {
  userId: string;
  at: number;
  appId: string;
  generation: number | null;
  keys: string[];
  update: Uint8Array;
  result: string | null;
};
type SentWrite = { peer: string; keys: string[]; protectedFromClose: boolean };

const BOARD = "whiteboard";
const participantOf = (peer: string): string => peer.split("#")[0];
const { capacity: UPDATE_BURST, refillPerSec: UPDATES_PER_SECOND } = RATE_LIMITS.appsYjsUpdate;

const structsIn = (update: Uint8Array): (Y.Item | Y.GC | Y.Skip)[] => {
  try {
    return Y.decodeUpdate(update).structs;
  } catch {
    return [];
  }
};

const keysIn = (update: Uint8Array): string[] =>
  structsIn(update).flatMap((struct) =>
    struct instanceof Y.Item && struct.parentSub?.startsWith("w") ? [struct.parentSub] : [],
  );

const recordWrites = (): WriteCall[] => {
  const calls: WriteCall[] = [];
  const original: (this: RoomApps, ...args: Parameters<RoomApps["write"]>) => ReturnType<RoomApps["write"]> =
    Reflect.get(RoomApps.prototype, "write");
  vi.spyOn(RoomApps.prototype, "write").mockImplementation(function (
    this: RoomApps,
    ...args: Parameters<RoomApps["write"]>
  ) {
    const generation = this.snapshot().docGeneration;
    const result = original.apply(this, args);
    const [appId, userId, update] = args;
    calls.push({ userId, at: Date.now(), appId, generation, keys: keysIn(update), update, result });
    return result;
  });
  return calls;
};

const recordAdmissions = (): Set<string> => {
  const admitted = new Set<string>();
  const original: (this: RoomAppsWork, ...args: Parameters<RoomAppsWork["hold"]>) => boolean = Reflect.get(
    RoomAppsWork.prototype,
    "hold",
  );
  vi.spyOn(RoomAppsWork.prototype, "hold").mockImplementation(function (
    this: RoomAppsWork,
    ...args: Parameters<RoomAppsWork["hold"]>
  ) {
    const held = original.apply(this, args);
    if (held) for (const key of keysIn(args[0].update)) admitted.add(key);
    return held;
  });
  return admitted;
};

const makeWorkRoom = () => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "apps-work", instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  const room = new Room({
    id: "room",
    clientId: "conclave",
    workerPid: null,
    router: { closed: false, close: () => {} } as unknown as Router,
  });
  state.rooms.set(room.channelId, room);
  const peers = new Map<string, ReturnType<typeof connect>>();
  let pendingStage = 0;
  let writeSerial = 0;
  const sent: SentWrite[] = [];
  const commands: { sentAt: number; ackedAt: number | null }[] = [];
  const ownClients = new Map<string, Set<number>>();
  const io = {
    to: () => ({
      emit: (event: string, payload: unknown) => {
        for (const peer of peers.values()) peer.deliver(event, payload, false);
      },
    }),
  } as unknown as SocketIOServer;

  function connect(id: string, options: { host?: boolean; legacy?: boolean } = {}) {
    const handlers = new Map<string, Handler>();
    const received: Received[] = [];
    let connected = true;
    const participant = id.split("#")[0];
    const own = ownClients.get(participant) ?? new Set<number>();
    ownClients.set(participant, own);
    let doc = new Y.Doc();
    own.add(doc.clientID);
    let replica = 0;
    let view = "";
    let needsSync = false;
    let syncInFlight = false;
    let pushAfterSync: Uint8Array | null = null;
    const freshCopy = () => {
      doc = new Y.Doc();
      own.add(doc.clientID);
      replica += 1;
      needsSync = room.apps.activeAppId === BOARD;
      pushAfterSync = null;
    };
    const deliver = (event: string, payload: unknown, direct: boolean) => {
      if (!connected) return;
      received.push({ event, payload, at: Date.now(), direct });
      if (event === "apps:state") {
        const stage = payload as AppsState;
        const next = options.legacy ? `${stage.activeAppId}` : `${stage.activeAppId}:${stage.docGeneration}`;
        if (next !== view) {
          view = next;
          freshCopy();
          needsSync = stage.activeAppId === BOARD;
        }
      } else if (event === "apps:yjs:update") {
        Y.applyUpdate(doc, (payload as { update: Uint8Array }).update, "remote");
      } else if (event === "apps:yjs:refused") {
        if ((payload as { replicaId: string }).replicaId === `copy-${replica}`) freshCopy();
      }
    };
    const socket = {
      id: `socket-${id}`,
      data: { user: {} },
      get connected() {
        return connected;
      },
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      emit: (event: string, payload: unknown) => {
        deliver(event, payload, true);
        return true;
      },
      to: () => ({
        emit: (event: string, payload: unknown) => {
          for (const other of peers.values()) if (other.id !== id) other.deliver(event, payload, false);
        },
      }),
      join: () => {},
      leave: () => {},
      disconnect: () => {},
    } as unknown as Socket;
    const client = options.host ? new Admin({ id, socket }) : new Client({ id, socket });
    room.addClient(client);
    room.setUserIdentity(id, participant, participant);
    const context = createConnectionContext(io, socket, state);
    context.currentRoom = room;
    context.currentClient = client;
    registerAppsHandlers(context);
    const fire = (event: string, ...args: unknown[]) => handlers.get(event)!(...args);
    const sendUpdate = (update: Uint8Array) =>
      fire("apps:yjs:update", {
        appId: BOARD,
        update,
        replicaId: options.legacy ? undefined : `copy-${replica}`,
      });
    const peer = {
      id,
      deliver,
      received,
      get connected() {
        return connected;
      },
      get doc() {
        return doc;
      },
      write: (count: number, blind = false) => {
        for (let index = 0; index < count; index += 1) {
          const before = Y.encodeStateVector(doc);
          const key = `w${(writeSerial += 1)}`;
          doc.transact(() => {
            doc.getMap("m").set(key, writeSerial);
            if (blind && index === 0) doc.getMap("m").set("shared", new Y.Map());
          });
          sent.push({
            peer: id,
            keys: [key],
            protectedFromClose: room.apps.activeAppId === BOARD && pendingStage === 0,
          });
          sendUpdate(Y.encodeStateAsUpdate(doc, before));
        }
      },
      sync: (valid = true) => {
        if (!valid) {
          fire("apps:yjs:sync", { appId: BOARD, syncMessage: "%%%" }, () => {});
          return;
        }
        const copy = replica;
        syncInFlight = true;
        needsSync = false;
        fire("apps:yjs:sync", { appId: BOARD, syncMessage: Y.encodeStateVector(doc) }, (reply: unknown) => {
          syncInFlight = false;
          const answer = reply as { syncMessage?: Uint8Array; stateVector?: Uint8Array };
          if (copy !== replica || !answer?.syncMessage) return;
          Y.applyUpdate(doc, answer.syncMessage, "remote");
          pushAfterSync = answer.stateVector ?? null;
        });
      },
      react: () => {
        if (!connected) return;
        if (pushAfterSync) {
          const diff = Y.encodeStateAsUpdate(doc, pushAfterSync);
          const ahead = [...Y.decodeStateVector(Y.encodeStateVector(doc))].some(
            ([client, clock]) => clock > (Y.decodeStateVector(pushAfterSync!).get(client) ?? 0),
          );
          pushAfterSync = null;
          if (ahead) sendUpdate(diff);
        }
        if (needsSync && !syncInFlight) peer.sync();
      },
      lock: (locked: boolean) => {
        pendingStage += 1;
        const command = { sentAt: Date.now(), ackedAt: null as number | null };
        commands.push(command);
        fire("apps:lock", { locked }, () => {
          pendingStage -= 1;
          command.ackedAt = Date.now();
        });
      },
      stage: (event: "apps:open" | "apps:close" | "apps:discard", appId?: string) => {
        pendingStage += 1;
        const command = { sentAt: Date.now(), ackedAt: null as number | null };
        commands.push(command);
        fire(event, { appId, expectedRevision: undefined }, () => {
          pendingStage -= 1;
          command.ackedAt = Date.now();
        });
      },
      sendRaw: (update: Uint8Array) => sendUpdate(update),
      flood: (count: number) => {
        for (let index = 0; index < count; index += 1) {
          fire("apps:yjs:update", { appId: BOARD, update: new Uint8Array([index % 250]), replicaId: `flood-${index}` });
        }
      },
      leave: () => {
        handlers.get("disconnecting")?.();
        connected = false;
        room.removeClient(id);
        for (const removal of room.apps.clearUserAwareness(id)) void removal;
      },
      directStates: () =>
        received.filter((entry) => entry.event === "apps:state" && entry.direct),
    };
    peers.set(id, peer);
    return peer;
  }

  return { room, peers, sent, commands, ownClients, connect };
};

const lastDirectStateIsOwed = (peer: { connected: boolean; directStates: () => Received[] }, now: number) => {
  if (!peer.connected) return false;
  const states = peer.directStates();
  const last = states.at(-1);
  return Boolean(last && (last.payload as AppsState).activeAppId === null && states.length % 2 === 1 && now - last.at > 600);
};

describe("one work queue per room", () => {
  it("still owes an older client the real stage when its own sync follows a refused queued write", () => {
    vi.useFakeTimers();
    const { connect } = makeWorkRoom();
    const host = connect("host#1", { host: true });
    host.stage("apps:open", BOARD);
    const legacy = connect("legacy#1", { legacy: true });
    legacy.sync();
    legacy.write(UPDATE_BURST);
    host.lock(true);

    legacy.write(1);
    legacy.sync();
    vi.advanceTimersByTime(10_000);

    expect(legacy.directStates().map((entry) => (entry.payload as AppsState).activeAppId).slice(0, 2)).toEqual([
      null,
      BOARD,
    ]);
  });

  it.each([
    ["an invalid sync", false],
    ["a valid sync", true],
  ])("never applies a socket's writes faster than its budget when %s follows each one", (_, valid) => {
    vi.useFakeTimers();
    const calls = recordWrites();
    const { connect } = makeWorkRoom();
    const host = connect("host#1", { host: true });
    host.stage("apps:open", BOARD);
    const writer = connect("writer#1");
    writer.sync();
    writer.write(UPDATE_BURST);

    for (let round = 0; round < 100; round += 1) {
      writer.write(1);
      writer.sync(valid);
    }

    const applied = calls.filter((call) => call.userId === participantOf("writer#1")).length;
    expect(applied).toBeGreaterThanOrEqual(UPDATE_BURST);
    expect(applied).toBeLessThanOrEqual(UPDATE_BURST);
  });

  it.each([
    ["an open board", false],
    ["a locked board", true],
  ])("answers host commands within a second while a guest floods distinct copies on %s", (_, locked) => {
    vi.useFakeTimers();
    const { connect, commands } = makeWorkRoom();
    const host = connect("host#1", { host: true });
    host.stage("apps:open", BOARD);
    if (locked) host.lock(true);
    const guest = connect("guest#1");
    guest.sync();

    guest.flood(3600);
    host.stage("apps:close");
    const close = commands.at(-1)!;
    for (let waited = 0; waited < 5000 && close.ackedAt === null; waited += 50) vi.advanceTimersByTime(50);

    expect(close.ackedAt).not.toBeNull();
    expect(close.ackedAt! - close.sentAt).toBeLessThanOrEqual(1000);
  });

  it("keeps a leaving participant's queued strokes under the participant who wrote them", () => {
    vi.useFakeTimers();
    const calls = recordWrites();
    const { connect, room } = makeWorkRoom();
    const host = connect("host#1", { host: true });
    host.stage("apps:open", BOARD);
    const artist = connect("artist#1");
    artist.sync();

    artist.write(UPDATE_BURST + 20);
    artist.leave();
    vi.advanceTimersByTime(2000);

    expect(calls.filter((call) => call.userId === participantOf("artist#1")).length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.result === "foreign-id")).toEqual([]);
    expect(room.apps.liveDoc(BOARD)!.getMap("m").size).toBe(UPDATE_BURST + 20);
  });

  it("keeps a guest's two linked tabs writing as one participant, and their ids theirs", () => {
    vi.useFakeTimers();
    const calls = recordWrites();
    const { connect, room } = makeWorkRoom();
    const host = connect("host#1", { host: true });
    host.stage("apps:open", BOARD);
    const first = connect("guest-gp_pass#tab-1");
    const second = connect("guest-gp_pass#tab-2", { legacy: true });
    const other = connect("guest-gp_other#tab-1");
    for (const tab of [first, second, other]) tab.sync();

    first.write(3);
    second.write(3);
    const firstClient = first.doc.clientID;
    first.write(UPDATE_BURST + 10);
    first.leave();
    vi.advanceTimersByTime(2000);
    second.write(2);
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(room.apps.liveDoc(BOARD)!));
    forger.clientID = firstClient;
    const before = Y.encodeStateVector(forger);
    forger.getMap("m").set("forged", true);
    other.sendRaw(Y.encodeStateAsUpdate(forger, before));
    vi.advanceTimersByTime(2000);

    const byParticipant = (participant: string) => calls.filter((call) => call.userId === participant);
    expect(byParticipant("guest-gp_pass").length).toBeGreaterThan(0);
    expect(byParticipant("guest-gp_pass").map((call) => call.result).filter((result) => result !== null)).toEqual([]);
    expect(room.apps.liveDoc(BOARD)!.getMap("m").size).toBe(3 + 3 + UPDATE_BURST + 10 + 2);
    expect(byParticipant("guest-gp_other").map((call) => call.result)).toEqual(["foreign-id"]);
    expect(room.apps.liveDoc(BOARD)!.getMap("m").has("forged")).toBe(false);
  });

  it("answers a host command while a guest sends packets to a locked board", () => {
    vi.useFakeTimers();
    const { connect, commands } = makeWorkRoom();
    const host = connect("host#1", { host: true });
    host.stage("apps:open", BOARD);
    const guest = connect("guest#1");
    guest.sync();
    guest.write(UPDATE_BURST);
    guest.write(1);
    host.lock(true);
    guest.write(1);

    host.stage("apps:close");
    const close = commands.at(-1)!;
    for (let waited = 0; waited < 5000 && close.ackedAt === null; waited += 1) {
      guest.sendRaw(Y.encodeStateAsUpdate(new Y.Doc()));
      vi.advanceTimersByTime(1);
    }

    expect(close.ackedAt).not.toBeNull();
    expect(close.ackedAt! - close.sentAt).toBeLessThanOrEqual(1000);
  });

  it("applies another participant's queued strokes before the host closes the board", () => {
    vi.useFakeTimers();
    const { connect, room } = makeWorkRoom();
    const host = connect("host#1", { host: true });
    host.stage("apps:open", BOARD);
    const artist = connect("artist#1");
    artist.sync();
    artist.write(UPDATE_BURST + 20);

    host.stage("apps:close");
    vi.advanceTimersByTime(2000);
    host.stage("apps:open", BOARD);
    vi.advanceTimersByTime(2000);

    expect(room.apps.liveDoc(BOARD)!.getMap("m").size).toBe(UPDATE_BURST + 20);
  });

  it.each([7, 270, 4242])(
    "keeps every accepted write, every budget and every owed stage across random interleavings (seed %i)",
    (seed) => {
      vi.useFakeTimers();
      const calls = recordWrites();
      const admitted = recordAdmissions();
      const { connect, peers, room, sent, commands, ownClients } = makeWorkRoom();
      const random = seededRandom(seed);
      const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
      const host = connect("host#1", { host: true });
      host.stage("apps:open", BOARD);
      let joined = 0;
      const join = () => connect(`peer${(joined += 1)}#1`, { legacy: random() < 0.5 });
      for (let index = 0; index < 4; index += 1) join();
      const participants = () => [...peers.values()].filter((peer) => peer.connected);

      const proof = {
        callsChecked: 0,
        replayed: 0,
        boardsCompared: 0,
        keysKept: 0,
        protectedDecided: 0,
        blanksSeen: 0,
        commandsAcked: 0,
        callsAfterLeave: 0,
      };
      const left = new Set<string>();
      const replays = new Map<number, Y.Doc>();
      const sentByKey = new Map<string, SentWrite>();
      const timesByUser = new Map<string, number[]>();
      let checkedCalls = 0;
      let checkedSent = 0;
      const withinBudget = (times: number[], window: number): boolean => {
        const limit = UPDATE_BURST + Math.floor((UPDATES_PER_SECOND * window) / 1000) + 1;
        let first = 0;
        for (let last = 0; last < times.length; last += 1) {
          while (times[first] < times[last] - window) first += 1;
          if (last - first + 1 > limit) return false;
        }
        return true;
      };
      const check = () => {
        for (; checkedSent < sent.length; checkedSent += 1) {
          for (const key of sent[checkedSent].keys) sentByKey.set(key, sent[checkedSent]);
        }
        for (; checkedCalls < calls.length; checkedCalls += 1) {
          const call = calls[checkedCalls];
          proof.callsChecked += 1;
          timesByUser.set(call.userId, [...(timesByUser.get(call.userId) ?? []), call.at]);
          if (call.result === null && call.appId === BOARD && call.generation !== null) {
            const replay = replays.get(call.generation) ?? new Y.Doc();
            replays.set(call.generation, replay);
            Y.applyUpdate(replay, call.update);
            proof.replayed += 1;
          }
          if (left.has(call.userId)) proof.callsAfterLeave += 1;
          if (call.result !== "not-live") {
            for (const key of call.keys) {
              const write = sentByKey.get(key);
              if (write?.protectedFromClose === true && participantOf(write.peer) === call.userId) {
                proof.protectedDecided += 1;
              }
            }
          }
          if (call.result === "foreign-id") {
            const own = ownClients.get(call.userId.split("#")[0]) ?? new Set<number>();
            const writers = structsIn(call.update).map((struct) => struct.id.client);
            expect(
              writers.length > 0 && writers.every((client) => own.has(client)),
              `${call.userId} refused its own ids as foreign`,
            ).toBe(false);
          }
          if (call.result === "not-live") {
            for (const key of call.keys) {
              const write = sentByKey.get(key);
              if (write?.protectedFromClose !== true || participantOf(write.peer) !== call.userId) continue;
              proof.protectedDecided += 1;
              expect(write.keys.includes(key), `${key} sent while the board was live was dropped`).toBe(false);
            }
          }
        }
        const generation = room.apps.activeAppId === BOARD ? room.apps.snapshot().docGeneration : null;
        const live = room.apps.liveDoc(BOARD);
        if (live && generation !== null) {
          const replay = replays.get(generation) ?? new Y.Doc();
          expect(replay.getMap("m").toJSON(), "the board is the replay of its accepted writes").toEqual(
            live.getMap("m").toJSON(),
          );
          proof.boardsCompared += 1;
          for (const key of replay.getMap("m").keys()) {
            if (!key.startsWith("w")) continue;
            expect(live.getMap("m").has(key), `accepted ${key} kept`).toBe(true);
            proof.keysKept += 1;
          }
        }
        for (const [userId, times] of timesByUser) {
          for (const window of [0, 500, 2000]) {
            expect(withinBudget(times, window), `${userId} within ${window} ms`).toBe(true);
          }
        }
        for (const peer of peers.values()) {
          expect(lastDirectStateIsOwed(peer, Date.now()), `${peer.id} owed its stage`).toBe(false);
        }
        proof.blanksSeen = [...peers.values()].reduce(
          (sum, peer) =>
            sum + peer.directStates().filter((entry) => (entry.payload as AppsState).activeAppId === null).length,
          0,
        );
        for (const command of commands) {
          const waited = (command.ackedAt ?? Date.now()) - command.sentAt;
          expect(waited, "a host command waited past the bound").toBeLessThanOrEqual(1000);
        }
        proof.commandsAcked = commands.filter((command) => command.ackedAt !== null).length;
      };

      for (let step = 0; step < 400; step += 1) {
        const roll = random();
        const peer = pick(participants());
        if (step === 100) {
          const leaving = pick(participants().filter((candidate) => candidate !== host));
          leaving.write(UPDATE_BURST + 10);
          leaving.leave();
          left.add(participantOf(leaving.id));
          join();
        }
        if (roll < 0.45) peer.write(1 + Math.floor(random() * 25), random() < 0.1);
        else if (roll < 0.57) peer.sync(random() < 0.6);
        else if (roll < 0.62) host.stage("apps:open", BOARD);
        else if (roll < 0.635) host.stage("apps:close");
        else if (roll < 0.65) host.stage("apps:open", "watch");
        else if (roll < 0.66) host.stage("apps:discard", BOARD);
        else if (roll < 0.68 && participants().length > 2) {
          const leaving = pick(participants().filter((candidate) => candidate !== host));
          if (random() < 0.5) leaving.write(UPDATE_BURST + Math.floor(random() * 20));
          leaving.leave();
          left.add(participantOf(leaving.id));
          join();
        } else if (roll < 0.69 && participants().length > 1) {
          pick(participants().filter((candidate) => candidate !== host)).flood(200 + Math.floor(random() * 400));
        } else if (roll < 0.7) host.lock(random() < 0.5); else vi.advanceTimersByTime(Math.floor(random() * 400));
        for (const each of peers.values()) each.react();
        check();
      }
      for (let settle = 0; settle < 30; settle += 1) {
        vi.advanceTimersByTime(2000);
        for (const each of peers.values()) each.react();
      }
      check();
      const reached = new Set(calls.flatMap((call) => call.keys));
      const vanished = [...admitted].filter((key) => !reached.has(key));
      expect(vanished).toEqual([]);
      expect(admitted.size).toBeGreaterThan(sent.length / 2);
      expect(proof, "every invariant saw what it checks").toEqual({
        callsChecked: expect.any(Number) as number,
        replayed: expect.any(Number) as number,
        boardsCompared: expect.any(Number) as number,
        keysKept: expect.any(Number) as number,
        protectedDecided: expect.any(Number) as number,
        blanksSeen: expect.any(Number) as number,
        commandsAcked: expect.any(Number) as number,
        callsAfterLeave: expect.any(Number) as number,
      });
      for (const [name, count] of Object.entries(proof)) {
        expect(count, `${name} observed`).toBeGreaterThan(0);
      }
    },
    60_000,
  );
});

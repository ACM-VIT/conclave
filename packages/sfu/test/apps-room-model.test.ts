import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { seededRandom } from "./support/appsRoom.js";
import {
  BOARD,
  UPDATE_BURST,
  UPDATES_PER_SECOND,
  isBlank,
  makeWorkRooms,
  recordWrites,
  type Command,
  type Received,
} from "./support/appsWorkRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());
const CLOSE_BOUND_MS = 150;

type Peer = ReturnType<ReturnType<typeof makeWorkRooms>["connect"]>;

class ReferenceBucket {
  private tokens: number = UPDATE_BURST;
  private last: number | null = null;

  take(now: number): boolean {
    if (this.last !== null) {
      this.tokens = Math.min(UPDATE_BURST, this.tokens + ((now - this.last) / 1000) * UPDATES_PER_SECOND);
    }
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  full(now: number): boolean {
    if (this.last === null) return true;
    return Math.min(UPDATE_BURST, this.tokens + ((now - this.last) / 1000) * UPDATES_PER_SECOND) >= UPDATE_BURST;
  }
}

const runModel = (seed: number, steps: number) => {
  vi.useFakeTimers();
  const calls = recordWrites();
  const rooms = makeWorkRooms();
  const room = rooms.roomFor("room");
  const random = seededRandom(seed);
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];

  const reference = { presented: null as string | null, locked: false, epoch: 0 };
  const pending = new Set<Command>();
  const mustCommit = new Map<string, number>();
  const neverCommit = new Set<string>();
  const observed = {
    callsChecked: 0,
    mustCommitVerified: 0,
    heldAcrossClose: 0,
    heldAcrossLeave: 0,
    neverCommitVerified: 0,
    lockedRejections: 0,
    blankRestarts: 0,
    recoveredBySync: 0,
    recoveredByEmptyUpdate: 0,
    blankPhaseWrites: 0,
    blankPhaseSyncs: 0,
    commandsUnderAttack: 0,
    chainedCommands: 0,
    slotsChecked: 0,
    budgetPressure: 0,
  };
  const heldAcrossClose = new Set<string>();
  const heldAcrossLeave = new Set<string>();

  const host = rooms.connect("host#1", { host: true });
  const honest: Peer[] = [];
  const buckets = new Map<string, ReferenceBucket>();
  let joined = 0;
  const joinHonest = () => {
    const peer = rooms.connect(`honest${(joined += 1)}#1`, { legacy: random() < 0.5 });
    honest.push(peer);
    buckets.set(peer.socketId, new ReferenceBucket());
    return peer;
  };
  for (let index = 0; index < 3; index += 1) joinHonest();
  let bursty = rooms.connect("bursty#1");
  let burstyBucket = new ReferenceBucket();
  const adversary = rooms.connect("adversary#1");
  const racer = rooms.connect("racer#1", { legacy: true });
  const switcher = rooms.connect("switcher#1");
  const chainers = Array.from({ length: 6 }, (_, index) => rooms.connect(`chain${index}#1`));

  const command = (kind: Command["kind"], appId?: string): Command => {
    const record = host.command(kind, appId);
    if (record.ackedAt === null) pending.add(record);
    else applyReply(record);
    return record;
  };
  const applyReply = (record: Command) => {
    const reply = record.reply as { success?: boolean } | undefined;
    if (!reply?.success) return;
    if (record.kind === "open") {
      if (reference.presented === record.appId) return;
      reference.presented = record.appId ?? null;
      reference.locked = false;
    } else if (record.kind === "close") {
      if (reference.presented === null) return;
      reference.presented = null;
      reference.locked = false;
    } else if (record.kind === "discard") {
      reference.epoch += 1;
      if (reference.presented === record.appId) {
        reference.presented = null;
        reference.locked = false;
      }
    } else {
      reference.locked = record.kind === "lock";
    }
  };
  const settleCommands = () => {
    for (const record of [...pending]) {
      if (record.ackedAt === null) continue;
      pending.delete(record);
      applyReply(record);
    }
  };
  const restarting = (peer: Peer) => {
    const last = peer.received.filter((entry) => entry.event === "apps:state").at(-1);
    return last !== undefined && last.direct && isBlank(last) && Date.now() - last.at < 500;
  };
  const eligible = (peer: Peer) =>
    peer.connected &&
    peer.roomId === "room" &&
    peer.synced &&
    !restarting(peer) &&
    reference.presented === BOARD &&
    (!reference.locked || peer.host) &&
    pending.size === 0;
  const advance = (ms: number, each: () => void = () => {}) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1) {
      each();
      vi.advanceTimersByTime(1);
      settleCommands();
    }
  };
  const react = () => {
    for (const peer of rooms.peers.values()) if (peer !== racer) peer.react();
  };

  const honestWrite = () => {
    const peer = pick(honest.filter((candidate) => candidate.connected));
    if (!peer) return;
    if (peer.legacy && peer.stale && !restarting(peer) && reference.presented === BOARD) {
      peer.write(1);
      return;
    }
    if (!eligible(peer)) return;
    const bucket = buckets.get(peer.socketId)!;
    const count = 1 + Math.floor(random() * 4);
    for (let index = 0; index < count; index += 1) {
      if (!bucket.take(Date.now())) return;
      const [writeId] = peer.write(1);
      mustCommit.set(writeId, reference.epoch);
    }
  };
  const burst = (then: "wait" | "close" | "leave") => {
    if (!eligible(bursty) || !burstyBucket.full(Date.now())) return;
    const extra = 1 + Math.floor(random() * 20);
    const writes = bursty.write(UPDATE_BURST + extra);
    for (let index = 0; index < UPDATE_BURST; index += 1) burstyBucket.take(Date.now());
    for (const writeId of writes) mustCommit.set(writeId, reference.epoch);
    const held = writes.slice(UPDATE_BURST);
    if (then === "close") {
      for (const writeId of held) heldAcrossClose.add(writeId);
      command("close");
      advance(CLOSE_BOUND_MS);
      command("open", BOARD);
      advance(5);
    } else if (then === "leave") {
      for (const writeId of held) heldAcrossLeave.add(writeId);
      bursty.leave();
      advance(40);
      bursty = rooms.connect(`bursty-${(joined += 1)}#1`);
      burstyBucket = new ReferenceBucket();
      bursty.react();
    } else {
      advance(40);
    }
  };
  const probeLocked = () => {
    if (reference.presented !== BOARD || !reference.locked || pending.size > 0 || !adversary.synced) return;
    for (const writeId of adversary.write(1 + Math.floor(random() * 3))) {
      neverCommit.add(writeId);
      observed.lockedRejections += 1;
    }
  };
  const attackWhile = (attack: () => void, kind: Command["kind"], appId?: string) => {
    attack();
    const record = command(kind, appId);
    observed.commandsUnderAttack += 1;
    advance(CLOSE_BOUND_MS, attack);
    return record;
  };
  const chainSteps = () => {
    const chain = () => {
      for (const guest of chainers) {
        guest.write(2);
        guest.sync(random() < 0.8);
      }
    };
    for (const guest of chainers) guest.write(UPDATE_BURST);
    for (const kind of ["close", "open", "lock", "unlock", "discard", "open"] as const) {
      chain();
      command(kind, kind === "open" || kind === "discard" ? BOARD : undefined);
      observed.chainedCommands += 1;
      advance(20, chain);
      react();
    }
  };
  const raceRestart = () => {
    if (reference.presented !== BOARD || reference.locked || pending.size > 0 || restarting(racer)) return;
    if (!racer.synced) racer.sync();
    racer.sendRaw(new Uint8Array([0xff]));
    if (!restarting(racer)) return;
    observed.blankRestarts += 1;
    advance(50);
    racer.sync();
    observed.blankPhaseSyncs += 1;
    for (const writeId of racer.write(2)) {
      neverCommit.add(writeId);
      observed.blankPhaseWrites += 1;
    }
    advance(500);
    if (restarting(racer)) return;
    const before = racer.directStates().length;
    if (random() < 0.5) {
      racer.freshCopy();
      racer.sendRaw(EMPTY_UPDATE);
      advance(5000);
      if (racer.directStates().length === before) observed.recoveredByEmptyUpdate += 1;
    } else {
      racer.freshCopy();
      racer.sync();
      advance(5000);
      if (racer.directStates().length === before) observed.recoveredBySync += 1;
    }
  };

  const checkBoard = () => {
    const live = room.apps.liveDoc(BOARD);
    if (!live || reference.presented !== BOARD || pending.size > 0) return;
    const board = live.getMap("m");
    for (const [writeId, epoch] of mustCommit) {
      if (epoch !== reference.epoch) continue;
      expect(board.has(writeId), `eligible write ${writeId} committed`).toBe(true);
      observed.mustCommitVerified += 1;
      if (heldAcrossClose.delete(writeId)) observed.heldAcrossClose += 1;
      if (heldAcrossLeave.delete(writeId)) observed.heldAcrossLeave += 1;
    }
    for (const writeId of neverCommit) {
      expect(board.has(writeId), `unauthorized write ${writeId} kept out`).toBe(false);
      observed.neverCommitVerified += 1;
    }
  };
  const checkBudget = () => {
    const bySocket = new Map<string, number[]>();
    for (const call of calls) bySocket.set(call.socketId, [...(bySocket.get(call.socketId) ?? []), call.at]);
    observed.callsChecked = calls.length;
    for (const [socketId, times] of bySocket) {
      for (const window of [0, 500, 2000]) {
        const limit = UPDATE_BURST + Math.floor((UPDATES_PER_SECOND * window) / 1000) + 1;
        let first = 0;
        let most = 0;
        for (let last = 0; last < times.length; last += 1) {
          while (times[first] < times[last] - window) first += 1;
          most = Math.max(most, last - first + 1);
        }
        expect(most, `${socketId} within ${window} ms`).toBeLessThanOrEqual(limit);
        if (window === 2000 && most >= UPDATE_BURST) observed.budgetPressure += 1;
      }
    }
  };
  const checkControl = () => {
    for (const record of rooms.commands) {
      const wait = (record.ackedAt ?? Date.now()) - record.sentAt;
      if (record.kind === "open" || record.kind === "close") {
        expect(wait, `${record.kind} within ${CLOSE_BOUND_MS} ms`).toBeLessThanOrEqual(CLOSE_BOUND_MS);
      } else {
        expect(record.ackedAt, `${record.kind} answered in the same tick`).toBe(record.sentAt);
      }
    }
    for (const sync of rooms.syncs) {
      expect((sync.answeredAt ?? Date.now()) - sync.sentAt, "sync answered").toBeLessThanOrEqual(CLOSE_BOUND_MS);
    }
  };
  const checkSlots = () => {
    const slots = room.apps.scheduler.slotSummaries();
    expect(slots.length, "at most one slot per socket").toBeLessThanOrEqual(rooms.peers.size);
    observed.slotsChecked += slots.length;
    for (const slot of slots) {
      expect(slot.updates).toBeLessThanOrEqual(64);
      expect(slot.bytes).toBeLessThanOrEqual(256 * 1024);
      expect(slot.age).toBeLessThanOrEqual(1000);
    }
  };
  const checkRestarts = () => {
    for (const peer of rooms.peers.values()) {
      peer.received.forEach((entry, index) => {
        if (!entry.direct || !isBlank(entry)) return;
        const next = peer.received.slice(index + 1).find((later: Received) => later.event === "apps:state");
        if (next) {
          if (next.direct) expect(next.at - entry.at, `${peer.id} real stage after the blank`).toBe(500);
          return;
        }
        if (!peer.connected || peer.roomId !== entry.room) return;
        expect(Date.now() - entry.at, `${peer.id} still owed the real stage`).toBeLessThanOrEqual(501);
      });
    }
    for (const entry of switcher.received) {
      if (entry.room !== "room" && entry.direct) {
        expect(entry, "nothing from the old room reaches a client that moved").toBeUndefined();
      }
    }
  };
  const check = () => {
    checkBoard();
    checkBudget();
    checkControl();
    checkSlots();
    checkRestarts();
  };

  command("open", BOARD);
  for (const peer of rooms.peers.values()) peer.react();
  host.write(1, { blind: true });

  for (let step = 0; step < steps; step += 1) {
    if (reference.presented !== BOARD && pending.size === 0 && random() < 0.5) command("open", BOARD);
    if (reference.locked && random() < 0.3) probeLocked();
    const roll = random();
    if (roll < 0.3) honestWrite();
    else if (roll < 0.44) burst(pick(["wait", "close", "leave"] as const));
    else if (roll < 0.47) pick(honest).sync(random() < 0.7);
    else if (roll < 0.5) {
      const peer = pick(honest);
      peer.sync();
      if (eligible(peer) && buckets.get(peer.socketId)!.take(Date.now())) {
        const [writeId] = peer.write(1);
        mustCommit.set(writeId, reference.epoch);
      }
    } else if (roll < 0.53) {
      for (let round = 0; round < 20; round += 1) {
        adversary.write(1);
        adversary.sync(random() < 0.5);
      }
    } else if (roll < 0.56) probeLocked();
    else if (roll < 0.58) {
      attackWhile(
        () => {
          for (let index = 0; index < 50; index += 1) adversary.sendRaw(new Uint8Array([0xff]), "bomb");
        },
        "close",
      );
    } else if (roll < 0.6) {
      let serial = 0;
      attackWhile(
        () => {
          for (let index = 0; index < 20; index += 1) adversary.sendRaw(new Uint8Array([1]), `flood-${(serial += 1)}`);
        },
        pick(["close", "lock", "unlock", "discard"] as const),
        BOARD,
      );
    } else if (roll < 0.62 && reference.locked) {
      attackWhile(() => adversary.sendRaw(EMPTY_UPDATE), pick(["close", "unlock", "discard"] as const), BOARD);
    } else if (roll < 0.66) raceRestart();
    else if (roll < 0.68) chainSteps();
    else if (roll < 0.685) command("open", BOARD);
    else if (roll < 0.69) command("close");
    else if (roll < 0.695) command("open", "watch");
    else if (roll < 0.7) command("discard", BOARD);
    else if (roll < 0.715) command(reference.locked ? "unlock" : "lock");
    else if (roll < 0.75 && switcher.roomId === "room") {
      switcher.sync();
      switcher.write(UPDATE_BURST + 3);
      switcher.switchRoom("other-room");
    } else if (roll < 0.77) {
      const leaving = pick(honest.filter((peer) => peer.connected));
      if (leaving && honest.filter((peer) => peer.connected).length > 2) {
        leaving.leave();
        joinHonest().react();
      }
    } else advance(Math.floor(random() * 300));
    settleCommands();
    react();
    check();
  }

  advance(16_000);
  react();
  advance(200);
  check();

  const before = calls.length;
  room.close();
  rooms.roomFor("other-room").close();
  vi.advanceTimersByTime(60_000);
  expect(calls.length, "nothing written after the room closed").toBe(before);
  expect(room.apps.activeAppId).toBeNull();
  expect(vi.getTimerCount(), "no timers left after the rooms closed").toBe(0);

  return observed;
};

describe("the room apps model", () => {
  it.each([7, 270, 4242])("keeps every invariant, and observes each one, across seed %i", (seed) => {
    const observed = runModel(seed, 500);
    for (const [name, count] of Object.entries(observed)) {
      expect(count, `${name} observed`).toBeGreaterThan(0);
    }
  }, 120_000);
});


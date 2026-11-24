import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io";
import type { AppsState } from "../types.js";
import {
  BARRIER_DEADLINE_MS,
  MAX_SLOT_MS,
  RoomAppsScheduler,
  type SlotWrite,
  type WriteOutcome,
} from "../server/roomAppsScheduler.js";
import { RATE_LIMITS } from "../server/socket/rateLimit.js";
import { BOARD, UPDATE_BURST, isBlank, makeWorkRooms, recordWrites } from "./support/appsWorkRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());

const advance = (ms: number, each: () => void = () => {}) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 1) {
    each();
    vi.advanceTimersByTime(1);
  }
};

const waited = (record: { sentAt: number; ackedAt?: number | null; answeredAt?: number | null }) =>
  (record.ackedAt ?? record.answeredAt ?? Number.POSITIVE_INFINITY) - record.sentAt;

const boardHas = (room: { apps: { liveDoc(appId: string): Y.Doc | null } }, writeId: string) =>
  room.apps.liveDoc(BOARD)?.getMap("m").has(writeId) ?? false;

const presentedBoard = () => {
  vi.useFakeTimers();
  const rooms = makeWorkRooms();
  const host = rooms.connect("host#1", { host: true });
  host.command("open", BOARD);
  return { ...rooms, host, room: rooms.roomFor("room") };
};

describe("host controls whatever a guest sends", () => {
  it("answers Close within 150 ms while a guest sends a thousand malformed updates under one copy", () => {
    const { connect, host } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    guest.write(UPDATE_BURST);
    for (let index = 0; index < 1000; index += 1) guest.sendRaw(new Uint8Array([0xff]), "r1");

    const close = host.command("close");
    advance(150);

    expect(waited(close)).toBeLessThanOrEqual(150);
  });

  it("answers Lock in the same tick while a guest sends a thousand malformed updates under one copy", () => {
    const { connect, host } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    guest.write(UPDATE_BURST);
    for (let index = 0; index < 1000; index += 1) guest.sendRaw(new Uint8Array([0xff]), "r1");

    const lock = host.command("lock");

    expect(waited(lock)).toBe(0);
  });

  it("keeps Close, Clear, Unlock and a viewer's sync within their bounds while a guest sends packets to the locked board", () => {
    const { connect, host } = presentedBoard();
    const guest = connect("guest#1");
    const viewer = connect("viewer#1");
    guest.sync();
    viewer.sync();
    guest.write(UPDATE_BURST);
    guest.write(1);
    const lock = host.command("lock");
    guest.write(1);
    const spam = () => guest.sendRaw(EMPTY_UPDATE);

    const close = host.command("close");
    advance(200, spam);
    host.command("open", BOARD);
    host.command("lock");
    advance(5, spam);
    const sync = viewer.sync();
    const unlock = host.command("unlock");
    const clear = host.command("discard", BOARD);
    advance(200, spam);

    expect(waited(lock)).toBe(0);
    expect(waited(close)).toBeLessThanOrEqual(150);
    expect(waited(sync)).toBeLessThanOrEqual(150);
    expect(waited(unlock)).toBe(0);
    expect(waited(clear)).toBe(0);
  });

  it.each([
    ["an open board", false],
    ["a locked board", true],
  ])("answers Close within 150 ms while a guest floods distinct copies on %s", (_, locked) => {
    const { connect, host } = presentedBoard();
    if (locked) host.command("lock");
    const guest = connect("guest#1");
    guest.sync();

    for (let index = 0; index < 3600; index += 1) guest.sendRaw(new Uint8Array([index % 250]), `flood-${index}`);
    const close = host.command("close");
    advance(150);

    expect(waited(close)).toBeLessThanOrEqual(150);
  });

  it("refuses a change sent to the locked board after the no-op checks run out, so it never lands after Unlock", () => {
    const { connect, host, room } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    const before = Y.encodeStateVector(guest.doc);
    guest.write(1);
    const known = Y.encodeStateAsUpdate(guest.doc, before);
    host.command("lock");
    for (let index = 0; index < 40; index += 1) guest.sendRaw(known);
    const [whileLocked] = guest.write(1);

    host.command("unlock");
    advance(600);
    guest.sync();
    advance(1000, () => guest.react());

    const reasons = guest.received
      .filter((entry) => entry.event === "apps:yjs:refused")
      .map((entry) => (entry.payload as { reason: string }).reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(["locked"]));
    expect(boardHas(room, whileLocked)).toBe(false);
  });

  it("answers a viewer's sync, a Lock and a Clear in the same tick while another guest has writes held", () => {
    const { connect, host } = presentedBoard();
    const guest = connect("guest#1");
    const viewer = connect("viewer#1");
    guest.sync();
    guest.write(UPDATE_BURST + 5);

    const sync = viewer.sync();
    const lock = host.command("lock");
    const clear = host.command("discard", BOARD);

    expect(waited(sync)).toBe(0);
    expect(waited(lock)).toBe(0);
    expect(waited(clear)).toBe(0);
  });

  it("keeps every host command within its bound while ten guests chain bursts and syncs", () => {
    const { connect, host, commands } = presentedBoard();
    const guests = Array.from({ length: 10 }, (_, index) => connect(`guest${index}#1`));
    for (const guest of guests) {
      guest.sync();
      guest.write(UPDATE_BURST);
    }
    const chain = () => {
      for (const guest of guests) {
        guest.write(2);
        guest.sync();
      }
    };

    for (const [kind, appId] of [
      ["close", undefined],
      ["open", BOARD],
      ["lock", undefined],
      ["unlock", undefined],
      ["discard", BOARD],
      ["open", BOARD],
    ] as const) {
      chain();
      host.command(kind, appId);
      advance(30, chain);
      for (const guest of guests) guest.react();
    }
    advance(200);

    const issued = commands.filter((record) => record.peer === host.id).slice(1);
    expect(issued).toHaveLength(6);
    for (const record of issued) {
      const bound = record.kind === "open" || record.kind === "close" ? 150 : 0;
      expect(waited(record), `${record.kind} answered`).toBeLessThanOrEqual(bound);
      expect(record.reply).toMatchObject({ success: true });
    }
  });

  it("applies a participant's held strokes before the host closes the board", () => {
    const { connect, host, room } = presentedBoard();
    const artist = connect("artist#1");
    artist.sync();
    const strokes = artist.write(UPDATE_BURST + 20);

    host.command("close");
    advance(200);
    host.command("open", BOARD);
    advance(10);

    expect(strokes.filter((writeId) => !boardHas(room, writeId))).toEqual([]);
  });

  it("closes the room for good, with nothing held or queued left to run", () => {
    const { connect, host, room } = presentedBoard();
    const calls = recordWrites();
    const guest = connect("guest#1");
    guest.sync();
    guest.write(UPDATE_BURST + 1);
    const open = host.command("open", "watch");
    const before = calls.length;

    room.close();
    advance(10_000);

    expect(room.apps.activeAppId).toBeNull();
    expect(open.reply).toMatchObject({ success: false });
    expect(calls.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a sender's slot", () => {
  const starved = (): Socket => {
    const sender = {} as Socket;
    const { capacity, refillPerSec } = RATE_LIMITS.appsYjsUpdate;
    Reflect.set(
      sender,
      "__rateLimitBuckets",
      new Map([["apps:yjs:update", { capacity, refillPerSec, tokens: -1000, lastRefillMs: Date.now() }]]),
    );
    return sender;
  };
  const writesFor = (sender: Socket, key = "copy-1") => {
    const ran: Uint8Array[] = [];
    const finished: { outcome: WriteOutcome; at: number }[] = [];
    const write = (update: Uint8Array): SlotWrite => ({
      sender,
      appId: BOARD,
      key,
      host: false,
      update,
      run: (merged) => {
        ran.push(merged);
        return null;
      },
      finish: (outcome) => finished.push({ outcome, at: Date.now() }),
    });
    return { ran, finished, write };
  };
  const keyed = (doc: Y.Doc, key: string): Uint8Array => {
    const before = Y.encodeStateVector(doc);
    doc.getMap("m").set(key, true);
    return Y.encodeStateAsUpdate(doc, before);
  };

  it("refuses the held updates of a sender that cannot drain them by the barrier's deadline, then runs the command", () => {
    vi.useFakeTimers();
    const scheduler = new RoomAppsScheduler();
    const { ran, finished, write } = writesFor(starved());
    scheduler.submit(write(keyed(new Y.Doc(), "a")));
    const started = Date.now();
    let ranAt: number | null = null;

    scheduler.afterHeld(BOARD, () => (ranAt = Date.now()), () => {});
    vi.advanceTimersByTime(BARRIER_DEADLINE_MS);

    expect(ranAt).toBe(started + BARRIER_DEADLINE_MS);
    expect(finished).toEqual([{ outcome: "rate-limited", at: started + BARRIER_DEADLINE_MS }]);
    expect(ran).toEqual([]);
    expect(scheduler.slotSummaries()).toEqual([]);
  });

  it("refuses a slot once it has been held for its time limit, and leaves no timer behind", () => {
    vi.useFakeTimers();
    const scheduler = new RoomAppsScheduler();
    const { ran, finished, write } = writesFor(starved());
    const started = Date.now();
    scheduler.submit(write(keyed(new Y.Doc(), "a")));

    vi.advanceTimersByTime(MAX_SLOT_MS);

    expect(finished).toEqual([{ outcome: "rate-limited", at: started + MAX_SLOT_MS }]);
    expect(ran).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses the whole slot as one when its updates do not merge", () => {
    vi.useFakeTimers();
    const sender = {} as Socket;
    const scheduler = new RoomAppsScheduler();
    const { ran, finished, write } = writesFor(sender);
    const doc = new Y.Doc();
    for (let index = 0; index < UPDATE_BURST; index += 1) scheduler.submit(write(keyed(doc, `w${index}`)));
    ran.length = 0;
    finished.length = 0;

    scheduler.submit(write(keyed(doc, "held")));
    scheduler.submit(write(new Uint8Array([0xff])));
    scheduler.submit(write(keyed(doc, "after")));
    vi.advanceTimersByTime(1000);

    expect(finished.map((entry) => entry.outcome)).toEqual(["malformed"]);
    expect(ran).toEqual([]);
  });

  it("refuses an update from a second copy at once while the first copy's updates are held", () => {
    vi.useFakeTimers();
    const sender = {} as Socket;
    const scheduler = new RoomAppsScheduler();
    const first = writesFor(sender, "copy-1");
    const second = writesFor(sender, "copy-2");
    const doc = new Y.Doc();
    for (let index = 0; index <= UPDATE_BURST; index += 1) scheduler.submit(first.write(keyed(doc, `w${index}`)));

    scheduler.submit(second.write(keyed(new Y.Doc(), "other")));

    expect(second.finished).toEqual([{ outcome: "rate-limited", at: Date.now() }]);
    vi.advanceTimersByTime(1000);
    expect(first.finished.map((entry) => entry.outcome)).toEqual(new Array(UPDATE_BURST + 1).fill(null));
    expect(second.ran).toEqual([]);
  });

  it("refuses every held update and cancels every waiting command when the room closes", () => {
    vi.useFakeTimers();
    const scheduler = new RoomAppsScheduler();
    const { ran, finished, write } = writesFor(starved());
    scheduler.submit(write(keyed(new Y.Doc(), "a")));
    let executed = false;
    let cancelled = false;
    scheduler.afterHeld(BOARD, () => (executed = true), () => (cancelled = true));

    scheduler.close();
    scheduler.submit(write(keyed(new Y.Doc(), "late")));
    vi.advanceTimersByTime(10_000);

    expect(finished.map((entry) => entry.outcome)).toEqual(["not-live", "not-live"]);
    expect(ran).toEqual([]);
    expect([executed, cancelled]).toEqual([false, true]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the update budget", () => {
  it.each([
    ["an invalid sync", false],
    ["a valid sync", true],
  ])("never applies a socket's writes past its budget when %s follows each one", (_, valid) => {
    const { connect } = presentedBoard();
    const calls = recordWrites();
    const writer = connect("writer#1");
    writer.sync();
    writer.write(UPDATE_BURST);

    for (let round = 0; round < 100; round += 1) {
      writer.write(1);
      writer.sync(valid);
    }

    const applied = calls.filter((call) => call.socketId === writer.socketId).length;
    expect(applied).toBeGreaterThanOrEqual(UPDATE_BURST);
    expect(applied).toBeLessThanOrEqual(UPDATE_BURST + 1);
  });

  it("applies a sync and the update sent right after it in order while another guest has writes held", () => {
    const { connect, room } = presentedBoard();
    const alice = connect("alice#1");
    const bob = connect("bob#1");
    alice.sync();
    alice.write(UPDATE_BURST + 1);

    bob.sync();
    const [afterSync] = bob.write(1);
    advance(200);

    expect(bob.received.filter((entry) => entry.event === "apps:yjs:refused")).toEqual([]);
    expect(boardHas(room, afterSync)).toBe(true);
  });

  it("keeps a leaving participant's held strokes under the participant who wrote them", () => {
    const { connect, room } = presentedBoard();
    const calls = recordWrites();
    const artist = connect("artist#1");
    artist.sync();

    const strokes = artist.write(UPDATE_BURST + 20);
    artist.leave();
    advance(2000);

    expect(calls.filter((call) => call.socketId === artist.socketId).length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.result === "foreign-id")).toEqual([]);
    expect(strokes.filter((writeId) => !boardHas(room, writeId))).toEqual([]);
  });

  it("keeps a guest's two linked tabs writing as one participant, and their ids theirs", () => {
    const { connect, room } = presentedBoard();
    const calls = recordWrites();
    const first = connect("guest-gp_pass#tab-1");
    const second = connect("guest-gp_pass#tab-2", { legacy: true });
    const other = connect("guest-gp_other#tab-1");
    for (const tab of [first, second, other]) tab.sync();

    const strokes = [...first.write(3), ...second.write(3)];
    const firstClient = first.doc.clientID;
    strokes.push(...first.write(UPDATE_BURST + 10));
    first.leave();
    advance(2000);
    strokes.push(...second.write(2));
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(room.apps.liveDoc(BOARD)!));
    forger.clientID = firstClient;
    const before = Y.encodeStateVector(forger);
    forger.getMap("m").set("forged", true);
    other.sendRaw(Y.encodeStateAsUpdate(forger, before));
    advance(2000);

    const byParticipant = (participant: string) => calls.filter((call) => call.participant === participant);
    expect(byParticipant("guest-gp_pass").length).toBeGreaterThan(0);
    expect(byParticipant("guest-gp_pass").filter((call) => call.result !== null)).toEqual([]);
    expect(strokes.filter((writeId) => !boardHas(room, writeId))).toEqual([]);
    expect(byParticipant("guest-gp_other").map((call) => call.result)).toEqual(["foreign-id"]);
    expect(room.apps.liveDoc(BOARD)!.getMap("m").has("forged")).toBe(false);
  });
});

describe("restarting an older client's copy", () => {
  const refusedLegacy = () => {
    const rooms = presentedBoard();
    const legacy = rooms.connect("legacy#1", { legacy: true });
    legacy.sync();
    legacy.sendRaw(new Uint8Array([0xff]));
    return { ...rooms, legacy };
  };

  it("still sends the real stage when the client's own sync follows a refused held write", () => {
    const { connect, host } = presentedBoard();
    const legacy = connect("legacy#1", { legacy: true });
    legacy.sync();
    legacy.write(UPDATE_BURST);
    legacy.write(1);
    host.command("lock");
    legacy.write(1);
    legacy.sync();
    advance(1000);

    expect(legacy.directStates().map((entry) => (entry.payload as AppsState).activeAppId).slice(0, 2)).toEqual([
      null,
      BOARD,
    ]);
  });

  it("takes nothing from the client, sync included, until the real stage has gone out", () => {
    const { legacy, room } = refusedLegacy();
    expect(legacy.directStates().filter(isBlank)).toHaveLength(1);

    advance(100);
    legacy.sync();
    advance(100);
    const [sneaked] = legacy.write(1);
    advance(400);

    expect(boardHas(room, sneaked)).toBe(false);
    expect(legacy.directStates().map((entry) => (entry.payload as AppsState).activeAppId)).toEqual([null, BOARD]);
  });

  it("finishes when the restarted client's new copy sends its empty update, and never restarts it again", () => {
    const { legacy } = refusedLegacy();
    advance(600);
    expect(legacy.directStates()).toHaveLength(2);

    legacy.freshCopy();
    legacy.sendRaw(EMPTY_UPDATE);
    advance(15_000);

    expect(legacy.directStates().map((entry) => (entry.payload as AppsState).activeAppId)).toEqual([null, BOARD]);
  });

  it.each([
    ["closes and reopens the board", ["close", "open"]],
    ["locks the board", ["lock"]],
  ] as const)("keeps the client blank when the host %s before the real stage, then takes its writes", (_, kinds) => {
    const { legacy, host, room } = refusedLegacy();
    for (const kind of kinds) {
      advance(50);
      host.command(kind, kind === "open" ? BOARD : undefined);
    }
    const states = () => legacy.received.filter((entry) => entry.event === "apps:state");
    expect(isBlank(states().at(-1)!)).toBe(true);
    if (kinds.some((kind) => kind === "lock")) host.command("unlock");
    expect(isBlank(states().at(-1)!)).toBe(true);

    advance(600, () => legacy.react());
    const [stroke] = legacy.write(1);
    advance(5000, () => legacy.react());

    expect(boardHas(room, stroke)).toBe(true);
    expect(legacy.received.filter((entry) => entry.event === "apps:yjs:refused")).toEqual([]);
    expect(legacy.directStates().filter((entry) => !isBlank(entry))).toHaveLength(1);
  });

  it("sends nothing from the old room after the client moves to another room", () => {
    const { legacy } = refusedLegacy();
    expect(legacy.directStates().filter(isBlank)).toHaveLength(1);
    const seen = legacy.received.length;

    legacy.switchRoom("other-room");
    advance(15_000);

    expect(legacy.received.slice(seen).filter((entry) => entry.direct)).toEqual([]);
  });

  it("sends no refusal from the old room for a write that ran after the client moved", () => {
    const { connect } = presentedBoard();
    const named = connect("named#1");
    named.sync();
    named.write(UPDATE_BURST);
    named.sendRaw(new Uint8Array([0xff]));
    const seen = named.received.length;

    named.switchRoom("other-room");
    advance(200);

    expect(named.received.slice(seen).filter((entry) => entry.direct)).toEqual([]);
  });
});

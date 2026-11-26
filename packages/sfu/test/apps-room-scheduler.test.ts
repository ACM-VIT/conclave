import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io";
import type { AppsState } from "../types.js";
import {
  BARRIER_DEADLINE_MS,
  MAX_SLOT_MS,
  MAX_SLOT_UPDATES,
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
    const ran: Uint8Array[][] = [];
    const finished: { outcome: WriteOutcome; at: number }[] = [];
    const write = (update: Uint8Array): SlotWrite => ({
      sender,
      appId: BOARD,
      key,
      host: false,
      wire: { length: update.length, read: () => update },
      run: (updates) => {
        ran.push(updates);
        return updates.map(() => null);
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

    scheduler.afterHeld(BOARD, { changes: () => true, run: () => (ranAt = Date.now()), cancel: () => {} });
    vi.advanceTimersByTime(BARRIER_DEADLINE_MS);

    expect(ranAt).toBe(started + BARRIER_DEADLINE_MS);
    expect(finished).toEqual([{ outcome: "rate-limited", at: started + BARRIER_DEADLINE_MS }]);
    expect(ran).toEqual([]);
    expect(scheduler.slotSummaries()).toEqual([]);
  });

  it("answers a waiting command that stops changing the stage at once, and refuses none of the held updates", () => {
    vi.useFakeTimers();
    const scheduler = new RoomAppsScheduler();
    const { ran, finished, write } = writesFor(starved());
    scheduler.submit(write(keyed(new Y.Doc(), "a")));
    let changes = true;
    let ranAt: number | null = null;
    scheduler.afterHeld(BOARD, { changes: () => changes, run: () => (ranAt = Date.now()), cancel: () => {} });
    vi.advanceTimersByTime(10);
    const changedAt = Date.now();

    scheduler.transition({ apply: () => (changes = false), notify: () => {} });
    vi.advanceTimersByTime(BARRIER_DEADLINE_MS);

    expect(ranAt).toBe(changedAt);
    expect(finished).toEqual([]);
    expect(ran).toEqual([]);
    expect(scheduler.slotSummaries()).toHaveLength(1);
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

  it("refuses the whole slot as malformed when its updates do not merge, and settles each update", () => {
    const { connect, room } = presentedBoard();
    const writer = connect("writer#1");
    writer.sync();
    writer.write(UPDATE_BURST);
    const settled = vi.spyOn(room.apps.scheduler as unknown as { finish: (...args: unknown[]) => void }, "finish");

    const [held] = writer.write(1);
    writer.sendRaw(new Uint8Array([0xff]));
    const [after] = writer.write(1);
    advance(1000);

    const refusals = writer.received.filter((entry) => entry.event === "apps:yjs:refused");
    expect(refusals.map((entry) => (entry.payload as { reason: string }).reason)).toEqual(["malformed"]);
    expect(settled.mock.calls.map(([, outcome]) => outcome)).toEqual(["malformed", "malformed", "malformed"]);
    expect([boardHas(room, held), boardHas(room, after)]).toEqual([false, false]);
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
    scheduler.afterHeld(BOARD, { changes: () => true, run: () => (executed = true), cancel: () => (cancelled = true) });

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

describe("a control command the room refuses or that changes nothing", () => {
  type Rooms = ReturnType<typeof presentedBoard>;
  const stale = (room: Rooms["room"]) => room.apps.stageRevision + 5;

  it.each([
    ["a stale Present of another app", (host: Rooms["host"], room: Rooms["room"]) => host.command("open", "watch", stale(room)), false],
    ["a repeated Present of the board", (host: Rooms["host"]) => host.command("open", BOARD), true],
    ["a repeated Present of the board under a stale revision", (host: Rooms["host"], room: Rooms["room"]) => host.command("open", BOARD, stale(room)), true],
    ["a stale Close", (host: Rooms["host"], room: Rooms["room"]) => host.command("close", undefined, stale(room)), false],
    ["a stale Clear", (host: Rooms["host"], room: Rooms["room"]) => host.command("discard", BOARD, stale(room)), false],
    ["a stale Lock", (host: Rooms["host"], room: Rooms["room"]) => host.command("lock", undefined, stale(room)), false],
    ["an Unlock of an open board", (host: Rooms["host"]) => host.command("unlock"), true],
  ] as const)("answers %s at once and drops none of the strokes a writer holds or sends next", (_, send, succeeds) => {
    const { connect, host, room } = presentedBoard();
    const artist = connect("artist#1");
    artist.sync();
    const strokes = artist.write(UPDATE_BURST + 10);
    const before = JSON.stringify(room.apps.snapshot());
    const seen = artist.received.length;

    const record = send(host, room);
    strokes.push(...artist.write(5));
    const during = JSON.stringify(room.apps.snapshot());
    advance(500);

    expect(waited(record)).toBe(0);
    expect(record.reply).toMatchObject(succeeds ? { success: true } : { success: false, code: "stale_revision" });
    expect([during, JSON.stringify(room.apps.snapshot())]).toEqual([before, before]);
    expect(artist.received.slice(seen).filter((entry) => entry.event !== "apps:yjs:update")).toEqual([]);
    expect(strokes.filter((writeId) => !boardHas(room, writeId))).toEqual([]);
  });

  it("answers a waiting Present once another change makes it stale, and drops none of the strokes held or sent meanwhile", () => {
    const { host, room } = presentedBoard();
    host.sync();
    const strokes = host.write(UPDATE_BURST + 10);
    const present = host.command("open", "watch", room.apps.stageRevision);
    strokes.push(...host.write(3));

    const lock = host.command("lock");
    advance(500);

    expect([waited(lock), waited(present)]).toEqual([0, 0]);
    expect(present.reply).toMatchObject({ success: false, code: "stale_revision" });
    expect(room.apps.activeAppId).toBe(BOARD);
    expect(host.received.filter((entry) => entry.event === "apps:yjs:refused")).toEqual([]);
    expect(strokes.filter((writeId) => !boardHas(room, writeId))).toEqual([]);
  });

  it("broadcasts and answers a Lock with the stage it made, even when it lets a waiting Close run", () => {
    const { connect, host, room } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    guest.write(UPDATE_BURST + 10);
    const close = host.command("close");
    const seen = host.received.length;

    const lock = host.command("lock");

    const stages = host.received
      .slice(seen)
      .filter((entry) => entry.event === "apps:state")
      .map((entry) => {
        const stage = entry.payload as AppsState;
        return [stage.activeAppId, stage.locked];
      });
    expect(stages).toEqual([
      [BOARD, true],
      [null, false],
    ]);
    expect(lock.reply).toMatchObject({ success: true, locked: true });
    expect(close.reply).toMatchObject({ success: true });
    expect(room.apps.activeAppId).toBeNull();
  });

  it("gives back a socket's first valid sync after each stage change, and charges a sync refused for its content", () => {
    const { connect, host } = presentedBoard();
    const viewer = connect("viewer#1");
    viewer.sync();
    for (let round = 0; round < 8; round += 1) {
      host.command(round % 2 === 0 ? "lock" : "unlock");
      expect(viewer.sync().reply).toHaveProperty("syncMessage");
    }

    expect(viewer.sync(false).reply).toHaveProperty("error");
    const answered = Array.from({ length: 12 }, () => viewer.sync().reply);

    expect(answered.filter((reply) => (reply as object) && "syncMessage" in (reply as object))).toHaveLength(9);
  });
});

describe("cheap admission before any parsing", () => {
  const counting = (length: number) => {
    const reads = { count: 0 };
    const payload = new Proxy(new Array<number>(length).fill(0), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^[0-9]+$/.test(key)) reads.count += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { reads, payload };
  };
  const flood = (send: (payload: unknown) => void, length = 1000) => {
    const reads = { count: 0 };
    for (let index = 0; index < 100; index += 1) {
      const sent = counting(length);
      send(sent.payload);
      reads.count += sent.reads.count;
    }
    return reads.count;
  };

  it("parses nothing from syncs sent after the socket's sync budget is gone", () => {
    const { connect } = presentedBoard();
    const viewer = connect("viewer#1");
    for (let index = 0; index < 12; index += 1) viewer.sync();
    const before = viewer.sync();
    expect(before.reply).toMatchObject({ retryable: true });

    const reads = flood((payload) => viewer.syncPayload(payload), 60_000);

    expect(reads).toBe(0);
  });

  it("parses nothing from updates sent after the sender's slot is full", () => {
    const { connect } = presentedBoard();
    const writer = connect("writer#1");
    writer.sync();
    writer.write(UPDATE_BURST + 64);

    const reads = flood((payload) => writer.sendPayload(payload));

    expect(reads).toBe(0);
  });

  it.each([
    ["a locked board", true],
    ["a board the guest has not synced", false],
  ])("parses nothing from updates to %s sent after the no-op checks run out", (_, locked) => {
    const { connect, host } = presentedBoard();
    const guest = connect("guest#1");
    if (locked) {
      guest.sync();
      host.command("lock");
    }
    for (let index = 0; index < 20; index += 1) guest.sendRaw(new Uint8Array([0xff]));

    const reads = flood((payload) => guest.sendPayload(payload));

    expect(reads).toBe(0);
  });

  it("parses nothing from awareness sent after the socket's awareness budget is gone", () => {
    const { connect } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    for (let index = 0; index < 40; index += 1) guest.awarenessPayload(new Uint8Array([0]));

    const reads = flood((payload) => guest.awarenessPayload(payload));

    expect(reads).toBe(0);
  });

  it.each([
    ["an update", (peer: ReturnType<ReturnType<typeof makeWorkRooms>["connect"]>, payload: unknown) => peer.sendPayload(payload), 256 * 1024],
    ["a sync", (peer: ReturnType<ReturnType<typeof makeWorkRooms>["connect"]>, payload: unknown) => peer.syncPayload(payload), 64 * 1024],
    ["an awareness packet", (peer: ReturnType<ReturnType<typeof makeWorkRooms>["connect"]>, payload: unknown) => peer.awarenessPayload(payload), 64 * 1024],
  ] as const)("refuses %s past its size cap before reading it", (_, send, cap) => {
    const { connect } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    const oversized = counting(cap + 1);

    send(guest, oversized.payload);

    expect(oversized.reads.count).toBe(0);
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

    const states = legacy.directStates().map((entry) => (entry.payload as AppsState).activeAppId);
    expect(states.at(-1)).toBe(BOARD);
    expect(states.slice(0, -1).every((activeAppId) => activeAppId === null)).toBe(true);
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

  it("shows the client the app a waiting Present puts up when a Lock lets it run inside the blank phase", () => {
    const { host, room, legacy } = refusedLegacy();
    host.sync();
    host.write(UPDATE_BURST + 5);
    const present = host.command("open", "watch");
    vi.setSystemTime(Date.now() + 40);

    host.command("lock");
    advance(1000, () => legacy.react());

    const shown = legacy.received.filter((entry) => entry.event === "apps:state").at(-1)!;
    expect([room.apps.activeAppId, (shown.payload as AppsState).activeAppId]).toEqual(["watch", "watch"]);
    expect(present.reply).toMatchObject({ success: true });
  });

  it("shows the client the app a waiting Present puts up when the client's own refusal lets it run", () => {
    const { connect, host, room } = presentedBoard();
    const legacy = connect("legacy#1", { legacy: true });
    legacy.sync();
    legacy.write(UPDATE_BURST + 5);
    const present = host.command("open", "watch");

    legacy.sendPayload(new Uint8Array(256 * 1024 + 1));
    advance(1000, () => legacy.react());

    const shown = legacy.received.filter((entry) => entry.event === "apps:state").at(-1)!;
    expect([room.apps.activeAppId, (shown.payload as AppsState).activeAppId]).toEqual(["watch", "watch"]);
    expect(present.reply).toMatchObject({ success: true });
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

describe("what a payload costs before it is paid for", () => {
  it("rejects an oversized app id instead of normalizing it into a stage command", () => {
    vi.useFakeTimers();
    const { connect, roomFor } = makeWorkRooms();
    const host = connect("host#1", { host: true });
    const oversized = BOARD.padStart(129);

    expect(host.command("open", oversized).reply).toEqual({ success: false, error: "Invalid app id" });
    expect(roomFor("room").apps.activeAppId).toBeNull();
    expect(host.command("open", ` ${BOARD} `).reply).toMatchObject({ success: true, activeAppId: BOARD });
  });

  const countingArray = (length: number, last: unknown) => {
    const reads = { count: 0 };
    const target: unknown[] = new Array<unknown>(length).fill(0);
    target[length - 1] = last;
    const payload = new Proxy(target, {
      get(inner, key, receiver) {
        if (typeof key === "string" && /^[0-9]+$/.test(key)) reads.count += 1;
        return Reflect.get(inner, key, receiver) as unknown;
      },
    });
    return { reads, payload };
  };
  const restores: (() => void)[] = [];
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });
  const stringScans = (frame: string) => {
    let count = 0;
    const seen = (value: unknown) => {
      if (typeof value === "string" && value.length > 0 && frame.includes(value)) count += 1;
    };
    const test = Object.getOwnPropertyDescriptor(RegExp.prototype, "test")?.value as typeof RegExp.prototype.test;
    const exec = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec")?.value as typeof RegExp.prototype.exec;
    const trim = Object.getOwnPropertyDescriptor(String.prototype, "trim")?.value as typeof String.prototype.trim;
    const from = Object.getOwnPropertyDescriptor(Buffer, "from")?.value as typeof Buffer.from;
    RegExp.prototype.test = function (this: RegExp, value: string) {
      seen(value);
      return test.call(this, value);
    };
    RegExp.prototype.exec = function (this: RegExp, value: string) {
      seen(value);
      return exec.call(this, value);
    };
    String.prototype.trim = function (this: string) {
      seen(String(this));
      return trim.call(this);
    };
    Buffer.from = ((value: unknown, ...rest: unknown[]) => {
      seen(value);
      return (from as (...args: unknown[]) => Buffer)(value, ...rest);
    }) as typeof Buffer.from;
    restores.push(() => {
      RegExp.prototype.test = test;
      RegExp.prototype.exec = exec;
      String.prototype.trim = trim;
      Buffer.from = from;
    });
    return () => count;
  };
  const drained = () => {
    const { connect, room } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    guest.write(UPDATE_BURST);
    return { guest, room };
  };

  it.each([
    ["a 10,000-element array ending in a string", () => countingArray(10_000, "bad")],
    ["a JSON Buffer ending in null", () => {
      const inner = countingArray(10_000, null);
      return { reads: inner.reads, payload: { type: "Buffer", data: inner.payload } };
    }],
  ])("reads nothing of %s while the sender's update budget is spent, and reads it once when its slot drains", (_, make) => {
    const { guest } = drained();
    const sent = Array.from({ length: 20 }, () => make());

    for (const { payload } of sent) guest.sendPayload(payload);
    const readAtArrival = sent.reduce((total, { reads }) => total + reads.count, 0);
    advance(1000);

    expect(readAtArrival).toBe(0);
    expect(sent.map(({ reads }) => reads.count)).toEqual(sent.map(() => 10_000));
    expect(guest.received.filter((entry) => entry.event === "apps:yjs:refused").map((entry) => (entry.payload as { reason: string }).reason)).toEqual(["invalid"]);
  });

  it("reads none of Neon's invalid base64 updates while the sender's budget is spent", () => {
    const { guest } = drained();
    const frame = `${"A".repeat(349_519)}!`;
    const scans = stringScans(frame);

    for (let index = 0; index < 20; index += 1) guest.sendPayload(frame);

    expect(scans()).toBe(0);
  });

  it.each([
    ["900,000 spaces then AAAA (Greptile's frame)", `${" ".repeat(900_000)}AAAA`, 10],
    ["1,000 spaces then AAAA", `${" ".repeat(1000)}AAAA`, 100],
    ["AAAA then 1,000 newlines", `AAAA${"\n".repeat(1000)}`, 100],
  ])("reads no characters of %s before the sender pays, and refuses it", (_, frame, frames) => {
    const { guest } = drained();
    const scans = stringScans(frame);

    for (let index = 0; index < frames; index += 1) guest.sendPayload(frame);
    const atArrival = scans();
    advance(1000);

    expect(atArrival).toBe(0);
    expect(scans()).toBeLessThanOrEqual(4 * MAX_SLOT_UPDATES);
    const reasons = guest.received.filter((entry) => entry.event === "apps:yjs:refused").map((entry) => (entry.payload as { reason: string }).reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.filter((reason) => !["invalid", "too-large", "rate-limited"].includes(reason))).toEqual([]);
  });

  it("takes native's empty update in base64 as the free empty update on a locked board", () => {
    const { connect, host } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    host.command("lock");
    for (let index = 0; index < 20; index += 1) guest.sendRaw(new Uint8Array([0xff, index]));
    const before = guest.received.length;

    guest.sendPayload(Buffer.from([0, 0]).toString("base64"));

    expect(Buffer.from([0, 0]).toString("base64")).toBe("AAA=");
    const answered = guest.received.slice(before).filter((entry) => entry.direct);
    expect(answered.filter((entry) => entry.event === "apps:yjs:refused" || entry.event === "apps:state")).toEqual([]);
  });
});

describe("a sync's budget across stage changes", () => {
  const counting = (length: number) => {
    const reads = { count: 0 };
    const payload = new Proxy(new Array<number>(length).fill(0), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^[0-9]+$/.test(key)) reads.count += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { reads, payload };
  };
  const spent = () => {
    const rooms = presentedBoard();
    const viewer = rooms.connect("viewer#1");
    for (let index = 0; index < 12; index += 1) viewer.sync();
    expect(viewer.sync().reply).toMatchObject({ retryable: true });
    return { ...rooms, viewer };
  };

  it("reads nothing of the syncs a spent socket sends right after a stage change", () => {
    const { host, viewer } = spent();
    host.command("lock");
    let reads = 0;

    for (let index = 0; index < 20; index += 1) {
      const sent = counting(60_000);
      viewer.syncPayload(sent.payload);
      reads += sent.reads.count;
    }

    expect(reads).toBe(0);
  });

  it.each([
    ["a payload that is not a state vector", "%%%"],
    ["a state vector that does not decode", Uint8Array.from([5])],
  ])("gives no token back for an invalid first sync of a new stage: %s", (_, payload) => {
    const { host, viewer } = spent();
    vi.advanceTimersByTime(500);
    host.command("lock");

    expect(viewer.syncPayload(payload).reply).toEqual({ error: "Invalid sync payload" });
    expect(viewer.sync().reply).toMatchObject({ retryable: true });
  });
});

describe("the order a stage change tells a writer", () => {
  it.each([
    ["Lock", "lock" as const, "locked"],
    ["Clear", "discard" as const, "not-live"],
  ])("sends the refusal of a held update before the stage on %s", (_, kind, reason) => {
    const { connect, host } = presentedBoard();
    const guest = connect("guest#1");
    guest.sync();
    guest.write(UPDATE_BURST + 1);
    const before = guest.received.length;

    host.command(kind, kind === "discard" ? BOARD : undefined);

    const told = guest.received.slice(before).filter((entry) => entry.event === "apps:yjs:refused" || entry.event === "apps:state");
    expect(told.map((entry) => entry.event)).toEqual(["apps:yjs:refused", "apps:state"]);
    expect((told[0].payload as { reason: string }).reason).toBe(reason);
  });
});

describe("what a stage change leaves behind", () => {
  it.each([
    ["while its blank is out", () => {}],
    ["while it waits for the client's sync", () => advance(500)],
  ])("ends an older client's copy restart when the room closes %s", (_, wait) => {
    const { connect, room } = presentedBoard();
    const legacy = connect("legacy#1", { legacy: true });
    legacy.sync();
    legacy.sendRaw(new Uint8Array([0xff]));
    wait();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const before = legacy.received.length;

    room.close();

    expect(vi.getTimerCount()).toBe(0);
    advance(10_000);
    expect(legacy.received.slice(before).filter((entry) => entry.direct)).toEqual([]);
  });

  it("refuses an update held for the outgoing app by a sender the Present did not wait for", () => {
    const { connect, host, room } = presentedBoard();
    const first = connect("first#1");
    const late = connect("late#1");
    first.sync();
    late.sync();
    first.write(UPDATE_BURST + 1);
    advance(20);
    late.write(UPDATE_BURST);
    const present = host.command("open", "watch");
    late.write(1);
    expect(room.apps.scheduler.slotSummaries()).toHaveLength(2);

    advance(BARRIER_DEADLINE_MS, () => {
      if (present.reply === undefined) return;
      expect(room.apps.scheduler.slotSummaries()).toEqual([]);
    });

    expect(present.reply).toMatchObject({ success: true });
    expect(room.apps.activeAppId).toBe("watch");
    expect(late.received.filter((entry) => entry.event === "apps:yjs:refused").map((entry) => (entry.payload as { reason: string }).reason)).toEqual(["not-live"]);
  });
});

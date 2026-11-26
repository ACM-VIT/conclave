import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Socket } from "socket.io";
import type { DocumentExecutor } from "../server/roomApps.js";
import {
  BARRIER_DEADLINE_MS,
  MAX_SLOT_MS,
  MAX_SLOT_UPDATES,
  RoomAppsScheduler,
  type Pending,
  type SlotWrite,
  type WriteOutcome,
} from "../server/roomAppsScheduler.js";
import type { WireBytes } from "../server/socket/wireBytes.js";
import { RATE_LIMITS } from "../server/socket/rateLimit.js";
import type { AppsState } from "../types.js";
import { BOARD, UPDATE_BURST, makeWorkRooms } from "./support/appsWorkRoom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

type Settled = { id: number; outcome: WriteOutcome };

const writer = (
  sender: Socket,
  run: (updates: Uint8Array[]) => Pending<WriteOutcome[]>,
  options: { key?: string; appId?: string; host?: boolean } = {},
) => {
  const settled: Settled[] = [];
  let next = 0;
  const write = (update: Uint8Array | null = new Uint8Array([0, 0])): [SlotWrite, WireBytes] => {
    const id = (next += 1);
    return [{
      sender,
      appId: options.appId ?? BOARD,
      key: options.key ?? "copy-1",
      host: options.host ?? false,
      run,
      finish: (outcome) => settled.push({ id, outcome }),
    }, { length: update?.length ?? 2, read: () => update }];
  };
  return { settled, write, sent: () => next };
};

const allLanded = (updates: Uint8Array[]): WriteOutcome[] => updates.map(() => null);

const onceEach = (settled: Settled[], count: number) => {
  expect(settled.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
    Array.from({ length: count }, (_, index) => index + 1),
  );
};

describe("every held update reaches exactly one terminal outcome", () => {
  const paths: [string, (scheduler: RoomAppsScheduler) => { settled: Settled[]; sent: () => number }, WriteOutcome[]][] = [
    [
      "drained by a synchronous executor",
      (scheduler) => {
        const sender = {} as Socket;
        const w = writer(sender, allLanded);
        for (let index = 0; index < UPDATE_BURST + 5; index += 1) scheduler.submit(...w.write());
        vi.advanceTimersByTime(1000);
        return w;
      },
      [null],
    ],
    [
      "refused for overflowing the slot or for another copy",
      (scheduler) => {
        const sender = starved();
        const w = writer(sender, allLanded);
        const other = writer(sender, allLanded, { key: "copy-2" });
        for (let index = 0; index < MAX_SLOT_UPDATES + 3; index += 1) scheduler.submit(...w.write());
        scheduler.submit(...w.write(new Uint8Array(256 * 1024)));
        other.settled.length = 0;
        scheduler.submit(...other.write());
        expect(other.settled.map((entry) => entry.outcome)).toEqual(["rate-limited"]);
        scheduler.close();
        return w;
      },
      ["rate-limited", "not-live"],
    ],
    [
      "expired after the slot's time limit",
      (scheduler) => {
        const w = writer(starved(), allLanded);
        for (let index = 0; index < 5; index += 1) scheduler.submit(...w.write());
        vi.advanceTimersByTime(MAX_SLOT_MS);
        return w;
      },
      ["rate-limited"],
    ],
    [
      "evicted at a barrier's deadline",
      (scheduler) => {
        const w = writer(starved(), allLanded);
        for (let index = 0; index < 5; index += 1) scheduler.submit(...w.write());
        scheduler.afterHeld(BOARD, { changes: () => true, run: () => {}, cancel: () => {} });
        vi.advanceTimersByTime(BARRIER_DEADLINE_MS);
        return w;
      },
      ["rate-limited"],
    ],
    [
      "purged by a stage change",
      (scheduler) => {
        const w = writer(starved(), allLanded);
        for (let index = 0; index < 5; index += 1) scheduler.submit(...w.write());
        scheduler.transition({ refuse: { matches: () => true, outcome: "locked" }, apply: () => {}, notify: () => {} });
        return w;
      },
      ["locked"],
    ],
    [
      "refused when the room closes, held or running",
      (scheduler) => {
        const sender = {} as Socket;
        const w = writer(sender, () => new Promise<WriteOutcome[]>(() => {}));
        for (let index = 0; index < 5; index += 1) scheduler.submit(...w.write());
        scheduler.close();
        scheduler.submit(...w.write());
        return w;
      },
      ["not-live"],
    ],
    [
      "unreadable when its slot drains",
      (scheduler) => {
        const w = writer({} as Socket, allLanded);
        scheduler.submit(...w.write(null));
        scheduler.submit(...w.write(new Uint8Array([1, 2, 3])));
        return w;
      },
      ["invalid", null],
    ],
    [
      "given an executor that throws, rejects or answers short",
      (scheduler) => {
        const sender = {} as Socket;
        let calls = 0;
        const w = writer(sender, (updates) => {
          calls += 1;
          if (calls === 1) throw new Error("executor bug");
          if (calls === 2) return Promise.reject(new Error("worker crashed"));
          return updates.slice(1).map(() => null);
        });
        for (let index = 0; index < 3; index += 1) scheduler.submit(...w.write());
        return w;
      },
      ["invalid"],
    ],
  ];

  it.each(paths)("when %s", async (_, act, outcomes) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new RoomAppsScheduler();

    const { settled, sent } = act(scheduler);
    await vi.advanceTimersByTimeAsync(2000);
    scheduler.close();
    await vi.advanceTimersByTimeAsync(10);

    onceEach(settled, sent());
    for (const outcome of outcomes) expect(settled.some((entry) => entry.outcome === outcome)).toBe(true);
  });
});

const delayed = (inner: DocumentExecutor, ms: number) => {
  const seen = { writes: 0, running: 0, most: 0, syncs: 0, checks: 0 };
  const executor: DocumentExecutor = {
    write: async (appId, identity, updates) => {
      seen.writes += 1;
      seen.running += 1;
      seen.most = Math.max(seen.most, seen.running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      seen.running -= 1;
      return inner.write(appId, identity, updates);
    },
    sync: async (appId, stateVector) => {
      seen.syncs += 1;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return inner.sync(appId, stateVector);
    },
    changesNothing: async (appId, update) => {
      seen.checks += 1;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return inner.changesNothing(appId, update);
    },
  };
  return { executor, seen };
};

const asyncRoom = (ms: number) => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const rooms = makeWorkRooms();
  const room = rooms.roomFor("room");
  const { executor, seen } = delayed(room.apps.executor, ms);
  room.apps.executor = executor;
  const host = rooms.connect("host#1", { host: true });
  host.command("open", BOARD);
  return { ...rooms, room, host, seen };
};

const countFinishes = (scheduler: RoomAppsScheduler): WriteOutcome[] => {
  const outcomes: WriteOutcome[] = [];
  const submit = scheduler.submit.bind(scheduler);
  vi.spyOn(scheduler, "submit").mockImplementation((write, wire) =>
    submit({
      ...write,
      finish: (outcome) => {
        outcomes.push(outcome);
        write.finish(outcome);
      },
    }, wire),
  );
  return outcomes;
};

const settle = async (ms: number, each: () => void = () => {}) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 1) {
    each();
    await vi.advanceTimersByTimeAsync(1);
  }
};

describe("an executor that answers later", () => {
  it("relays an in-flight write to the replacement copy even after it has synced", async () => {
    vi.useFakeTimers();
    const { connect, roomFor } = makeWorkRooms();
    const room = roomFor("room");
    const inner = room.apps.executor;
    const { executor } = delayed(inner, 50);
    room.apps.executor = { ...executor, sync: inner.sync.bind(inner) };
    connect("host#1", { host: true }).command("open", BOARD);
    const artist = connect("artist#1");
    const viewer = connect("viewer#1");
    artist.sync();
    viewer.sync();
    const [inFlight] = artist.write(1);

    artist.sendPayload([]);
    expect(artist.sync().reply).toHaveProperty("syncMessage");
    expect(artist.doc.getMap("m").has(inFlight)).toBe(false);

    await settle(60);

    expect(viewer.doc.getMap("m").has(inFlight)).toBe(true);
    expect(artist.doc.getMap("m").toJSON()).toEqual(viewer.doc.getMap("m").toJSON());
  });

  it("answers a sync once the executor does, and still gives the stage's first valid sync back", async () => {
    const { connect, seen } = asyncRoom(20);
    const viewer = connect("viewer#1");

    const record = viewer.sync();
    expect(record.reply).toBeUndefined();
    await settle(25);

    expect(record.reply).toHaveProperty("syncMessage");
    expect(viewer.synced).toBe(true);
    expect(seen.syncs).toBe(1);
  });

  it("runs one write job at a time, lands every write once and in order, and relays each", async () => {
    const { connect, room, seen } = asyncRoom(5);
    const writerPeer = connect("writer#1");
    const viewer = connect("viewer#1");
    await settle(30, () => {
      writerPeer.react();
      viewer.react();
    });

    const ids: string[] = [];
    for (let index = 0; index < UPDATE_BURST * 2; index += 1) {
      ids.push(...writerPeer.write(1));
      await settle(2, () => viewer.react());
    }
    await settle(1000, () => viewer.react());

    const board = room.apps.liveDoc(BOARD)!.getMap("m");
    expect(ids.filter((id) => !board.has(id))).toEqual([]);
    expect(seen.most).toBe(1);
    expect(seen.writes).toBeLessThan(ids.length);
    expect(ids.filter((id) => !viewer.doc.getMap("m").has(id))).toEqual([]);
    expect(writerPeer.received.filter((entry) => entry.event === "apps:yjs:refused")).toEqual([]);
  });

  it("holds a Close for a running write job, then closes once it lands", async () => {
    const { connect, host, room } = asyncRoom(30);
    const writerPeer = connect("writer#1");
    await settle(40, () => writerPeer.react());
    const [id] = writerPeer.write(1);

    const close = host.command("close");
    await settle(10);
    expect(close.reply).toBeUndefined();
    await settle(40);

    expect(close.reply).toMatchObject({ success: true });
    expect(room.apps.activeAppId).toBeNull();
    host.command("open", BOARD);
    expect(room.apps.liveDoc(BOARD)!.getMap("m").has(id)).toBe(true);
  });

  it("runs a Close at the barrier deadline when the running job is slower, and settles that job once", async () => {
    const { connect, host, room } = asyncRoom(400);
    const writerPeer = connect("writer#1");
    await settle(450, () => writerPeer.react());
    const settled = countFinishes(room.apps.scheduler);
    writerPeer.write(1);

    const close = host.command("close");
    await settle(BARRIER_DEADLINE_MS + 5);
    expect(close.reply).toMatchObject({ success: true });
    await settle(400);

    expect(settled).toHaveLength(1);
    expect(room.apps.scheduler.running).toBe(false);
  });

  it("refuses a running job's updates once when the room closes, and ignores the late answer", async () => {
    const { connect, room } = asyncRoom(50);
    const writerPeer = connect("writer#1");
    const viewer = connect("viewer#1");
    await settle(60, () => {
      writerPeer.react();
      viewer.react();
    });
    const settled = countFinishes(room.apps.scheduler);
    writerPeer.write(3);

    room.close();
    await settle(200);

    expect(settled).toEqual(["not-live", "not-live", "not-live"]);
    expect(viewer.received.filter((entry) => entry.event === "apps:yjs:update" && !entry.direct)).toEqual([]);
  });

  it("answers an unsynced guest's change-nothing update with the room's copy once the executor decides", async () => {
    const { connect, host, seen } = asyncRoom(10);
    await settle(15, () => host.react());
    host.write(1);
    const guest = connect("guest#1");
    const before = guest.received.length;

    guest.sendRaw(Y.encodeStateAsUpdate(host.doc));
    await settle(40);

    const pushes = guest.received.slice(before).filter((entry) => entry.event === "apps:yjs:update" && entry.direct);
    expect(seen.checks).toBeGreaterThanOrEqual(1);
    expect(pushes).toHaveLength(1);
    expect((guest.received.filter((entry) => entry.event === "apps:state").at(-1)?.payload as AppsState).activeAppId).toBe(BOARD);
  });
});

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostReason } from "../config/classes/Room.js";
import {
  createFileRoomRecoveryStore,
  createMemoryRoomRecoveryStore,
  createRoomRecoveryLedger,
  type RoomRecoveryStore,
} from "../server/roomRecoveryLedger.js";
import { Logger } from "../utilities/loggers.js";

const CHANNEL = "conclave:abc-mnop-xyz";
const MINUTE_MS = 60_000;
const NOTHING_KNOWN = { lost: null, passesVoidUntil: null, lastWriter: null, owner: null };
const GUEST_MADE = { email: null };
const room = {
  channelId: CHANNEL,
  incarnationId: "room-1",
  takesOverRecordOf: null,
  ownerEmail: null,
  hostReasons: new Map<string, HostReason>([
    ["host@example.com", "opener"],
    ["guest-cohost", "cohost"],
  ]),
  hostUserKey: "host@example.com",
  adminUserKeys: new Set(["host@example.com", "guest-cohost"]),
  usersNeedingReadmission: ["guest-removed"],
  recoveryPassesVoidUntil: null,
  guestPassesFor: () => ({ "guest-removed": ["proof-of-pass", "proof-of-linked-pass"] }),
};

let directory: string;
// A new ledger over the same directory is the SFU after a restart.
const sfu = () => createRoomRecoveryLedger(createFileRoomRecoveryStore(directory));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "room-recovery-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("what the SFU remembers about a room across a restart", () => {
  it("knows a room it lost, who hosted it and who had been put out of it, with the passes of each guest", async () => {
    sfu().noteRunning(room);

    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: {
        hostUserKey: "host@example.com",
        adminUserKeys: ["host@example.com", "guest-cohost"],
        coHostUserKeys: ["guest-cohost"],
        readmissionRequiredUserKeys: ["guest-removed"],
        guestPasses: { "guest-removed": ["proof-of-pass", "proof-of-linked-pass"] },
        claimableUntil: Date.now() + 7 * MINUTE_MS,
        passGeneration: null,
      },
      passesVoidUntil: null,
      lastWriter: "room-1",
      owner: GUEST_MADE,
    });
  });

  it("takes every host but the temporary one as a co-host in a record an earlier build wrote", async () => {
    const store = createMemoryRoomRecoveryStore();
    await store.write(
      CHANNEL,
      {
        liveAt: Date.now(),
        hostUserKey: "guest-opener",
        adminUserKeys: ["guest-opener", "guest-cohost"],
        readmissionRequiredUserKeys: [],
        overAt: null,
        writer: "earlier-build",
        ownerEmail: "owner@example.com",
        temporaryHostUserKey: "guest-opener",
      } as unknown as Parameters<typeof store.write>[1],
      null,
    );

    const recalled = await createRoomRecoveryLedger(store).recall(CHANNEL);
    expect(recalled.lost?.coHostUserKeys).toEqual(["guest-cohost"]);
    expect(recalled.lost?.guestPasses).toEqual({});
  });

  it("knows nothing of a code that never had a room", async () => {
    expect(await sfu().recall(CHANNEL)).toEqual(NOTHING_KNOWN);
  });

  it("does not call a room lost when its last person left, and voids the passes from it", async () => {
    const emptiedAt = Date.now();
    const before = sfu();
    before.noteRunning(room);
    before.noteOver(room);

    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: null,
      passesVoidUntil: emptiedAt,
      lastWriter: "room-1",
      owner: GUEST_MADE,
    });
    vi.advanceTimersByTime(6 * MINUTE_MS + 1);
    expect(await sfu().recall(CHANNEL)).toEqual({
      ...NOTHING_KNOWN,
      lastWriter: "room-1",
      owner: GUEST_MADE,
    });
  });

  it("stops calling a room lost once no pass from it can still be good", async () => {
    sfu().noteRunning(room);

    vi.advanceTimersByTime(7 * MINUTE_MS);
    expect((await sfu().recall(CHANNEL)).lost).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect((await sfu().recall(CHANNEL)).lost).toBeNull();
  });

  it("remembers that a meeting was ended, for as long as a pass from it lives", async () => {
    const endedAt = Date.now();
    const before = sfu();
    before.noteRunning(room);
    before.noteOver(room);

    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: null,
      passesVoidUntil: endedAt,
      lastWriter: "room-1",
      owner: GUEST_MADE,
    });
    vi.advanceTimersByTime(6 * MINUTE_MS + 1);
    expect(await sfu().recall(CHANNEL)).toEqual({
      ...NOTHING_KNOWN,
      lastWriter: "room-1",
      owner: GUEST_MADE,
    });
  });

  it("keeps the end on record while the reopened meeting runs, and moves it on when that one empties", async () => {
    const endedAt = Date.now();
    const ledger = sfu();
    ledger.noteOver(room);
    const reopened = {
      ...room,
      incarnationId: "room-2",
      takesOverRecordOf: "room-1",
      recoveryPassesVoidUntil: endedAt,
    };
    ledger.noteRunning(reopened);
    expect((await sfu().recall(CHANNEL)).passesVoidUntil).toBe(endedAt);

    vi.advanceTimersByTime(MINUTE_MS);
    ledger.noteOver(reopened);
    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: null,
      passesVoidUntil: endedAt + MINUTE_MS,
      lastWriter: "room-2",
      owner: GUEST_MADE,
    });
  });

  it("reads a damaged record as no record", async () => {
    sfu().noteRunning(room);
    const [file] = filesIn(directory);
    writeFileSync(file, "{not json");
    expect(await sfu().recall(CHANNEL)).toEqual(NOTHING_KNOWN);

    writeFileSync(file, JSON.stringify({ liveAt: "soon" }));
    expect(await sfu().recall(CHANNEL)).toEqual(NOTHING_KNOWN);
  });
});

describe("whose code it is", () => {
  it("is remembered after the meeting is over", async () => {
    const owned = { ...room, ownerEmail: "owner@example.com" };
    const before = sfu();
    before.noteRunning(owned);
    before.noteOver(owned);

    expect((await sfu().recall(CHANNEL)).owner).toEqual({ email: "owner@example.com" });
  });

  it("is known to be nobody's for a code a guest made, and unknown for a code with no record", async () => {
    sfu().noteRunning(room);
    expect((await sfu().recall(CHANNEL)).owner).toEqual(GUEST_MADE);
    expect((await sfu().recall("conclave:never-used")).owner).toBeNull();
  });
});

describe("a room whose idea of the record it took over is out of date", () => {
  const stale = {
    ...room,
    incarnationId: "room-3",
    takesOverRecordOf: "room-0",
    hostUserKey: "host-3@example.com",
  };

  it("takes over a record held by a room this SFU saw finish, and keeps saving", async () => {
    const ledger = sfu();
    ledger.noteRunning(room);
    ledger.noteOver(room);
    const replacement = { ...stale };

    ledger.noteRunning(replacement);
    await vi.waitFor(async () =>
      expect((await sfu().recall(CHANNEL)).lastWriter).toBe("room-3"),
    );
    expect(replacement.takesOverRecordOf).toBe("room-1");
    const endedAt = Date.now();
    ledger.noteOver(replacement);
    expect((await sfu().recall(CHANNEL)).passesVoidUntil).toBe(endedAt);
  });

  it("does not take over a record a room elsewhere is still writing, and says so loudly", async () => {
    const loud = vi.spyOn(Logger, "error").mockImplementation(() => {});
    sfu().noteRunning(room);
    sfu().noteRunning(stale);

    await vi.waitFor(() => expect(loud).toHaveBeenCalled());
    expect((await sfu().recall(CHANNEL)).lastWriter).toBe("room-1");
  });
});

describe("a code whose room moved to another SFU", () => {
  const taken = {
    ...room,
    incarnationId: "room-2",
    takesOverRecordOf: "room-1",
    hostUserKey: "host-2@example.com",
  };

  it("keeps the new room's record when the room it took over writes again", async () => {
    const first = sfu();
    const second = sfu();
    first.noteRunning(room);
    second.noteRunning(taken);
    first.noteRunning(room);
    first.noteOver(room);

    expect((await sfu().recall(CHANNEL)).lost?.hostUserKey).toBe("host-2@example.com");
  });

  it("lets the new room write over what the room it took over wrote after it", async () => {
    const first = sfu();
    const second = sfu();
    first.noteRunning(room);
    // The new room read the record before the old one wrote once more.
    first.noteRunning({ ...room, hostUserKey: "host-1-later@example.com" });
    second.noteRunning(taken);

    expect((await sfu().recall(CHANNEL)).lost?.hostUserKey).toBe("host-2@example.com");
  });
});

const filesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });

describe("fencing a code's record when a room takes the code over", () => {
  const takingOver = { channelId: CHANNEL, incarnationId: "room-2", takesOverRecordOf: null };
  const running = (generation: number, usersNeedingReadmission: string[]) => ({
    ...room,
    usersNeedingReadmission,
    ownershipGeneration: generation,
  });

  const withHeldReads = () => {
    const inner = createMemoryRoomRecoveryStore();
    let held: Promise<void> | null = null;
    let release = () => undefined as void;
    const store: RoomRecoveryStore = {
      ...inner,
      read: async (channelId) => {
        const seen = await inner.read(channelId);
        if (held) await held;
        return seen;
      },
    };
    return {
      inner,
      store,
      holdReads: () => {
        held = new Promise<void>((resolve) => {
          release = () => {
            held = null;
            resolve();
          };
        });
      },
      release: () => release(),
    };
  };

  it("never loses a removal the room it took over was told it saved while the fence ran", async () => {
    vi.spyOn(Logger, "error").mockImplementation(() => undefined);
    const { inner, store, holdReads, release } = withHeldReads();
    const old = createRoomRecoveryLedger(inner);
    expect(await old.saveRecord(room, old.runningRecord(running(5, ["guest-removed"])), 5)).toBe(true);

    const takeover = createRoomRecoveryLedger(store);
    holdReads();
    const fencing = takeover.fence(takingOver, 6, null);
    await Promise.resolve();
    const landed = await old.saveRecord(room, old.runningRecord(running(5, ["guest-removed", "guest-removed-later"])), 5);
    release();
    await fencing;

    const kept = (await takeover.recall(CHANNEL)).lost?.readmissionRequiredUserKeys ?? [];
    expect(kept.includes("guest-removed-later")).toBe(landed);
    expect(kept).toContain("guest-removed");
  });

  it("stamps the generation on the record as it stands when the fence lands in a shared directory", async () => {
    const store = createFileRoomRecoveryStore(directory);
    const other = createFileRoomRecoveryStore(directory);
    const first = createRoomRecoveryLedger(store);
    await first.saveRecord(room, first.runningRecord(running(5, ["guest-removed"])), 5);
    const later = first.runningRecord(running(5, ["guest-removed", "guest-removed-later"]));
    let raced = false;
    const landed = await store.update(CHANNEL, (current) => {
      if (!raced) {
        raced = true;
        void other.write(CHANNEL, { ...later }, "room-1");
      }
      return { ...(current as typeof later), writer: "room-2", generation: 6 };
    });

    expect(landed).toBe(true);
    expect(await sfu().recall(CHANNEL)).toMatchObject({
      lastWriter: "room-2",
      lost: { readmissionRequiredUserKeys: ["guest-removed", "guest-removed-later"] },
    });
  });

  it("fences a code with no record yet, so a room of an older generation cannot write first", async () => {
    vi.spyOn(Logger, "error").mockImplementation(() => undefined);
    expect(await sfu().fence(takingOver, 6, null)).toBe(true);
    const stale = sfu();

    expect(await stale.saveRecord(room, stale.runningRecord(running(5, [])), 5)).toBe(false);
    expect(await sfu().recall(CHANNEL)).toMatchObject({ lost: null, lastWriter: "room-2" });
  });

  it("is refused once a newer generation has fenced the record", async () => {
    expect(await sfu().fence(takingOver, 6, null)).toBe(true);

    expect(await sfu().fence({ ...takingOver, incarnationId: "room-3" }, 4, null)).toBe(false);
    expect((await sfu().recall(CHANNEL)).lastWriter).toBe("room-2");
  });
});

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileRoomRecoveryStore,
  createRoomRecoveryLedger,
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
  hostUserKey: "host@example.com",
  adminUserKeys: new Set(["host@example.com", "guest-cohost"]),
  usersNeedingReadmission: ["guest-removed"],
  recoveryPassesVoidUntil: null,
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
  it("knows a room it lost, who hosted it and who had been put out of it", async () => {
    sfu().noteRunning(room);

    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: {
        hostUserKey: "host@example.com",
        adminUserKeys: ["host@example.com", "guest-cohost"],
        readmissionRequiredUserKeys: ["guest-removed"],
        claimableUntil: Date.now() + 7 * MINUTE_MS,
      },
      passesVoidUntil: null,
      lastWriter: "room-1",
      owner: GUEST_MADE,
    });
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

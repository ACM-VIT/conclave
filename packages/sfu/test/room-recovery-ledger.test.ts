import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileRoomRecoveryStore,
  createRoomRecoveryLedger,
} from "../server/roomRecoveryLedger.js";

const CHANNEL = "conclave:abc-mnop-xyz";
const MINUTE_MS = 60_000;
const NOTHING_KNOWN = { lost: null, passesVoidUntil: null, lastWriter: null };
const room = {
  channelId: CHANNEL,
  incarnationId: "room-1",
  takesOverRecordOf: null,
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
    });
    vi.advanceTimersByTime(6 * MINUTE_MS + 1);
    expect(await sfu().recall(CHANNEL)).toEqual({ ...NOTHING_KNOWN, lastWriter: "room-1" });
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
    });
    vi.advanceTimersByTime(6 * MINUTE_MS + 1);
    expect(await sfu().recall(CHANNEL)).toEqual({ ...NOTHING_KNOWN, lastWriter: "room-1" });
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

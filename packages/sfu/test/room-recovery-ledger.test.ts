import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileRoomRecoveryStore,
  createRoomRecoveryLedger,
} from "../server/roomRecoveryLedger.js";

const CHANNEL = "conclave:abc-mnop-xyz";
const MINUTE_MS = 60_000;
const NOTHING_KNOWN = { lost: null, passesVoidUntil: null, known: false };
const room = {
  channelId: CHANNEL,
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
      known: true,
    });
  });

  it("knows nothing of a code that never had a room", async () => {
    expect(await sfu().recall(CHANNEL)).toEqual(NOTHING_KNOWN);
  });

  it("does not call a room lost when it closed on purpose, and remembers that it closed", async () => {
    const before = sfu();
    before.noteRunning(room);
    before.noteClosed(room);

    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: null,
      passesVoidUntil: null,
      known: true,
    });
    vi.advanceTimersByTime(6 * MINUTE_MS + 1);
    expect((await sfu().recall(CHANNEL)).known).toBe(false);
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
    before.noteEnded(room);

    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: null,
      passesVoidUntil: endedAt,
      known: true,
    });
    vi.advanceTimersByTime(6 * MINUTE_MS + 1);
    expect(await sfu().recall(CHANNEL)).toEqual(NOTHING_KNOWN);
  });

  it("keeps the end on record while the reopened meeting runs and after it empties", async () => {
    const endedAt = Date.now();
    const ledger = sfu();
    ledger.noteEnded(room);
    const reopened = { ...room, recoveryPassesVoidUntil: endedAt };
    ledger.noteRunning(reopened);
    expect((await sfu().recall(CHANNEL)).passesVoidUntil).toBe(endedAt);

    ledger.noteClosed(reopened);
    expect(await sfu().recall(CHANNEL)).toEqual({
      lost: null,
      passesVoidUntil: endedAt,
      known: true,
    });
  });

  it("reads a damaged record as no record", async () => {
    sfu().noteRunning(room);
    const [file] = readdirSync(directory);
    writeFileSync(join(directory, file), "{not json");
    expect(await sfu().recall(CHANNEL)).toEqual(NOTHING_KNOWN);

    writeFileSync(join(directory, file), JSON.stringify({ liveAt: "soon" }));
    expect(await sfu().recall(CHANNEL)).toEqual(NOTHING_KNOWN);
  });
});

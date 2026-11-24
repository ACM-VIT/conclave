import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileRoomRecoveryStore,
  type RoomRecoveryRecord,
} from "../server/roomRecoveryLedger.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY_MS = 24 * 60 * 60 * 1000;

// Module code run in a process of its own, as another SFU on the host would.
const sfuProcess = (code: string) => {
  let child: ChildProcess | undefined;
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { cwd: join(import.meta.dirname, "..") },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (exitCode) => resolve({ code: exitCode, stderr }));
  });
  return Object.assign(exited, { crash: () => child?.kill("SIGKILL") });
};

// Holds a process the moment it calls `fs.<call>` with something that
// contains `marker`, until the test lets it go on. Unless `armed`, nothing
// holds until the process calls `armHold()`; `pauseAt(name)` holds it there.
const holdAt = (
  signals: string,
  call: "readFileSync" | "writeFileSync",
  markers: string[],
  { armed = true } = {},
) => `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const signals = ${JSON.stringify(signals)};
  const markers = ${JSON.stringify(markers)};
  let armed = ${armed};
  globalThis.armHold = () => { armed = true; };
  const pauseAt = (marker) => {
    fs.writeFileSync(signals + "/at-" + marker, "");
    const giveUpAt = Date.now() + 30000;
    while (!fs.existsSync(signals + "/go-on-" + marker) && Date.now() < giveUpAt) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  globalThis.pauseAt = pauseAt;
  const original = fs.${call};
  fs.${call} = (...args) => {
    const seen = ${call === "readFileSync" ? "original(...args)" : "args[1]"};
    const marker = armed && markers.find((name) => String(seen).includes(name));
    if (marker) {
      markers.splice(markers.indexOf(marker), 1);
      pauseAt(marker);
    }
    return ${call === "readFileSync" ? "seen" : "original(...args)"};
  };
  syncBuiltinESMExports();
  const { createFileRoomRecoveryStore } = await import("./server/roomRecoveryLedger.ts");
`;
const signalsOf = (signals: string) => ({
  isAt: (marker: string) => existsSync(join(signals, `at-${marker}`)),
  reaches: (marker: string) =>
    vi.waitFor(() => expect(existsSync(join(signals, `at-${marker}`))).toBe(true), {
      timeout: 60_000,
      interval: 20,
    }),
  goOnPast: (marker: string) => writeFileSync(join(signals, `go-on-${marker}`), ""),
});

const record = (hostUserKey: string, writer: string, liveAt = Date.now()): RoomRecoveryRecord => ({
  liveAt,
  hostUserKey,
  adminUserKeys: [hostUserKey],
  readmissionRequiredUserKeys: [],
  overAt: null,
  writer,
  ownerEmail: null,
  temporaryHostUserKey: null,
  coHostUserKeys: [],
  guestPasses: {},
});
const filesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
// Makes every file look as if it was last written two days ago.
const ageEverything = (dir: string) => {
  const longAgo = new Date(Date.now() - 2 * DAY_MS);
  for (const file of filesIn(dir)) utimesSync(file, longAgo, longAgo);
};
const leftovers = (dir: string) => filesIn(dir).filter((file) => !file.endsWith(".json"));

const CHANNEL = "conclave:abc-mnop-xyz";
const ROOMS_EACH = 32;

describe("two SFUs writing recovery records into one directory", () => {
  it("loses none of them while both clear out old records", async () => {
    const directory = tempDir("room-recovery-writers-");
    const store = createFileRoomRecoveryStore(directory);
    const longAgo = Date.now() - 3 * DAY_MS;
    for (let index = 0; index < 100; index += 1) {
      await store.write(`conclave:stale-${index}`, record("gone", `old-${index}`, longAgo), null);
    }
    // Written long ago, but its room is still running: not one to clear out.
    await store.write("conclave:still-running", record("host", "running"), null);
    ageEverything(directory);

    const writer = (name: string) =>
      sfuProcess(`
        import { createFileRoomRecoveryStore } from "./server/roomRecoveryLedger.ts";
        const store = createFileRoomRecoveryStore(${JSON.stringify(directory)});
        await Promise.all(Array.from({ length: ${ROOMS_EACH} }, (_, i) =>
          store.write(${JSON.stringify(name)} + ":room-" + i, { liveAt: Date.now(), hostUserKey: ${JSON.stringify(name)}, adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: ${JSON.stringify(name)} + "-" + i }, null)));
      `);
    const results = await Promise.all([writer("a"), writer("b")]);
    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ]);

    const reader = createFileRoomRecoveryStore(directory);
    for (const name of ["a", "b"]) {
      for (let index = 0; index < ROOMS_EACH; index += 1) {
        expect(await reader.read(`${name}:room-${index}`)).toMatchObject({ hostUserKey: name });
      }
    }
    expect(await reader.read("conclave:still-running")).toMatchObject({ hostUserKey: "host" });
    // An expired room keeps its number: one tombstone that says nothing.
    for (let index = 0; index < 100; index += 1) {
      expect(await reader.read(`conclave:stale-${index}`)).toMatchObject({
        liveAt: null,
        overAt: null,
        hostUserKey: null,
        adminUserKeys: [],
        readmissionRequiredUserKeys: [],
        writer: `old-${index}`,
      });
    }
    expect(leftovers(directory)).toEqual([]);
    const rooms = readdirSync(directory);
    expect(rooms).toHaveLength(2 * ROOMS_EACH + 1 + 100);
    for (const room of rooms) expect(readdirSync(join(directory, room))).toHaveLength(1);
  }, 120_000);

  // A room's long expired record, and another SFU tidying the directory,
  // held each time it has just read one of `markers`.
  const clearOutInProgress = async (markers: string[]) => {
    const directory = tempDir("room-recovery-writers-");
    const signals = tempDir("room-recovery-signals-");
    const store = createFileRoomRecoveryStore(directory);
    await store.write(CHANNEL, record("host-long-gone", "room-gone", Date.now() - 3 * DAY_MS), null);
    ageEverything(directory);
    const tidying = sfuProcess(`
      ${holdAt(signals, "readFileSync", markers)}
      await createFileRoomRecoveryStore(${JSON.stringify(directory)}).write(
        "conclave:another-room",
        { liveAt: Date.now(), hostUserKey: "another-host", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "another-room" },
        null,
      );
    `);
    return { directory, store, tidying, ...signalsOf(signals) };
  };
  // Whether the tidying SFU stops again at `marker`, or finishes first.
  const stopsAgainAt = async (
    other: Awaited<ReturnType<typeof clearOutInProgress>>,
    marker: string,
  ) => {
    let finished = false;
    void other.tidying.then(() => (finished = true));
    while (!finished && !other.isAt(marker)) await sleep(20);
    return other.isAt(marker);
  };

  it("keeps a record one SFU writes while the other is clearing out the one before it", async () => {
    const other = await clearOutInProgress(["host-long-gone"]);
    await other.reaches("host-long-gone");
    const writing = other.store.write(CHANNEL, record("host-now", "room-now"), "room-gone");
    const reading = other.store.read(CHANNEL);
    other.goOnPast("host-long-gone");
    await writing;
    expect(await other.tidying).toEqual({ code: 0, stderr: "" });

    expect(await reading).toMatchObject({ hostUserKey: "host-now" });
    expect(await other.store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-now" });
    expect(leftovers(other.directory)).toEqual([]);
  }, 120_000);

  it("never shows another SFU a record as missing while it is being cleared out from under a new one", async () => {
    const other = await clearOutInProgress(["host-long-gone", "host-now"]);
    await other.reaches("host-long-gone");
    const writing = other.store.write(CHANNEL, record("host-now", "room-now"), "room-gone");
    other.goOnPast("host-long-gone");
    await writing;

    // The room's record has been written. Wherever the tidying SFU is now,
    // a third SFU that recreates the room must find it.
    const heldAgain = await stopsAgainAt(other, "host-now");
    const seen = await createFileRoomRecoveryStore(other.directory).read(CHANNEL);
    if (heldAgain) other.goOnPast("host-now");
    expect(await other.tidying).toEqual({ code: 0, stderr: "" });

    expect(seen).toMatchObject({ hostUserKey: "host-now" });
    expect(await other.store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-now" });
    expect(leftovers(other.directory)).toEqual([]);
  }, 120_000);

  it("keeps the newest of two writes this SFU makes while the other is clearing out", async () => {
    const other = await clearOutInProgress(["host-long-gone"]);
    await other.reaches("host-long-gone");
    const first = other.store.write(CHANNEL, record("host-now", "room-now"), "room-gone");
    const second = other.store.write(CHANNEL, record("host-newest", "room-now"), "room-gone");
    other.goOnPast("host-long-gone");
    await Promise.all([first, second]);
    expect(await other.tidying).toEqual({ code: 0, stderr: "" });

    expect(await other.store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-newest" });
    expect(leftovers(other.directory)).toEqual([]);
  }, 120_000);

  // Room A's SFU is in the middle of writing A's view of the call when it
  // stops. Meanwhile room B, on another SFU, takes the call over from A and
  // writes. Then A's SFU goes on.
  const writeInterrupted = async () => {
    const directory = tempDir("room-recovery-writers-");
    const signals = tempDir("room-recovery-signals-");
    const store = createFileRoomRecoveryStore(directory);
    await store.write(CHANNEL, record("host-a", "room-a"), null);
    const roomA = sfuProcess(`
      ${holdAt(signals, "writeFileSync", ["host-a-later"])}
      await createFileRoomRecoveryStore(${JSON.stringify(directory)}).write(
        ${JSON.stringify(CHANNEL)},
        { liveAt: Date.now(), hostUserKey: "host-a-later", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "room-a" },
        null,
      );
    `);
    const signalled = signalsOf(signals);
    await signalled.reaches("host-a-later");
    return { directory, store, roomA, ...signalled };
  };

  it("does not let a write that stopped for seconds land over what was written meanwhile", async () => {
    const interrupted = await writeInterrupted();
    const stoppedAt = Date.now();
    await interrupted.store.write(CHANNEL, record("host-b", "room-b"), "room-a");
    await sleep(Math.max(0, stoppedAt + 5_500 - Date.now()));
    interrupted.goOnPast("host-a-later");
    expect(await interrupted.roomA).toEqual({ code: 0, stderr: "" });

    expect(await createFileRoomRecoveryStore(interrupted.directory).read(CHANNEL)).toMatchObject({
      hostUserKey: "host-b",
    });
    expect(leftovers(interrupted.directory)).toEqual([]);
  }, 120_000);

  it("does not let an SFU whose clock runs ahead write around a write in progress", async () => {
    const interrupted = await writeInterrupted();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6_000);
    await interrupted.store.write(CHANNEL, record("host-b", "room-b"), "room-a");
    vi.useRealTimers();
    interrupted.goOnPast("host-a-later");
    expect(await interrupted.roomA).toEqual({ code: 0, stderr: "" });

    expect(await createFileRoomRecoveryStore(interrupted.directory).read(CHANNEL)).toMatchObject({
      hostUserKey: "host-b",
    });
  }, 120_000);

  it("does not clear out a room another SFU is in the middle of writing its first record to", async () => {
    const directory = tempDir("room-recovery-writers-");
    const signals = tempDir("room-recovery-signals-");
    const firstWrite = sfuProcess(`
      ${holdAt(signals, "writeFileSync", ["host-first"])}
      await createFileRoomRecoveryStore(${JSON.stringify(directory)}).write(
        ${JSON.stringify(CHANNEL)},
        { liveAt: Date.now(), hostUserKey: "host-first", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "room-first" },
        null,
      );
    `);
    const signalled = signalsOf(signals);
    await signalled.reaches("host-first");

    // This SFU's first write tidies the directory.
    await createFileRoomRecoveryStore(directory).write(
      "conclave:another-room",
      record("another-host", "another-room"),
      null,
    );
    const roomsWhileWriting = readdirSync(directory).filter((name) =>
      statSync(join(directory, name)).isDirectory(),
    );
    signalled.goOnPast("host-first");
    expect(await firstWrite).toEqual({ code: 0, stderr: "" });

    expect(roomsWhileWriting).toHaveLength(2);
    expect(await createFileRoomRecoveryStore(directory).read(CHANNEL)).toMatchObject({
      hostUserKey: "host-first",
    });
  }, 120_000);

  it("does not let a write decided on an expired record land over a room opened after cleanup", async () => {
    const directory = tempDir("room-recovery-writers-");
    const signals = tempDir("room-recovery-signals-");
    // A long expired record, unchanged for days.
    await createFileRoomRecoveryStore(directory).write(
      CHANNEL,
      record("host-long-gone", "room-gone", Date.now() - 3 * DAY_MS),
      null,
    );
    ageEverything(directory);
    // A room that took that record over reads it, and stops right there.
    const stalled = sfuProcess(`
      ${holdAt(signals, "readFileSync", ["host-long-gone"])}
      await createFileRoomRecoveryStore(${JSON.stringify(directory)}).write(
        ${JSON.stringify(CHANNEL)},
        { liveAt: Date.now(), hostUserKey: "host-stalled", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "room-stalled" },
        "room-gone",
      );
    `);
    const signalled = signalsOf(signals);
    await signalled.reaches("host-long-gone");

    // Another SFU tidies the directory, then opens a new room at the code,
    // taking over whatever record it finds there.
    const other = createFileRoomRecoveryStore(directory);
    await other.write("conclave:another-room", record("another-host", "another-room"), null);
    const found = (await other.read(CHANNEL)) as { writer?: string } | null;
    await other.write(CHANNEL, record("host-new", "room-new"), found?.writer ?? null);

    signalled.goOnPast("host-long-gone");
    expect(await stalled).toEqual({ code: 0, stderr: "" });
    expect(await createFileRoomRecoveryStore(directory).read(CHANNEL)).toMatchObject({
      hostUserKey: "host-new",
    });
  }, 120_000);

  it("removes a tombstone that has stood for 90 days, directory and all, and keeps a younger one", async () => {
    const directory = tempDir("room-recovery-writers-");
    const older = "conclave:old-code-xyz";
    const store = createFileRoomRecoveryStore(directory);
    await store.write(CHANNEL, record("host-a", "room-a", Date.now() - 3 * DAY_MS), null);
    await store.write(older, record("host-b", "room-b", Date.now() - 3 * DAY_MS), null);
    ageEverything(directory);
    await createFileRoomRecoveryStore(directory).write(
      "conclave:tidy-once",
      record("tidy-host", "tidy-room"),
      null,
    );
    expect(await store.read(older)).toMatchObject({ hostUserKey: null, writer: "room-b" });
    const roomOf = (channelId: string) =>
      join(directory, createHash("sha256").update(channelId).digest("hex"));
    const stoodFor = (channelId: string, days: number) => {
      const since = new Date(Date.now() - days * DAY_MS);
      for (const file of filesIn(roomOf(channelId))) utimesSync(file, since, since);
    };
    stoodFor(older, 91);
    stoodFor(CHANNEL, 60);

    await createFileRoomRecoveryStore(directory).write(
      "conclave:tidy-twice",
      record("tidy-host", "tidy-room"),
      null,
    );

    expect(existsSync(roomOf(older))).toBe(false);
    expect(await store.read(older)).toBeNull();
    expect(await store.read(CHANNEL)).toMatchObject({ hostUserKey: null, writer: "room-a" });
  });

  it("never numbers a room again, however long its tombstone stood, while a write decided on it is stalled", async () => {
    const directory = tempDir("room-recovery-writers-");
    const signals = tempDir("room-recovery-signals-");
    const longGone = Date.now() - 3 * DAY_MS;
    const store = createFileRoomRecoveryStore(directory);
    await store.write(CHANNEL, record("host-long-gone", "room-gone", longGone), null);
    // Tidying turns the expired record into the room's tombstone.
    ageEverything(directory);
    await createFileRoomRecoveryStore(directory).write(
      "conclave:tidy-once",
      record("tidy-host", "tidy-room"),
      null,
    );
    expect(await store.read(CHANNEL)).toMatchObject({ hostUserKey: null, writer: "room-gone" });

    // An SFU that tidied already reads that tombstone to take the room over,
    // and stops right after.
    const stalled = sfuProcess(`
      ${holdAt(signals, "readFileSync", ["room-gone"], { armed: false })}
      const store = createFileRoomRecoveryStore(${JSON.stringify(directory)});
      await store.write("conclave:warm-up", { liveAt: Date.now(), hostUserKey: "warm-up", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "warm-up" }, null);
      pauseAt("warmed-up");
      armHold();
      const landed = await store.write(
        ${JSON.stringify(CHANNEL)},
        { liveAt: Date.now(), hostUserKey: "host-stalled", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "room-stalled" },
        "room-gone",
      );
      fs.writeFileSync(signals + "/landed", String(landed));
    `);
    const signalled = signalsOf(signals);
    await signalled.reaches("warmed-up");
    // Meanwhile the tombstone has stood untouched for well over a month.
    const longAgo = new Date(Date.now() - 45 * DAY_MS);
    for (const file of filesIn(directory)) utimesSync(file, longAgo, longAgo);
    signalled.goOnPast("warmed-up");
    await signalled.reaches("room-gone");

    // Another SFU tidies the directory, then opens a new room at the code,
    // taking over whatever record it finds there.
    const other = createFileRoomRecoveryStore(directory);
    await other.write("conclave:another-room", record("another-host", "another-room"), null);
    const found = (await other.read(CHANNEL)) as { writer?: string } | null;
    expect(await other.write(CHANNEL, record("host-new", "room-new"), found?.writer ?? null)).toBe(
      true,
    );

    signalled.goOnPast("room-gone");
    expect(await stalled).toEqual({ code: 0, stderr: "" });
    expect(readFileSync(join(signals, "landed"), "utf8")).toBe("false");
    expect(await createFileRoomRecoveryStore(directory).read(CHANNEL)).toMatchObject({
      hostUserKey: "host-new",
    });
  }, 120_000);

  it("does not report a stalled write as landed when it came in below newer records", async () => {
    const directory = tempDir("room-recovery-writers-");
    const signals = tempDir("room-recovery-signals-");
    await createFileRoomRecoveryStore(directory).write(CHANNEL, record("host-a", "room-a"), null);
    // Room A's SFU reads the room's record to write after it, and stops.
    const roomA = sfuProcess(`
      ${holdAt(signals, "readFileSync", ["host-a"], { armed: false })}
      const store = createFileRoomRecoveryStore(${JSON.stringify(directory)});
      await store.write("conclave:warm-up", { liveAt: Date.now(), hostUserKey: "warm-up", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "warm-up" }, null);
      armHold();
      const landed = await store.write(
        ${JSON.stringify(CHANNEL)},
        { liveAt: Date.now(), hostUserKey: "host-a-later", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null, ownerEmail: null, writer: "room-a" },
        null,
      );
      fs.writeFileSync(signals + "/landed", String(landed));
    `);
    const signalled = signalsOf(signals);
    await signalled.reaches("host-a");

    // Room B takes the call over and writes twice, then a third SFU's tidying
    // clears out every version below B's newest, the one A meant to take too.
    const roomB = createFileRoomRecoveryStore(directory);
    expect(await roomB.write(CHANNEL, record("host-b", "room-b"), "room-a")).toBe(true);
    expect(await roomB.write(CHANNEL, record("host-b-later", "room-b"), "room-a")).toBe(true);
    await createFileRoomRecoveryStore(directory).write(
      "conclave:another-room",
      record("another-host", "another-room"),
      null,
    );

    signalled.goOnPast("host-a");
    expect(await roomA).toEqual({ code: 0, stderr: "" });
    expect(readFileSync(join(signals, "landed"), "utf8")).toBe("false");
    expect(await createFileRoomRecoveryStore(directory).read(CHANNEL)).toMatchObject({
      hostUserKey: "host-b-later",
    });
  }, 120_000);

  it("is not held up by an SFU that crashed in the middle of writing", async () => {
    const interrupted = await writeInterrupted();
    interrupted.roomA.crash();
    await interrupted.roomA;

    const started = Date.now();
    expect(await interrupted.store.write(CHANNEL, record("host-b", "room-b"), "room-a")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await interrupted.store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-b" });
  }, 120_000);
});

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
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
// contains `marker`, until the test lets it go on.
const holdAt = (signals: string, call: "readFileSync" | "writeFileSync", markers: string[]) => `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const signals = ${JSON.stringify(signals)};
  const markers = ${JSON.stringify(markers)};
  const original = fs.${call};
  fs.${call} = (...args) => {
    const seen = ${call === "readFileSync" ? "original(...args)" : "args[1]"};
    const marker = markers.find((name) => String(seen).includes(name));
    if (marker) {
      markers.splice(markers.indexOf(marker), 1);
      fs.writeFileSync(signals + "/at-" + marker, "");
      const giveUpAt = Date.now() + 30000;
      while (!fs.existsSync(signals + "/go-on-" + marker) && Date.now() < giveUpAt) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
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
    for (let index = 0; index < 100; index += 1) {
      expect(await reader.read(`conclave:stale-${index}`)).toBeNull();
    }
    expect(leftovers(directory)).toEqual([]);
    expect(readdirSync(directory)).toHaveLength(2 * ROOMS_EACH + 1);
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

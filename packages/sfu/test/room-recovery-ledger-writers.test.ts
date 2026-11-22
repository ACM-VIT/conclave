import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const ROOMS_EACH = 32;
// One SFU process writing its rooms' records as fast as it can. Its first
// write also tidies the directory, which is where two processes collide.
const writer = (directory: string, name: string) =>
  sfuProcess(`
    import { createFileRoomRecoveryStore } from "./server/roomRecoveryLedger.ts";
    const store = createFileRoomRecoveryStore(${JSON.stringify(directory)});
    const record = { liveAt: Date.now(), hostUserKey: ${JSON.stringify(name)}, adminUserKeys: [${JSON.stringify(name)}], readmissionRequiredUserKeys: [], overAt: null };
    await Promise.all(Array.from({ length: ${ROOMS_EACH} }, (_, i) => store.write(${JSON.stringify(name)} + ":room-" + i, record)));
  `);

const recordHostedBy = (hostUserKey: string, liveAt: number): RoomRecoveryRecord => ({
  liveAt,
  hostUserKey,
  adminUserKeys: [hostUserKey],
  readmissionRequiredUserKeys: [],
  overAt: null,
});

describe("two SFUs writing recovery records into one directory", () => {
  it("loses none of them while both clear out old records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "room-recovery-writers-"));
    dirs.push(directory);
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const expired = JSON.stringify({
      liveAt: longAgo.getTime(),
      hostUserKey: null,
      adminUserKeys: [],
      readmissionRequiredUserKeys: [],
      overAt: null,
    });
    for (let index = 0; index < 400; index += 1) {
      const path = join(directory, `stale-${index}.json`);
      writeFileSync(path, expired);
      utimesSync(path, longAgo, longAgo);
    }
    // Written long ago, but its room is still running: not one to clear out.
    const stillRunning = join(directory, "old-file-live-room.json");
    writeFileSync(
      stillRunning,
      JSON.stringify({
        liveAt: Date.now(),
        hostUserKey: "host",
        adminUserKeys: ["host"],
        readmissionRequiredUserKeys: [],
        overAt: null,
      }),
    );
    utimesSync(stillRunning, longAgo, longAgo);

    const results = await Promise.all([writer(directory, "a"), writer(directory, "b")]);
    expect(results.map((result) => result.stderr.trim())).toEqual(["", ""]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);

    const store = createFileRoomRecoveryStore(directory);
    for (const name of ["a", "b"]) {
      for (let index = 0; index < ROOMS_EACH; index += 1) {
        expect(await store.read(`${name}:room-${index}`)).toMatchObject({
          hostUserKey: name,
        });
      }
    }
    const files = readdirSync(directory);
    expect(files.filter((file) => file.startsWith("stale-"))).toEqual([]);
    expect(files).toContain("old-file-live-room.json");
    expect(files.filter((file) => !file.endsWith(".json"))).toEqual([]);
    expect(files).toHaveLength(2 * ROOMS_EACH + 1);
  }, 120_000);

  // A room's expired record, and another SFU tidying the directory. That SFU
  // is held each time it has just read a record hosted by one of `holdAt`,
  // until the test lets it go on: the moments at which this SFU's writes and
  // reads land in the middle of its clear-out.
  const CHANNEL = "conclave:abc-mnop-xyz";
  const clearOutInProgress = async (holdAt: string[]) => {
    const directory = mkdtempSync(join(tmpdir(), "room-recovery-writers-"));
    const signals = mkdtempSync(join(tmpdir(), "room-recovery-signals-"));
    dirs.push(directory, signals);
    const store = createFileRoomRecoveryStore(directory);
    await store.write(
      CHANNEL,
      recordHostedBy("host-long-gone", Date.now() - 3 * 24 * 60 * 60 * 1000),
    );
    const tidying = sfuProcess(`
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const signals = ${JSON.stringify(signals)};
      const holdAt = ${JSON.stringify(holdAt)};
      const readFileSync = fs.readFileSync;
      fs.readFileSync = (...args) => {
        const read = readFileSync(...args);
        const host = holdAt.find((name) => String(read).includes(name));
        if (host) {
          holdAt.splice(holdAt.indexOf(host), 1);
          fs.writeFileSync(signals + "/read-" + host, "");
          const giveUpAt = Date.now() + 30000;
          while (!fs.existsSync(signals + "/go-on-" + host) && Date.now() < giveUpAt) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return read;
      };
      syncBuiltinESMExports();
      const { createFileRoomRecoveryStore } = await import("./server/roomRecoveryLedger.ts");
      await createFileRoomRecoveryStore(${JSON.stringify(directory)}).write(
        "conclave:another-room",
        { liveAt: Date.now(), hostUserKey: "another-host", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null },
      );
    `);
    return {
      directory,
      store,
      tidying,
      hasRead: (host: string) => existsSync(join(signals, `read-${host}`)),
      hasJustRead: (host: string) =>
        vi.waitFor(() => expect(existsSync(join(signals, `read-${host}`))).toBe(true), {
          timeout: 60_000,
          interval: 20,
        }),
      goOnPast: (host: string) => writeFileSync(join(signals, `go-on-${host}`), ""),
    };
  };
  const leftovers = (directory: string) =>
    readdirSync(directory).filter((file) => !file.endsWith(".json"));

  // Whether the other SFU stops again at a read of `host`, or finishes first.
  const stopsAgainAt = async (
    other: Awaited<ReturnType<typeof clearOutInProgress>>,
    host: string,
  ) => {
    let finished = false;
    void other.tidying.then(() => (finished = true));
    while (!finished && !other.hasRead(host)) await sleep(20);
    return other.hasRead(host);
  };

  it("keeps a record one SFU writes while the other is clearing out the one before it", async () => {
    const other = await clearOutInProgress(["host-long-gone"]);
    await other.hasJustRead("host-long-gone");
    const writing = other.store.write(CHANNEL, recordHostedBy("host-now", Date.now()));
    // This SFU reads its own room's record after writing it.
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
    await other.hasJustRead("host-long-gone");
    const writing = other.store.write(CHANNEL, recordHostedBy("host-now", Date.now()));
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
    await other.hasJustRead("host-long-gone");
    const first = other.store.write(CHANNEL, recordHostedBy("host-now", Date.now()));
    const second = other.store.write(CHANNEL, recordHostedBy("host-newest", Date.now()));
    other.goOnPast("host-long-gone");
    await Promise.all([first, second]);
    expect(await other.tidying).toEqual({ code: 0, stderr: "" });

    expect(await other.store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-newest" });
    expect(leftovers(other.directory)).toEqual([]);
  }, 120_000);

  it("is not held up for good by an SFU that crashed in the middle of writing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "room-recovery-writers-"));
    const signals = mkdtempSync(join(tmpdir(), "room-recovery-signals-"));
    dirs.push(directory, signals);
    const store = createFileRoomRecoveryStore(directory);
    await store.write("conclave:another-room", recordHostedBy("another-host", Date.now()));
    const crashing = sfuProcess(`
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const writeFileSync = fs.writeFileSync;
      fs.writeFileSync = (...args) => {
        if (String(args[1]).includes("host-crashed")) {
          writeFileSync(${JSON.stringify(join(signals, "writing"))}, "");
          for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        return writeFileSync(...args);
      };
      syncBuiltinESMExports();
      const { createFileRoomRecoveryStore } = await import("./server/roomRecoveryLedger.ts");
      await createFileRoomRecoveryStore(${JSON.stringify(directory)}).write(
        ${JSON.stringify(CHANNEL)},
        { liveAt: Date.now(), hostUserKey: "host-crashed", adminUserKeys: [], readmissionRequiredUserKeys: [], overAt: null },
      );
    `);
    await vi.waitFor(() => expect(existsSync(join(signals, "writing"))).toBe(true), {
      timeout: 60_000,
      interval: 20,
    });
    crashing.crash();
    await crashing;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await store.write(CHANNEL, recordHostedBy("host-now", Date.now()));
    } finally {
      vi.useRealTimers();
    }
    expect(await store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-now" });
    expect(leftovers(directory)).toEqual([]);
  }, 120_000);
});

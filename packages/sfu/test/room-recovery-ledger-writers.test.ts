import { spawn } from "node:child_process";
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

// Module code run in a process of its own, as another SFU on the host would.
const sfuProcess = (code: string) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { cwd: join(import.meta.dirname, "..") },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (exitCode) => resolve({ code: exitCode, stderr }));
  });

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
  // until the test lets it go on: the moments at which this SFU's writes
  // land in the middle of its clear-out.
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

  it("keeps a record one SFU writes while the other is clearing out the one before it", async () => {
    const other = await clearOutInProgress(["host-long-gone"]);
    await other.hasJustRead("host-long-gone");
    await other.store.write(CHANNEL, recordHostedBy("host-now", Date.now()));
    other.goOnPast("host-long-gone");
    expect(await other.tidying).toEqual({ code: 0, stderr: "" });

    expect(await other.store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-now" });
    expect(leftovers(other.directory)).toEqual([]);
  }, 120_000);

  it("keeps the newest record when the room writes again before the first is put back", async () => {
    const other = await clearOutInProgress(["host-long-gone", "host-now"]);
    await other.hasJustRead("host-long-gone");
    await other.store.write(CHANNEL, recordHostedBy("host-now", Date.now()));
    other.goOnPast("host-long-gone");
    await other.hasJustRead("host-now");
    await other.store.write(CHANNEL, recordHostedBy("host-newest", Date.now()));
    other.goOnPast("host-now");
    expect(await other.tidying).toEqual({ code: 0, stderr: "" });

    expect(await other.store.read(CHANNEL)).toMatchObject({ hostUserKey: "host-newest" });
    expect(leftovers(other.directory)).toEqual([]);
  }, 120_000);
});

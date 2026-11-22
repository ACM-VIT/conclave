import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileRoomRecoveryStore } from "../server/roomRecoveryLedger.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROOMS_EACH = 32;
// One SFU process writing its rooms' records as fast as it can. Its first
// write also tidies the directory, which is where two processes collide.
const writer = (directory: string, name: string) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const code = `
      import { createFileRoomRecoveryStore } from "./server/roomRecoveryLedger.ts";
      const store = createFileRoomRecoveryStore(${JSON.stringify(directory)});
      const record = { liveAt: Date.now(), hostUserKey: ${JSON.stringify(name)}, adminUserKeys: [${JSON.stringify(name)}], readmissionRequiredUserKeys: [], endedAt: null };
      await Promise.all(Array.from({ length: ${ROOMS_EACH} }, (_, i) => store.write(${JSON.stringify(name)} + ":room-" + i, record)));
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { cwd: join(import.meta.dirname, "..") },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (exitCode) => resolve({ code: exitCode, stderr }));
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
      endedAt: null,
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
        endedAt: null,
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
});

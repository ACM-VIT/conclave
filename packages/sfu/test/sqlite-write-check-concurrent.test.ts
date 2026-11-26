import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

// Lets the test run a second probe between the first probe's write and unlink.
const fsHook = vi.hoisted(() => ({ afterWrite: null as null | (() => void) }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      fs.writeFileSync(...args);
      const hook = fsHook.afterWrite;
      fsHook.afterWrite = null;
      hook?.();
    },
  };
});

const { assertSqliteWritable } = await import("../server/sqliteWriteCheck.js");

let dir = "";

afterEach(() => {
  fsHook.afterWrite = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite write check on a shared recordings volume", () => {
  // Both SFU containers run as PID 1, so anything keyed on the PID collides.
  it("lets two SFUs probe the same directory at once", () => {
    dir = mkdtempSync(join(tmpdir(), "sfu-sqlite-shared-probe-"));
    const path = join(dir, "conclave.sqlite");
    const sfuA = new DatabaseSync(path);
    const sfuB = new DatabaseSync(path);
    fsHook.afterWrite = () => assertSqliteWritable(sfuB, path);

    expect(() => assertSqliteWritable(sfuA, path)).not.toThrow();
    expect(readdirSync(dir).filter((name) => name.startsWith(".write-check"))).toEqual([]);
    sfuA.close();
    sfuB.close();
  });
});

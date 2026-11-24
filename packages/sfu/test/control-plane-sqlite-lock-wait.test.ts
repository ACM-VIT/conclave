import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLITE_COMMIT_WAIT_MS, createSqliteBackend } from "../server/controlPlane/backends/sqlite.js";
import { createMeeting } from "../server/controlPlane/meetingCommands.js";
import { StoreUnavailableError } from "../server/controlPlane/model.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";

const options = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-sqlite-lock-wait-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a SQLite commit while another SFU holds the write lock", () => {
  it("waits at most the commit bound, then fails as a storage error instead of blocking for the startup timeout", async () => {
    const path = join(dir, "conclave.sqlite");
    const store = controlPlaneStore(createSqliteBackend(path));
    const other = new DatabaseSync(path);
    try {
      other.exec("BEGIN IMMEDIATE");
      const started = performance.now();
      await expect(store.commit(createMeeting({ title: "Blocked", scheduledStartAt: 1_900_000_000_000 }, options))).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(SQLITE_COMMIT_WAIT_MS * 0.9);
      expect(waited).toBeLessThan(SQLITE_COMMIT_WAIT_MS * 3);
      other.exec("ROLLBACK");
      expect((await store.commit(createMeeting({ title: "After", scheduledStartAt: 1_900_000_000_000 }, options))).ok).toBe(true);
    } finally {
      other.close();
      await store.close();
    }
  }, 20_000);
});

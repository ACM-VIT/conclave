import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonBackend } from "../server/controlPlane/backends/json.js";
import { createMeeting } from "../server/controlPlane/meetingCommands.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";

const options = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };

let dir = "";
let previousUmask = 0;
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-json-mode-"));
  previousUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(previousUmask);
  rmSync(dir, { recursive: true, force: true });
});

describe("the control-plane JSON store under umask 022", () => {
  it("keeps its file and its lock readable only by its owner, and leaves no temporary file", async () => {
    const path = join(dir, "recordings", "control-plane.json");
    const store = controlPlaneStore(createJsonBackend(path));
    try {
      const created = await store.commit(createMeeting({ title: "Private", scheduledStartAt: 1_900_000_000_000 }, options));
      expect(created.ok).toBe(true);
      expect(mode(path)).toBe("600");
      expect(mode(`${path}.lock`)).toBe("600");
      expect(readdirSync(join(dir, "recordings")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await store.close();
    }
  });
});

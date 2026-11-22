import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistenceFence, fenceScheduledMeetingPersistence } from "../server/persistenceFence.js";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  persistScheduledMeetingChanges,
} from "../server/scheduledMeetings.js";

// A Redis client for the real Redis meeting store: each HSET lands a moment
// later, and the one that carries failId is refused, as a Redis out of
// memory would refuse it.
const redis = vi.hoisted(() => ({ stored: new Map<string, string>(), failId: "" }));
vi.mock("../server/redisPersistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/redisPersistence.js")>();
  return {
    ...actual,
    createRedisPersistenceClient: () => ({
      connect: async () => undefined,
      quit: async () => undefined,
      hVals: async () => [...redis.stored.values()],
      hDel: async (_key: string, ids: string[]) => ids.filter((id) => redis.stored.delete(id)).length,
      hSet: async (_key: string, fields: Record<string, string>) => {
        await delay(5);
        if (redis.failId in fields) throw new Error("OOM command not allowed when used memory > 'maxmemory'.");
        for (const [id, value] of Object.entries(fields)) redis.stored.set(id, value);
        return Object.keys(fields).length;
      },
    }),
  };
});

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  redis.stored.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const options = {
  clientId: "conclave",
  createdBy: "host@example.com",
  defaultHostEmail: "host@example.com",
  defaultHostUserId: null,
};

describe("persistence fence over the Redis meeting store", () => {
  it("gives each of three writes released together its own result, so only the failed write's caller sees the error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-"));
    dirs.push(dir);
    vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "redis");
    vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", "redis://127.0.0.1:9/0");
    vi.stubEnv("SCHEDULED_MEETINGS_SQLITE_PATH", join(dir, "conclave.sqlite"));

    const store = createScheduledMeetingStore();
    const meetings = [1, 2, 3].map((hour) =>
      createScheduledMeeting(store, { title: `Meeting ${hour}`, scheduledStartAt: Date.now() + hour * 3_600_000 }, options),
    );
    redis.failId = meetings[1].id;
    const fence = createPersistenceFence();
    const persistence = fenceScheduledMeetingPersistence(createScheduledMeetingPersistence(), fence);

    await fence.hold("backup-one", 10_000);
    const writes = meetings.map((meeting) => persistScheduledMeetingChanges(store, persistence, [meeting]));
    fence.release("backup-one");
    const results = await Promise.allSettled(writes);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/OOM command not allowed/);
    expect([...redis.stored.keys()].sort()).toEqual([meetings[0].id, meetings[2].id].sort());
  });
});

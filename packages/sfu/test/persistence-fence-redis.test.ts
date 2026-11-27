import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistenceFence, fenceScheduledMeetingPersistence, fenceSchedulingPersistence } from "../server/persistenceFence.js";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  persistScheduledMeetingChanges,
} from "../server/scheduledMeetings.js";
import { createSchedulingPersistence } from "../server/scheduling.js";
import type { SchedulingProfile, WeeklyAvailability } from "../types.js";

// A Redis client for the real Redis meeting store: each HSET lands a moment
// later, and the one that carries failId is refused, as a Redis out of
// memory would refuse it.
const redis = vi.hoisted(() => ({ stored: new Map<string, string>(), failId: "", failKey: "", evals: [] as string[] }));
vi.mock("../server/redisPersistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/redisPersistence.js")>();
  return {
    ...actual,
    createRedisPersistenceClient: () => ({
      connect: async () => undefined,
      quit: async () => undefined,
      hVals: async () => [...redis.stored.values()],
      hDel: async (_key: string, ids: string[]) => ids.filter((id) => redis.stored.delete(id)).length,
      sendCommand: async ([command, , , key, , id]: string[]) => {
        await delay(5);
        if (command === "EVAL" && redis.failKey && key.endsWith(redis.failKey)) {
          throw new Error("OOM command not allowed when used memory > 'maxmemory'.");
        }
        redis.evals.push(`${key} ${id}`);
        return 1;
      },
      multi: () => ({ hDel: () => undefined, hSet: () => undefined, exec: async () => [] }),
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
  redis.failKey = "";
  redis.evals.length = 0;
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

describe("persistence fence over the Redis scheduling store", () => {
  it("grants a backup hold only once every branch of a failed save has stopped writing, and the save still fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scheduling-"));
    dirs.push(dir);
    vi.stubEnv("SCHEDULING_PERSISTENCE", "redis");
    vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", "redis://127.0.0.1:9/0");
    vi.stubEnv("SCHEDULING_SQLITE_PATH", join(dir, "scheduling.sqlite"));
    redis.failKey = ":scheduling:profiles";
    const fence = createPersistenceFence();
    const persistence = fenceSchedulingPersistence(createSchedulingPersistence(), fence);
    const updatedAt = Date.now();
    const snapshot = {
      profiles: [{ id: "host", updatedAt } as unknown as SchedulingProfile],
      availability: Array.from({ length: 20 }, (_, index) => ({
        profileId: `host-${index}`,
        availability: { updatedAt } as unknown as WeeklyAvailability,
      })),
      eventTypes: [],
      calendars: [],
    };

    const saved = Promise.resolve(persistence.save(snapshot)).then(
      () => "saved",
      (error: unknown) => String(error),
    );
    await delay(1);
    await fence.hold("backup", 10_000);
    const landedBeforeHold = redis.evals.length;
    await delay(150);
    fence.release("backup");

    expect(await saved).toMatch(/OOM command not allowed/);
    expect(landedBeforeHold).toBe(20);
    expect(redis.evals.length).toBe(landedBeforeHold);
    await persistence.close?.();
  });
});

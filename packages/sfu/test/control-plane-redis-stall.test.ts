import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisBackend } from "../server/controlPlane/backends/redis.js";
import { createMeeting } from "../server/controlPlane/meetingCommands.js";
import { StoreUnavailableError } from "../server/controlPlane/model.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const options = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };
const DEADLINE_MS = 300;
const PAUSE_MS = 1_500;

let redis: RedisServer | null = null;

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(7000);
});

afterAll(() => {
  redis?.stop();
});

describe.skipIf(!hasRedis)("a Redis store whose server stops answering", () => {
  it("fails a commit as a storage error at the request deadline, then works again once Redis answers", async () => {
    const store = controlPlaneStore(
      await createRedisBackend({ redisUrl: redis!.url, keyPrefix: `stall:${Date.now()}`, requestDeadlineMs: DEADLINE_MS }),
    );
    const admin = createClient({ url: redis!.url });
    await admin.connect();
    try {
      expect((await store.commit(createMeeting({ title: "Before", scheduledStartAt: 1_900_000_000_000 }, options))).ok).toBe(true);
      await admin.sendCommand(["CLIENT", "PAUSE", String(PAUSE_MS), "ALL"]);
      const started = performance.now();
      await expect(store.commit(createMeeting({ title: "During", scheduledStartAt: 1_900_000_000_000 }, options))).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(DEADLINE_MS * 0.9);
      expect(waited).toBeLessThan(PAUSE_MS);
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      expect((await store.commit(createMeeting({ title: "After", scheduledStartAt: 1_900_000_000_000 }, options))).ok).toBe(true);
    } finally {
      await admin.quit();
      await store.close();
    }
  }, 20_000);
});

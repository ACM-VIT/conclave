import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlPlaneRedisKeys, createRedisBackend } from "../server/controlPlane/backends/redis.js";
import { createMeeting, meetingById } from "../server/controlPlane/meetingCommands.js";
import { StoreUnavailableError } from "../server/controlPlane/model.js";
import { allWebinars, createWebinar } from "../server/controlPlane/webinarCommands.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { startRedisProxy, type ProxyFate } from "./support/redisProxy.js";
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

  const dataCommands = async (admin: { sendCommand: (args: string[]) => Promise<unknown> }): Promise<number> => {
    const info = String(await admin.sendCommand(["INFO", "commandstats"]));
    return [...info.matchAll(/cmdstat_(hget|hmget|hgetall|eval|exec|smembers):calls=(\d+)/g)].reduce((sum, match) => sum + Number(match[2]), 0);
  };

  const stalledStore = async (label: string) => {
    const store = controlPlaneStore(
      await createRedisBackend({ redisUrl: redis!.url, keyPrefix: `${label}:${Date.now()}`, requestDeadlineMs: DEADLINE_MS }),
    );
    const admin = createClient({ url: redis!.url });
    await admin.connect();
    expect((await store.commit(createMeeting({ title: "Before", scheduledStartAt: 1_900_000_000_000 }, options))).ok).toBe(true);
    await admin.sendCommand(["CLIENT", "PAUSE", String(PAUSE_MS * 2), "ALL"]);
    await expect(store.commit(createMeeting({ title: "Stalls", scheduledStartAt: 1_900_000_000_000 }, options))).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    return { store, admin };
  };

  it("sends nothing for callers that already failed while a reconnect waited", async () => {
    const { store, admin } = await stalledStore("stall-queue");
    try {
      const failed = await Promise.allSettled(
        Array.from({ length: 20 }, () => store.commit(createMeeting({ title: "Waits", scheduledStartAt: 1_900_000_000_000 }, options))),
      );
      expect(failed.every((result) => result.status === "rejected")).toBe(true);
      const before = await dataCommands(admin);
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS * 2));
      expect(await dataCommands(admin)).toBe(before);
    } finally {
      await admin.quit();
      await store.close();
    }
  }, 20_000);

  it("closes at once while a reconnect waits on a stalled Redis", async () => {
    const { store, admin } = await stalledStore("stall-close");
    try {
      const closing = performance.now();
      await store.close();
      expect(performance.now() - closing).toBeLessThan(DEADLINE_MS);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS * 2));
      await admin.quit();
    }
  }, 20_000);
});

describe.skipIf(!hasRedis)("a Redis commit whose outcome the SFU did not hear", () => {
  const meeting = (title: string) => createMeeting({ title, scheduledStartAt: 1_900_000_000_000 }, options);

  const throughProxy = async (fates: ProxyFate[]) => {
    let scripts = 0;
    const proxy = await startRedisProxy(
      { host: "127.0.0.1", port: redis!.port },
      { label: "unheard", fate: (chunk) => (chunk.includes("\r\nEVAL\r\n") ? fates[scripts++] ?? "send" : "send") },
    );
    const prefix = `unheard:${Date.now()}:${Math.random()}`;
    const store = controlPlaneStore(
      await createRedisBackend({ redisUrl: proxy.url, keyPrefix: prefix, requestDeadlineMs: DEADLINE_MS }),
    );
    const admin = createClient({ url: redis!.url });
    await admin.connect();
    const records = controlPlaneRedisKeys(prefix).records.meeting;
    return {
      proxy,
      store,
      meetings: async () => Object.values(await admin.hGetAll(records)).map((raw) => JSON.parse(raw) as { rev: number; value: { title: string } }),
      stop: async () => {
        await store.close();
        await admin.quit();
        await proxy.close();
      },
    };
  };

  it("answers ok, with the one record it wrote, when Redis ran the script and the reply was lost", async () => {
    const world = await throughProxy(["lose-reply"]);
    try {
      const result = await world.store.commit(meeting("Reply lost"));
      expect(result).toMatchObject({ ok: true, value: { title: "Reply lost" } });
      const stored = await world.meetings();
      expect(stored.map((record) => record.value.title)).toEqual(["Reply lost"]);
      expect(result.ok && stored[0].rev).toBe(result.ok && result.rev);
      expect((await world.store.read(meetingById(result.ok ? result.value.id : "")))?.title).toBe("Reply lost");
    } finally {
      await world.stop();
    }
  }, 20_000);

  it("answers 503 and never applies the script when it reaches Redis only after the SFU gave up", async () => {
    const world = await throughProxy(["deliver-late"]);
    try {
      await expect(world.store.commit(meeting("Arrives late"))).rejects.toBeInstanceOf(StoreUnavailableError);
      await world.proxy.deliverLate();
      expect(await world.meetings()).toEqual([]);
      expect((await world.store.commit(meeting("Next"))).ok).toBe(true);
      expect((await world.meetings()).map((record) => record.value.title)).toEqual(["Next"]);
    } finally {
      await world.stop();
    }
  }, 20_000);

  it("fences a commit it could not resolve before its next commit runs", async () => {
    const world = await throughProxy(["deliver-late", "lose"]);
    try {
      await expect(world.store.commit(meeting("Unresolved"))).rejects.toBeInstanceOf(StoreUnavailableError);
      const next = await world.store.commit(
        createWebinar({ title: "Next", scheduledStartAt: 1_900_000_000_000 }, { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test" }),
      );
      expect(next.ok).toBe(true);
      await world.proxy.deliverLate();
      expect(await world.meetings()).toEqual([]);
      expect((await world.store.read(allWebinars)).map((webinar) => webinar.title)).toEqual(["Next"]);
    } finally {
      await world.stop();
    }
  }, 20_000);
});

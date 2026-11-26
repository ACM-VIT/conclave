import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneRedisKeys, createRedisBackend } from "../server/controlPlane/backends/redis.js";
import { createMeeting } from "../server/controlPlane/meetingCommands.js";
import { StoreUnavailableError } from "../server/controlPlane/model.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { startRedisProxy, type ProxyFate } from "./support/redisProxy.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const here = dirname(fileURLToPath(import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const CHILD = join(here, "support", "storeCommitProcess.ts");
const DEADLINE_MS = 400;
const options = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };
const meeting = (title: string) => createMeeting({ title, scheduledStartAt: 1_900_000_000_000 }, options);

let redis: RedisServer | null = null;

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(7040);
});

afterAll(() => {
  redis?.stop();
});

beforeEach(() => {
  for (const method of ["log", "info", "warn", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

const isScript = (chunk: Buffer): boolean => chunk.includes("\r\nEVAL\r\n");

const world = async (label: string, proxyOptions: { fates?: ProxyFate[]; slowScripts?: number[] }) => {
  let scripts = 0;
  const slow = [...(proxyOptions.slowScripts ?? [])];
  const proxy = await startRedisProxy(
    { host: "127.0.0.1", port: redis!.port },
    {
      label,
      fate: (chunk) => (isScript(chunk) ? proxyOptions.fates?.[scripts++] ?? "send" : "send"),
      jitter: (chunk) => (isScript(chunk) ? slow.shift() ?? 0 : 0),
    },
  );
  const prefix = `late:${label}:${Date.now()}:${Math.random()}`;
  const admin = createClient({ url: redis!.url });
  await admin.connect();
  const records = controlPlaneRedisKeys(prefix).records.meeting;
  const stores: Array<{ close: () => Promise<void> }> = [];
  const open = async (redisUrl: string) => {
    const store = controlPlaneStore(await createRedisBackend({ redisUrl, keyPrefix: prefix, requestDeadlineMs: DEADLINE_MS }));
    stores.push(store);
    return store;
  };
  return {
    proxy,
    prefix,
    throughProxy: () => open(proxy.url),
    direct: () => open(redis!.url),
    titles: async () =>
      Object.values(await admin.hGetAll(records))
        .map((raw) => (JSON.parse(raw) as { value: { title: string } }).value.title)
        .sort(),
    stop: async () => {
      await Promise.all(stores.map((store) => store.close()));
      await admin.quit();
      await proxy.close();
    },
  };
};

const commitInAnotherProcess = (redisUrl: string, prefix: string, title: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CHILD, redisUrl, prefix, String(DEADLINE_MS), title], {
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim().split("\n").pop() ?? "");
      else reject(new Error(`the committing process exited ${code}:\n${stderr}`));
    });
  });

describe.skipIf(!hasRedis)("a Redis commit that reaches Redis after its SFU answered 503", () => {
  it("creates nothing when another SFU's retry landed first and the SFU that sent it has exited", async () => {
    const shared = await world("retry", { fates: ["deliver-late", "lose"] });
    try {
      expect(await commitInAnotherProcess(shared.proxy.url, shared.prefix, "Original")).toBe("unavailable");
      const other = await shared.direct();
      expect((await other.commit(meeting("Retry"))).ok).toBe(true);
      await shared.proxy.deliverLate();
      expect(await shared.titles()).toEqual(["Retry"]);
    } finally {
      await shared.stop();
    }
  }, 30_000);

  it("creates nothing when it arrives before any other commit and the SFU that sent it has exited", async () => {
    const shared = await world("alone", { fates: ["deliver-late", "lose"] });
    try {
      expect(await commitInAnotherProcess(shared.proxy.url, shared.prefix, "Original")).toBe("unavailable");
      await shared.proxy.deliverLate();
      expect(await shared.titles()).toEqual([]);
      const other = await shared.direct();
      expect((await other.commit(meeting("Retry"))).ok).toBe(true);
      expect(await shared.titles()).toEqual(["Retry"]);
    } finally {
      await shared.stop();
    }
  }, 30_000);

  for (const [name, resolver] of [
    ["the SFU reconnects and reads the outcome", "send"],
    ["the SFU cannot read the outcome", "lose"],
  ] as const) {
    it(`creates nothing when the connection drops right after the script was sent and ${name}`, async () => {
      const shared = await world("hang-up", { fates: ["hang-up-late", resolver] });
      try {
        const store = await shared.throughProxy();
        await expect(store.commit(meeting("Sent then cut"))).rejects.toBeInstanceOf(StoreUnavailableError);
        await shared.proxy.deliverLate();
        expect(await shared.titles()).toEqual([]);
      } finally {
        await shared.stop();
      }
    }, 30_000);
  }
});

describe.skipIf(!hasRedis)("a Redis commit that reaches Redis after its permit ended", () => {
  it("is refused while its caller still waits, writes nothing, and the next commit works", async () => {
    const shared = await world("slow", { slowScripts: [DEADLINE_MS * 0.75] });
    try {
      const store = await shared.throughProxy();
      await expect(store.commit(meeting("Too slow"))).rejects.toBeInstanceOf(StoreUnavailableError);
      expect(await shared.titles()).toEqual([]);
      expect((await store.commit(meeting("In time"))).ok).toBe(true);
      expect(await shared.titles()).toEqual(["In time"]);
    } finally {
      await shared.stop();
    }
  }, 30_000);
});

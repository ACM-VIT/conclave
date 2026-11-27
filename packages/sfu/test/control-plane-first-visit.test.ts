import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { config } from "../config/config.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const here = dirname(fileURLToPath(import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const CHILD = join(here, "support", "sfuProcess.ts");
const USERS = Number(process.env.CONTROL_PLANE_FIRST_VISIT_USERS ?? 25);

type Sfu = { child: ChildProcessWithoutNullStreams; port: number };

let redis: RedisServer | null = null;
let dir = "";
const running: Sfu[] = [];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6840);
});

afterAll(() => {
  redis?.stop();
});

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      ({ child }) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.stdin.end();
        }),
    ),
  );
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const storeEnv = (mode: "sqlite" | "redis"): NodeJS.ProcessEnv => ({
  ...process.env,
  NODE_ENV: "test",
  CONTROL_PLANE_PERSISTENCE: mode,
  CONCLAVE_SQLITE_PATH: join(dir, "conclave.sqlite"),
  CONTROL_PLANE_JSON_PATH: join(dir, "control-plane.json"),
  SCHEDULING_PATH: join(dir, "scheduling.json"),
  SCHEDULED_MEETINGS_PATH: join(dir, "scheduled-meetings.json"),
  SCHEDULED_WEBINARS_PATH: join(dir, "scheduled-webinars.json"),
  SFU_PERSISTENCE_REDIS_URL: mode === "redis" ? redis!.url : "",
  SFU_PERSISTENCE_REDIS_KEY_PREFIX: `first-visit:${process.pid}:${Date.now()}`,
  REDIS_URL: "",
  SFU_REDIS_URL: "",
  SCHEDULING_PERSISTENCE: "",
  SCHEDULED_MEETINGS_PERSISTENCE: "",
  SCHEDULED_WEBINARS_PERSISTENCE: "",
  CONCLAVE_FALLBACK_IMPORT_DIR: "",
});

const startSfu = (name: string, env: NodeJS.ProcessEnv): Promise<Sfu> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CHILD, name], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const failed = () => reject(new Error(`SFU ${name} exited before listening:\n${output}`));
    child.once("exit", failed);
    child.once("error", reject);
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening (\d+)/.exec(output);
      if (!match) return;
      child.off("exit", failed);
      const sfu = { child, port: Number(match[1]) };
      running.push(sfu);
      resolve(sfu);
    });
  });

const firstVisit = async (sfu: Sfu, user: string) => {
  const response = await fetch(`http://127.0.0.1:${sfu.port}/scheduling/profile`, {
    headers: {
      "x-sfu-secret": config.sfuSecret,
      "x-sfu-client": "conclave",
      "x-user-id": user,
      "x-user-email": `${user}@example.test`,
      "x-user-name": user,
    },
  });
  const body = (await response.json()) as { profile?: { id: string } };
  return { status: response.status, id: body.profile?.id ?? null };
};

const modes = hasRedis ? (["sqlite", "redis"] as const) : (["sqlite"] as const);

describe.each(modes)("first dashboard visits on two %s SFUs at once", (mode) => {
  it(`make exactly one profile for each of ${USERS} hosts`, async () => {
    dir = mkdtempSync(join(tmpdir(), "sfu-first-visit-"));
    const env = storeEnv(mode);
    const [a, b] = await Promise.all([startSfu("A", env), startSfu("B", env)]);
    const users = Array.from({ length: USERS }, (_, index) => `first-visit-${index}`);

    const answers = await Promise.all(users.flatMap((user) => [firstVisit(a, user), firstVisit(b, user)]));

    expect(answers.every((answer) => answer.status === 200 && answer.id !== null)).toBe(true);
    for (let index = 0; index < users.length; index += 1) {
      expect(answers[2 * index + 1].id, users[index]).toBe(answers[2 * index].id);
    }
    const saved = { ...process.env };
    Object.assign(process.env, env);
    const observer = await openControlPlane(resolveControlPlaneConfig(), { importLegacy: false });
    process.env = saved;
    try {
      const stored = await observer.read((view) => ({
        profiles: view.all("profile").map((entry) => entry.value),
        hours: view.all("hours").map((entry) => entry.value.profileId),
      }));
      for (const user of users) {
        const mine = stored.profiles.filter((profile) => profile.userId === user);
        expect(mine.map((profile) => profile.id), user).toEqual([answers[2 * users.indexOf(user)].id]);
        expect(stored.hours.filter((profileId) => profileId === mine[0].id)).toHaveLength(1);
      }
    } finally {
      await observer.close();
    }
  }, 120_000);
});

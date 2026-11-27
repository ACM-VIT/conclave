import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";

export const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

const isFree = (port: number) =>
  new Promise<boolean>((done) => {
    const probe = createServer()
      .once("error", () => done(false))
      .listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });

export type RedisServer = { url: string; port: number; stop: () => void };

export const startRedis = async (from: number): Promise<RedisServer> => {
  let port = 0;
  for (let candidate = from; candidate < from + 40 && !port; candidate += 1) {
    if (await isFree(candidate)) port = candidate;
  }
  if (!port) throw new Error(`no free port in ${from}-${from + 39}`);
  const dir = mkdtempSync(join(tmpdir(), "sfu-redis-"));
  const server = spawn(
    "redis-server",
    ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir],
    { stdio: "ignore" },
  );
  const url = `redis://127.0.0.1:${port}`;
  const client = createClient({ url, socket: { reconnectStrategy: (retries) => (retries > 50 ? false : 100) } });
  client.on("error", () => {});
  await client.connect();
  await client.quit();
  return {
    url,
    port,
    stop: () => {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createClient } from "redis";

export const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

const isFree = (port: number) =>
  new Promise<boolean>((done) => {
    const probe = createServer().once("error", () => done(false)).listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });

/** Starts a throwaway redis-server on the first free port in [from, from + 10). */
export const startRedis = async (from: number): Promise<{ url: string; stop: () => void }> => {
  let port = 0;
  for (let candidate = from; candidate < from + 10 && !port; candidate += 1) {
    if (await isFree(candidate)) port = candidate;
  }
  if (!port) throw new Error(`no free port in ${from}-${from + 9}`);
  const server = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  const url = `redis://127.0.0.1:${port}`;
  const client = createClient({ url, socket: { reconnectStrategy: (retries) => (retries > 50 ? false : 100) } });
  client.on("error", () => {});
  await client.connect();
  await client.quit();
  return { url, stop: () => server.kill() };
};

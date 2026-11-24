import { createServer, connect, type Server, type Socket } from "node:net";
import type { Gates } from "./fakeServices.js";

export type RedisProxy = { url: string; close: () => Promise<void> };

export const startRedisProxy = async (
  target: { host: string; port: number },
  options: { label: string; gates: Gates; jitter: () => number; park: () => boolean },
): Promise<RedisProxy> => {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    let queue = Promise.resolve();
    client.on("data", (chunk) => {
      client.pause();
      queue = queue
        .then(() => (options.park() ? options.gates.admit("redis", options.label) : undefined))
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, options.jitter())))
        .then(() => {
          if (!upstream.destroyed) upstream.write(chunk);
          client.resume();
        });
    });
    upstream.on("data", (chunk) => {
      if (!client.destroyed) client.write(chunk);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no proxy port");
  return {
    url: `redis://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

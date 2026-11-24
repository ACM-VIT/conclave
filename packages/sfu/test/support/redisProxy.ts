import { createServer, connect, type Server, type Socket } from "node:net";
import type { Gates } from "./fakeServices.js";

export type ProxyFate = "send" | "lose-reply" | "deliver-late" | "lose";

export type RedisProxy = { url: string; deliverLate: () => Promise<void>; close: () => Promise<void> };

export const startRedisProxy = async (
  target: { host: string; port: number },
  options: {
    label: string;
    gates?: Gates;
    jitter?: () => number;
    park?: () => boolean;
    fate?: (chunk: Buffer) => ProxyFate;
  },
): Promise<RedisProxy> => {
  const sockets = new Set<Socket>();
  const late: Buffer[] = [];
  const server: Server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    let queue = Promise.resolve();
    let mode: ProxyFate = "send";
    client.on("data", (chunk) => {
      if (mode === "send") mode = options.fate?.(chunk) ?? "send";
      if (mode === "deliver-late") {
        late.push(chunk);
        return;
      }
      if (mode === "lose") return;
      client.pause();
      queue = queue
        .then(() => (options.park?.() && options.gates ? options.gates.admit("redis", options.label) : undefined))
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, options.jitter?.() ?? 0)))
        .then(() => {
          if (!upstream.destroyed) upstream.write(chunk);
          client.resume();
        });
    });
    upstream.on("data", (chunk) => {
      if (mode === "lose-reply") return;
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
    deliverLate: async () => {
      const held = late.splice(0);
      if (held.length === 0) throw new Error("no command was held back");
      const upstream = connect(target.port, target.host);
      await new Promise<void>((resolve, reject) => {
        upstream.once("error", reject);
        upstream.once("data", () => resolve());
        upstream.write(Buffer.concat(held));
      });
      upstream.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

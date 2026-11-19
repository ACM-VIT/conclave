import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { attachSocketAuth, getSocketAuthUser } from "../server/socket/auth.js";
import { config } from "../config/config.js";

type Middleware = (socket: Socket, next: (error?: Error) => void) => void;

const handshake = (token: string) => {
  let middleware!: Middleware;
  attachSocketAuth({ use: (fn: Middleware) => { middleware = fn; } } as unknown as SocketIOServer, {
    config: { ...config, sfuSecret: "secret" },
  });
  const socket = { handshake: { auth: { token } }, data: {} } as unknown as Socket;
  return new Promise<{ error?: Error; socket: Socket }>((resolve) => {
    middleware(socket, (error) => resolve({ error, socket }));
  });
};

describe("SFU socket login token type", () => {
  it("accepts a web join token", async () => {
    const result = await handshake(jwt.sign({ userId: "a@example.com", email: "a@example.com", sessionId: "s", clientId: "conclave" }, "secret"));
    expect(result.error).toBeUndefined();
    expect(getSocketAuthUser(result.socket)?.email).toBe("a@example.com");
  });

  it.each([
    ["the assistant authorization token", { tokenUse: "conclave:assistant", userId: "u#s", isAdmin: true }, { audience: "conclave-web", issuer: "conclave-sfu" }],
    ["a room AI access token", { tokenUse: "room-ai:access", userId: "u#s" }, { audience: "conclave-web", issuer: "conclave-sfu" }],
    ["a transcript token signed with the shared secret", { userId: "u#s", isAdmin: true, isHost: true, clientId: "conclave" }, { audience: "conclave-transcript-worker", issuer: "conclave-sfu" }],
    ["a chat image upload token", { type: "chat-image-upload", userId: "u#s" }, {}],
  ])("rejects %s", async (_label, payload, options) => {
    const result = await handshake(jwt.sign(payload, "secret", options));
    expect(result.error?.message).toBe("Authentication error: Invalid token payload");
  });

  it("rejects a token signed with another algorithm", async () => {
    const result = await handshake(jwt.sign({ userId: "u" }, "secret", { algorithm: "HS512" }));
    expect(result.error?.message).toBe("Authentication error: Invalid token");
  });
});

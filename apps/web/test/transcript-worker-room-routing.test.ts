import { describe, expect, it, vi } from "vitest";
import { transcriptRoomObjectName } from "../transcript-worker/src/auth";
import worker from "../transcript-worker/src/index";
import type { Env } from "../transcript-worker/src/types";

vi.mock("../transcript-worker/src/room", () => ({ TranscriptRoom: class {} }));

const base64Url = (bytes: Uint8Array | string): string => {
  const binary = typeof bytes === "string" ? bytes : String.fromCharCode(...Array.from(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const sign = async (payload: Record<string, unknown>, secret = "secret") => {
  const input = `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
};

const token = (clientId: string, roomId = "abc-def-ghi") => sign({
  aud: "conclave-transcript-worker",
  exp: Math.floor(Date.now() / 1000) + 60,
  sub: "u",
  userId: "u",
  displayName: "U",
  roomId,
  clientId,
  channelId: `${clientId}:${roomId}`,
  isAdmin: false,
  isHost: false,
  capabilities: { start: false, takeover: false, stop: false, ask: false },
});

const makeEnv = () => {
  const names: string[] = [];
  const env = {
    TRANSCRIPT_TOKEN_SECRET: "secret",
    TRANSCRIPT_ROOM: {
      idFromName: (name: string) => { names.push(name); return name; },
      get: () => ({ fetch: async () => new Response("ok") }),
    },
  } as unknown as Env;
  return { env, names };
};

const connect = (env: Env, roomId: string, jwt: string) =>
  worker.fetch(new Request(`https://worker.test/rooms/${encodeURIComponent(roomId)}/ws?token=${jwt}`, {
    headers: { upgrade: "websocket" },
  }), env);

describe("transcript room routing", () => {
  it("puts the same room code under different tenants in different rooms", async () => {
    const { env, names } = makeEnv();
    await connect(env, "abc-def-ghi", await token("conclave"));
    await connect(env, "abc-def-ghi", await token("evil"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("keeps the main tenant on the bare room code so existing transcripts stay reachable", async () => {
    const { env, names } = makeEnv();
    await connect(env, "abc-def-ghi", await token("conclave"));
    expect(names).toEqual(["abc-def-ghi"]);
  });

  it("refuses a request without a valid token for that room", async () => {
    const { env, names } = makeEnv();
    expect((await connect(env, "abc-def-ghi", "bad")).status).toBe(401);
    expect((await connect(env, "other-room", await token("conclave"))).status).toBe(401);
    expect(names).toEqual([]);
  });

  it("cannot be made to collide with a main-tenant room id", () => {
    const tenantName = transcriptRoomObjectName({ roomId: "room", clientId: "x", channelId: "x:room" });
    const mainName = transcriptRoomObjectName({ roomId: "x:room", clientId: "conclave", channelId: "conclave:x:room" });
    expect(tenantName).not.toBe(mainName);
  });
});

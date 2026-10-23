import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import type { Room } from "../config/classes/Room.js";
import { RoomAiCredentials } from "../server/roomAiCredentials.js";
import { createSfuApp } from "../server/http/createApp.js";
import { createSfuState } from "../server/state.js";
import { registerRoomAiHandlers } from "../server/socket/handlers/roomAiHandlers.js";
import type { ConnectionContext } from "../server/socket/context.js";
import { createChatImageUploadToken } from "../server/chatImages.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function fixture() {
  const socket = { id: "socket", on: vi.fn() };
  const member = { id: "member", isObserver: false, socket };
  const room = {
    id: "room",
    clientId: "client",
    channelId: "client:room",
    getClient: vi.fn((id: string) => (id === member.id ? member : undefined)),
    aiCredentials: new RoomAiCredentials(),
    areImageAttachmentsEnabled: true,
    isChatLocked: false,
    addChatImageAsset: vi.fn(() => ({ ok: true })),
  };
  return { socket, member, room };
}

describe("room AI credentials", () => {
  it("isolates providers and rooms, limits management to contributors/hosts, and hides keys from snapshots", () => {
    const a = new RoomAiCredentials();
    const b = new RoomAiCredentials();
    a.set("openai", " sk-room-only ", "alice", false);
    a.set("anthropic", "sk-ant-room-only", "bob", false);
    expect(a.get("openai")).toBe("sk-room-only");
    expect(b.get("openai")).toBeUndefined();
    expect(() => a.set("openai", "sk-ant-wrong", "alice", false)).toThrow(
      "valid OpenAI",
    );
    expect(() => a.remove("openai", "bob", false)).toThrow("contributor");
    expect(() => a.set("openai", "sk-replace", "bob", false)).toThrow(
      "contributor",
    );
    expect(a.status({})).toMatchObject({
      openai: { source: "room", ownerId: "alice" },
      anthropic: { source: "room", ownerId: "bob" },
      sarvam: { source: null },
    });
    expect(
      JSON.stringify({ credentials: a, state: a.status({}) }),
    ).not.toContain("sk-");
    expect(a.status({ OPENAI_API_KEY: "sk-deployment" }).openai).toEqual({
      source: "deployment",
    });
    a.remove("openai", "host", true);
    expect(a.get("openai")).toBeUndefined();
    a.clear();
    expect(a.get("anthropic")).toBeUndefined();
  });

  it("binds socket configuration to active members and broadcasts metadata only", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { socket, room, member } = fixture();
    const emit = vi.fn();
    const context = {
      socket,
      io: { to: () => ({ emit }) },
      currentRoom: room,
      currentClient: member,
    } as unknown as ConnectionContext;
    registerRoomAiHandlers(context);
    const handlers = Object.fromEntries(socket.on.mock.calls) as Record<
      string,
      (...args: unknown[]) => void
    >;
    const ack = vi.fn();
    handlers["ai:configure"](
      { roomId: "room", provider: "openai", apiKey: "sk-donation" },
      ack,
    );
    expect(ack.mock.calls.at(-1)?.[0]).toMatchObject({
      state: { openai: { source: "room", ownerId: "member" } },
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("sk-donation");
    expect(room.aiCredentials.get("openai")).toBe("sk-donation");
    member.isObserver = true;
    handlers["ai:configure"](
      { roomId: "room", provider: "openai", remove: true },
      ack,
    );
    expect(ack).toHaveBeenLastCalledWith({
      error: expect.stringContaining("Join") as unknown,
    });
    member.isObserver = false;
    room.getClient.mockReturnValue(undefined);
    handlers["ai:configure"](
      { roomId: "room", provider: "openai", remove: true },
      ack,
    );
    expect(ack).toHaveBeenLastCalledWith({
      error: expect.stringContaining("Join") as unknown,
    });
    expect(room.aiCredentials.get("openai")).toBe("sk-donation");
    expect(() => handlers["ai:settings"]()).not.toThrow();
  });
});

async function start() {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("TRANSCRIPT_TOKEN_SECRET", "worker-secret");
  const { room, member } = fixture();
  const state = createSfuState();
  state.rooms.set(room.channelId, room as unknown as Room);
  const moderateImage = vi.fn(async () => ({
    blocked: false,
    categories: [] as string[],
  }));
  const app = createSfuApp({
    state,
    config: {
      ...config,
      sfuSecret: "server-secret",
      openAi: { ...config.openAi, apiKey: "" },
    },
    moderateImage,
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  const url = `http://127.0.0.1:${address.port}`;
  const identity = {
    roomId: room.id,
    clientId: room.clientId,
    channelId: room.channelId,
    userId: member.id,
    providers: ["openai"],
  };
  const read = (secret: string, overrides = {}) =>
    fetch(`${url}/internal/ai/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-room-ai-secret": secret,
      },
      body: JSON.stringify({ ...identity, ...overrides }),
    });
  return { room, member, url, read, moderateImage };
}

describe("server-only room credential access", () => {
  it("requires a shared server secret and exact active room identity", async () => {
    const { room, member, read } = await start();
    room.aiCredentials.set("openai", "sk-donation", member.id, false);
    room.aiCredentials.set("anthropic", "sk-ant-donation", member.id, false);
    expect((await read("")).status).toBe(401);
    expect((await read("browser-room-token")).status).toBe(401);
    expect(
      (await read("server-secret", { clientId: "other-client" })).status,
    ).toBe(403);
    expect((await read("server-secret", { roomId: "other-room" })).status).toBe(
      403,
    );
    expect((await read("server-secret", { userId: "departed" })).status).toBe(
      403,
    );
    member.isObserver = true;
    expect((await read("server-secret")).status).toBe(403);
    member.isObserver = false;
    for (const secret of ["server-secret", "worker-secret"]) {
      const response = await read(secret);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ OPENAI_API_KEY: "sk-donation" });
    }
    vi.stubEnv("OPENAI_API_KEY", "sk-deployment");
    expect(await (await read("server-secret")).json()).toEqual({
      OPENAI_API_KEY: "sk-deployment",
    });
  });

  it("uses the room OpenAI key for image safety and continues to reject flagged images", async () => {
    const { room, member, url, moderateImage } = await start();
    room.aiCredentials.set("openai", "sk-image-safety", member.id, false);
    const upload = async () => {
      const token = createChatImageUploadToken(
        "server-secret",
        room.channelId,
        member.id,
      );
      return fetch(`${url}/chat-images`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "image/png",
        },
        body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      });
    };
    const response = await upload();
    expect(response.status).toBe(201);
    expect(moderateImage).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-image-safety" }),
    );
    expect(await response.text()).not.toContain("sk-image-safety");
    moderateImage.mockResolvedValueOnce({
      blocked: true,
      categories: ["violence"],
    });
    expect((await upload()).status).toBe(422);
    expect(room.addChatImageAsset).toHaveBeenCalledTimes(1);
  });
});

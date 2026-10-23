import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { Admin } from "../config/classes/Admin.js";
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
  vi.unstubAllGlobals();
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
  it("authorizes each feature against its effective provider and keeps models independent", () => {
    const keys = new RoomAiCredentials();
    keys.set("anthropic", "sk-ant-owner", "owner", false);
    keys.configureFeature("minutes", {model: "claude-opus-5-5", maxOutputTokens: 64000}, "owner", false);
    expect(keys.featureSettings.minutes).toEqual({model: "claude-opus-5-5", maxOutputTokens: 64000});
    expect(keys.featureSettings.games).toBeUndefined();
    const initial = keys.assistantModel;
    keys.configureFeature("assistant", {model: "claude-haiku-5-5"}, "owner", false);
    expect(keys.assistantModel).toBe(initial);
    expect(() => keys.configureFeature("games", {model: "gpt-6-luna"}, "owner", false)).toThrow("Only a host");
    expect(() => keys.configureFeature("minutes", {maxOutputTokens: 32000}, "peer", false)).toThrow("Only a host");
    expect(() => keys.configureFeature("minutes", {maxOutputTokens: 32000}, "owner", false, {ANTHROPIC_API_KEY: "deployment"})).toThrow("Only a host");
    keys.configureFeature("games", {model: "gpt-6-luna", researchTokens: 20000}, "host", true);
    expect(keys.featureSettings.games?.researchTokens).toBe(20000);
    expect(JSON.stringify(keys.status({}))).not.toContain("sk-ant-owner");
    keys.clear();
    expect(keys.featureSettings).toEqual({});
  });
  it("keeps the first saved room model when concurrent key shares suggest different initial models", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { socket, room, member } = fixture();
    const peerSocket = { id: "peer-socket", on: vi.fn() };
    const peer = { id: "peer", isObserver: false, socket: peerSocket };
    room.getClient.mockImplementation((id: string) =>
      id === member.id ? member : id === peer.id ? peer : undefined,
    );
    for (const [connection, client] of [
      [socket, member],
      [peerSocket, peer],
    ] as const) {
      registerRoomAiHandlers({
        socket: connection,
        currentRoom: room,
        currentClient: client,
        io: { to: () => ({ emit: vi.fn() }) },
      } as unknown as ConnectionContext);
    }
    const configure = (
      connection: typeof socket,
      data: Record<string, unknown>,
    ) => {
      const handlers = Object.fromEntries(connection.on.mock.calls) as Record<
        string,
        (...args: unknown[]) => void
      >;
      const callback = vi.fn();
      handlers["ai:configure"]({ roomId: "room", ...data }, callback);
      expect(callback.mock.calls[0][0]).not.toHaveProperty("error");
    };
    configure(socket, {
      provider: "openai",
      apiKey: "sk-first-fixture",
      model: "gpt-6.2-sol",
    });
    configure(peerSocket, {
      provider: "anthropic",
      apiKey: "sk-ant-second-fixture",
      model: "claude-sonnet-5-6",
    });
    expect(room.aiCredentials.assistantModel).toBe("gpt-6.2-sol");
    configure(peerSocket, {
      provider: "anthropic",
      model: "claude-sonnet-5-6",
    });
    expect(room.aiCredentials.assistantModel).toBe("claude-sonnet-5-6");
  });

  it("stores audio-only room keys without an automatic text selection", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { socket, room, member } = fixture();
    registerRoomAiHandlers({
      socket,
      currentRoom: room,
      currentClient: member,
      io: { to: () => ({ emit: vi.fn() }) },
    } as unknown as ConnectionContext);
    const handlers = Object.fromEntries(socket.on.mock.calls) as Record<
      string,
      (...args: unknown[]) => void
    >;
    const callback = vi.fn();
    handlers["ai:configure"](
      {
        roomId: "room",
        provider: "openai",
        apiKey: "sk-audio-only-fixture",
        model: null,
      },
      callback,
    );
    expect(callback.mock.calls[0][0]).toMatchObject({
      state: { openai: { source: "room" }, assistantModel: null },
    });
    expect(room.aiCredentials.get("openai")).toBe("sk-audio-only-fixture");
  });

  it("rejects an in-flight catalog after a key changes and changes back", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { socket, room, member } = fixture();
    room.aiCredentials.set("openai", "sk-original", "member", false);
    registerRoomAiHandlers({
      socket,
      currentRoom: room,
      currentClient: member,
    } as unknown as ConnectionContext);
    const handlers = Object.fromEntries(socket.on.mock.calls) as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >;
    const ack = vi.fn();
    const pending = handlers["ai:models"]({ roomId: "room" }, ack);
    room.aiCredentials.set("openai", "sk-replacement", "member", false);
    room.aiCredentials.set("openai", "sk-original", "member", false);
    complete(Response.json({ data: [{ id: "gpt-6.1-sol" }] }));
    await pending;
    expect(ack).toHaveBeenLastCalledWith({
      error: "AI keys changed. Refresh models again.",
    });
  });

  it("refreshes the shared catalog for the room but keeps personal-key refreshes private", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] })),
    );
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { socket, room, member } = fixture();
    room.aiCredentials.set("openai", "sk-shared", "member", false);
    const emit = vi.fn();
    registerRoomAiHandlers({
      socket,
      io: { to: () => ({ emit }) },
      currentRoom: room,
      currentClient: member,
    } as unknown as ConnectionContext);
    const handlers = Object.fromEntries(socket.on.mock.calls) as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >;
    const ack = vi.fn();
    await handlers["ai:models"]({ roomId: "room", refresh: true }, ack);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe("ai:changed");
    await handlers["ai:models"](
      {
        roomId: "room",
        provider: "openai",
        apiKey: "sk-personal",
        refresh: true,
      },
      ack,
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(room.aiCredentials.get("openai")).toBe("sk-shared");
    expect(
      JSON.stringify([...ack.mock.calls, ...emit.mock.calls]),
    ).not.toContain("sk-");
  });

  it("scopes cached catalogs to effective room credentials and never retains personal overrides", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({ data: [{ id: "gpt-6.1-sol" }] }),
    );
    vi.stubGlobal("fetch", fetcher);
    const keys = new RoomAiCredentials();
    keys.set("openai", "sk-room", "alice", false);
    await keys.models("openai", {});
    await keys.models("openai", {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await keys.models("openai", {}, { apiKey: "sk-personal" });
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({
      headers: { authorization: "Bearer sk-personal" },
    });
    expect(keys.get("openai")).toBe("sk-room");
    await keys.models("openai", {});
    expect(fetcher).toHaveBeenCalledTimes(2);
    keys.set("openai", "sk-replacement", "alice", false);
    await keys.models("openai", {});
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({
      headers: { authorization: "Bearer sk-replacement" },
    });
    await keys.models("openai", {}, { refresh: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
    keys.remove("openai", "alice", false);
    expect((await keys.models("openai", {})).source).toBe("built-in");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(keys)).not.toContain("sk-");
    keys.clear();
  });

  it("only returns model metadata to current room members, including after an asynchronous lookup", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { socket, room, member } = fixture();
    room.aiCredentials.set("openai", "sk-room", "member", false);
    registerRoomAiHandlers({
      socket,
      currentRoom: room,
      currentClient: member,
    } as unknown as ConnectionContext);
    const handlers = Object.fromEntries(socket.on.mock.calls) as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >;
    const ack = vi.fn();
    await handlers["ai:models"]({ roomId: "different-room" }, ack);
    expect(ack).toHaveBeenLastCalledWith({
      error: expect.stringContaining("meeting changed") as unknown,
    });
    const pending = handlers["ai:models"]({ roomId: "room" }, ack);
    member.isObserver = true;
    complete(Response.json({ data: [{ id: "gpt-6.1-sol" }] }));
    await pending;
    expect(ack).toHaveBeenLastCalledWith({
      error: expect.stringContaining("connection changed") as unknown,
    });
    expect(JSON.stringify(ack.mock.calls)).not.toContain("sk-room");
  });
  it("requires a host for unconfigured or deployment-backed model choices", () => {
    const keys = new RoomAiCredentials();
    expect(() => keys.setModel("gpt-5.6-sol", "attendee", false)).toThrow(
      "Only a host",
    );
    const env = { OPENAI_API_KEY: "sk-deployment" };
    keys.set("openai", "sk-contribution", "attendee", false, env);
    expect(keys.assistantModel).toBeNull();
    expect(() => keys.setModel("gpt-5.6-sol", "attendee", false, env)).toThrow(
      "Only a host",
    );
    keys.setModel("gpt-5.6-sol", "host", true, env);
    expect(keys.assistantModel).toBe("gpt-5.6-sol");
  });
  it("selects the first contributed provider, shares model changes, and keeps contributor permissions", () => {
    const keys = new RoomAiCredentials();
    keys.set("sarvam", "speech-fixture", "alice", false);
    expect(keys.assistantModel).toBeNull();
    keys.set("anthropic", "sk-ant-fixture", "alice", false);
    expect(keys.status({}).assistantModel).toBe("claude-sonnet-5-5");
    keys.setModel("claude-haiku-5-5", "alice", false);
    expect(keys.status({}).assistantModel).toBe("claude-haiku-5-5");
    expect(() => keys.setModel("claude-opus-5-5", "bob", false)).toThrow(
      "contributor",
    );
    expect(() => keys.setModel("unregistered-model", "alice", false)).toThrow(
      "supported",
    );
    keys.setModel("claude-opus-5-5", "host", true);
    keys.remove("anthropic", "alice", false);
    expect(keys.assistantModel).toBe("claude-opus-5-5"); // Missing keys prompt setup; never silently switch providers.
    keys.clear();
    expect(keys.assistantModel).toBeNull();
  });

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
    handlers["ai:configure"](
      {
        roomId: "room",
        provider: "anthropic",
        apiKey: "sk-ant-new",
        model: "gpt-5.6-terra",
      },
      ack,
    );
    expect(ack.mock.calls.at(-1)?.[0]).toHaveProperty("error");
    expect(room.aiCredentials.get("anthropic")).toBeUndefined();
    handlers["ai:configure"](
      { roomId: "room", provider: "openai", model: "gpt-5.6-luna" },
      ack,
    );
    expect(ack.mock.calls.at(-1)?.[0]).toMatchObject({
      state: { assistantModel: "gpt-5.6-luna" },
    });
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
  it("uses live membership and permission checks for assistant settings tools and voice access", async () => {
    const {room, member, url, read} = await start();
    room.aiCredentials.set("anthropic", "sk-ant-tool-private", member.id, false);
    const configure = (secret: string, extra: Record<string, unknown> = {}) => fetch(`${url}/internal/ai/settings`, {method: "POST", headers: {"content-type": "application/json", "x-room-ai-secret": secret}, body: JSON.stringify({roomId: room.id, clientId: room.clientId, channelId: room.channelId, userId: member.id, feature: "minutes", settings: {model: "claude-opus-5-5", researchTokens: 24000}, ...extra})});
    expect((await configure("")).status).toBe(401);
    expect((await configure("server-secret", {userId: "departed"})).status).toBe(403);
    expect((await configure("server-secret", {feature: "games", settings: {model: "gpt-6-luna"}, isAdmin: true})).status).toBe(403);
    const response = await configure("server-secret");
    expect(response.status).toBe(200);
    const metadata = await response.text();
    expect(metadata).toContain("claude-opus-5-5");
    expect(metadata).not.toContain("sk-ant-tool-private");
    expect((await read("server-secret", {requireHost: true})).status).toBe(403);
    Object.setPrototypeOf(member, Admin.prototype);
    expect((await configure("server-secret", {feature: "games", settings: {model: "gpt-6-luna"}})).status).toBe(200);
    expect((await read("server-secret", {requireHost: true})).status).toBe(200);
    member.isObserver = true;
    expect((await configure("server-secret")).status).toBe(403);
  });
  it("returns the authoritative provider endpoint with the selected room credential", async () => {
    const { room, member, read } = await start();
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://room-provider.example");
    room.aiCredentials.set("anthropic", "sk-ant-room", member.id, false);
    const response = await read("server-secret", { providers: ["anthropic"] });
    expect(await response.json()).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-room",
      ANTHROPIC_BASE_URL: "https://room-provider.example",
    });
  });

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
      expect(await response.json()).toEqual({
        OPENAI_API_KEY: "sk-donation",
        CONCLAVE_AI_SETTINGS: JSON.stringify(room.aiCredentials.effectiveFeatureSettings({})),
        CONCLAVE_ASSISTANT_MODEL: "gpt-6.1-sol",
      });
    }
    vi.stubEnv("OPENAI_API_KEY", "sk-deployment");
    expect(await (await read("server-secret")).json()).toEqual({
      OPENAI_API_KEY: "sk-deployment",
      CONCLAVE_AI_SETTINGS: JSON.stringify(room.aiCredentials.effectiveFeatureSettings({})),
      CONCLAVE_ASSISTANT_MODEL: "gpt-6.1-sol",
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

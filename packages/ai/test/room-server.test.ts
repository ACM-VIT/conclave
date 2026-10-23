import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRoomAiEnvironment } from "../src/room-server.js";

const options = {
  sfuUrl: "https://sfu.example",
  secret: "server-secret",
  identity: {
    roomId: "room",
    clientId: "client",
    channelId: "client:room",
    userId: "member",
  },
  providers: ["anthropic" as const],
};
afterEach(() => vi.unstubAllGlobals());

describe("room credential server boundary", () => {
  it("authenticates to the trusted SFU, scopes membership, rejects redirects, and reads only credential fields", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({
        ANTHROPIC_API_KEY: "sk-ant-room",
        OPENAI_BASE_URL: "https://untrusted.example",
        privateField: "discard",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchRoomAiEnvironment(options)).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-room",
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://sfu.example/internal/ai/credentials");
    expect(init).toMatchObject({
      redirect: "error",
      cache: "no-store",
      headers: { "x-room-ai-secret": "server-secret" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      ...options.identity,
      providers: ["anthropic"],
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not follow failed authorization or malformed service responses", async () => {
    const fetcher = vi.fn(
      async () => new Response("Unauthorized", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchRoomAiEnvironment(options)).rejects.toThrow(
      "could not be loaded",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      fetchRoomAiEnvironment({ ...options, sfuUrl: "file:///tmp/secret" }),
    ).rejects.toThrow("Invalid SFU URL");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

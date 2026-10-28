import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/sfu/rooms/[roomId]/route";

vi.mock("@/lib/sfu-admin-auth", () => ({ resolveSfuClientId: () => "conclave", resolveSfuSecret: () => "fixture" }));
vi.mock("@/lib/sfu-url", () => ({ resolveSfuUrls: () => ["http://a.test", "http://b.test"] }));
vi.mock("@/app/lib/utils", () => ({ readResponseError: async () => "Unavailable" }));
const get = () => GET(new Request("http://localhost/api/sfu/rooms/room"), { params: Promise.resolve({ roomId: "room" }) });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("room occupancy during SFU recovery", () => {
  it("reads the healthy owner even if the default instance fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("a.test")
      ? new Response(null, { status: 503 }) : Response.json({ room: { id: "room", userCount: 4 } })));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: { id: "room", userCount: 4 } });
  });

  it("does not claim that a room is empty when an instance could not be checked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("a.test")
      ? Promise.reject(new Error("offline")) : new Response(null, { status: 404 })));
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
  });

  it("returns no room only after all configured instances confirm its absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    expect(await (await get()).json()).toEqual({ room: null });
  });

  it("aborts a stalled response body within two seconds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const signal = options.signal!;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      };
    }));
    const started = performance.now();
    const response = await get();
    expect(response.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

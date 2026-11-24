import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/sfu/rooms/[roomId]/route";
import { guestPassCookieForNewBrowser, resolveGuestJoinIdentity } from "../src/lib/guest-pass";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/sfu-admin-auth", () => ({ resolveSfuClientId: () => "conclave", resolveSfuSecret: () => "fixture" }));
vi.mock("@/lib/sfu-url", () => ({ resolveSfuUrls: () => ["http://a.test", "http://b.test"] }));
vi.mock("@/app/lib/utils", () => ({ readResponseError: async () => "Unavailable" }));
vi.mock("@/lib/guest-pass", () => import("../src/lib/guest-pass"));

const get = (query = "?sessionId=s1") =>
  GET(new Request(`http://localhost/api/sfu/rooms/room${query}`), {
    params: Promise.resolve({ roomId: "room" }),
  });
const member = (room: { id: string; userCount: number } | null) =>
  Response.json({ room, viewerIsMember: true });

beforeEach(() => {
  getSession.mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("room occupancy during SFU recovery", () => {
  it("reads the healthy owner even if the default instance fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("a.test")
      ? new Response(null, { status: 503 }) : member({ id: "room", userCount: 4 })));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: { id: "room", userCount: 4 } });
  });

  it("does not claim that a room is empty when an instance could not be checked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("a.test")
      ? Promise.reject(new Error("offline")) : member(null)));
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
  });

  it("returns no room only after all configured instances confirm its absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => member(null)));
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

describe("who may see a room's headcount", () => {
  it("asks the SFU about the tab's guest session", async () => {
    const fetchMock = vi.fn(async () => member({ id: "room", userCount: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    await get("?sessionId=s1");
    const asked = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(asked.searchParams.get("viewerKey")).toBe("guest-s1");
  });

  it("asks the SFU about the guest's pass, the one the join token carries, from any tab", async () => {
    const cookie = guestPassCookieForNewBrowser(
      "fixture",
      new Request("http://localhost/api/guest-pass", { method: "POST" }),
    )!.split(";")[0];
    const joined = resolveGuestJoinIdentity({
      sfuSecret: "fixture",
      seat: { clientId: "conclave", roomId: "room", sessionId: "tab-1" },
      request: new Request("http://localhost/api/sfu/join", { method: "POST", headers: { cookie } }),
      body: { sessionId: "tab-1", guestId: "" },
    });
    if (!joined.ok) throw new Error(joined.error);
    const fetchMock = vi.fn(async () => member({ id: "room", userCount: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const query of ["?sessionId=tab-2", ""]) {
      const response = await GET(
        new Request(`http://localhost/api/sfu/rooms/room${query}`, { headers: { cookie } }),
        { params: Promise.resolve({ roomId: "room" }) },
      );
      expect(response.status).toBe(200);
    }
    for (const call of fetchMock.mock.calls) {
      const asked = new URL(String((call as unknown[])[0]));
      expect(asked.searchParams.getAll("viewerProof")).toEqual([joined.claims.guestProof]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("sends no pass for a request another site made", async () => {
    const cookie = guestPassCookieForNewBrowser(
      "fixture",
      new Request("http://localhost/api/guest-pass", { method: "POST" }),
    )!.split(";")[0];
    const fetchMock = vi.fn(async () => member({ id: "room", userCount: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    await GET(
      new Request("http://localhost/api/sfu/rooms/room?sessionId=tab-2", {
        headers: { cookie, "sec-fetch-site": "cross-site" },
      }),
      { params: Promise.resolve({ roomId: "room" }) },
    );
    const asked = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(asked.searchParams.getAll("viewerProof")).toEqual([]);
  });

  it("asks the SFU about a signed-in visitor by their email", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "Ada@Example.com" } });
    const fetchMock = vi.fn(async () => member({ id: "room", userCount: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    await get("");
    const asked = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(asked.searchParams.get("viewerKey")).toBe("ada@example.com");
  });

  it("tells an anonymous caller nothing without asking the SFU", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await get("");
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a stranger the same way whether or not the room exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ room: { id: "room", userCount: 3 }, viewerIsMember: false })));
    const live = await get();
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ room: null, viewerIsMember: false })));
    const missing = await get();
    expect(live.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await live.json()).toEqual(await missing.json());
  });

  it("reveals nothing through an SFU too old to vouch for the visitor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ room: { id: "room", userCount: 3 } })));
    expect((await get()).status).toBe(403);
  });
});

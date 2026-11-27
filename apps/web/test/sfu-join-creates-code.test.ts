import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/sfu/join/route";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/sfu-user-auth", () => ({ lookupScheduledWebinarByRoomId: vi.fn() }));
vi.mock("@/lib/guest-pass", () => import("../src/lib/guest-pass"));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));
vi.mock("@/lib/sfu-super-admin", () => import("../src/lib/sfu-super-admin"));
vi.mock("@/lib/sfu-url", () => import("../src/lib/sfu-url"));
vi.mock("@/lib/sfu-routing-policy", () => import("../src/lib/sfu-routing-policy"));
vi.mock("@/app/lib/site-version", () => import("../src/app/lib/site-version"));

const SECRET = "creates-code-test-secret";
const ana = { user: { id: "ana", email: "ana@example.com", name: "Ana" } };

beforeEach(() => {
  getSession.mockResolvedValue(null);
  vi.stubEnv("SFU_SECRET", SECRET);
  vi.stubEnv("SFU_DEBUG_SECRET", "0");
  vi.stubEnv("SFU_URL", "http://localhost:3031");
  vi.stubEnv("SFU_URLS", "http://localhost:3031");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({ local: true, owner: { instanceUrl: "http://localhost:3031" }, draining: false }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const tokenFor = async (body: Record<string, unknown>) => {
  const response = await POST(
    new Request("http://localhost/api/sfu/join", {
      method: "POST",
      body: JSON.stringify({ roomId: "abc-mnop-xyz", sessionId: "session", ...body }),
    }),
  );
  expect(response.status).toBe(200);
  const { token } = (await response.json()) as { token: string };
  return jwt.verify(token, SECRET) as Record<string, unknown>;
};

describe("the claim that a join makes its code", () => {
  it("is signed into the token of a signed-in join from a page creating a new meeting", async () => {
    getSession.mockResolvedValue(ana);
    expect(await tokenFor({ isHost: true, createsMeeting: true })).toMatchObject({
      email: "ana@example.com",
      createsCode: true,
    });
  });

  it.each([
    ["a join that names the claim itself", true, { isHost: true, createsCode: true }],
    ["a host's join from a page that is not creating", true, { isHost: true, allowRoomCreation: true }],
    ["a guest's join from a page creating a new meeting", false, { isHost: true, createsMeeting: true }],
    [
      "a join to a scheduled room",
      true,
      { isHost: true, createsMeeting: true, roomId: "sched-0123abcd" },
    ],
    [
      "a webinar attendee's join",
      true,
      { createsMeeting: true, joinMode: "webinar_attendee" },
    ],
  ])("is never in the token of %s", async (_label, signedIn, body) => {
    if (signedIn) getSession.mockResolvedValue(ana);
    expect((await tokenFor(body)).createsCode).toBeUndefined();
  });
});

describe("room placement for an unassigned code", () => {
  it.each([404, 405, 501])("does not sign a join token when placement returns %s", async (status) => {
    getSession.mockResolvedValue(ana);
    const reserve = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(url);
      if (pathname === "/status") return Response.json({ healthy: true, draining: false });
      if (pathname.startsWith("/routing/rooms/")) return Response.json({ owner: null, placement: null });
      if (pathname.startsWith("/routing/placements/")) {
        reserve(init?.method);
        return new Response(null, { status });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    const response = await POST(new Request("http://localhost/api/sfu/join", {
      method: "POST",
      body: JSON.stringify({ roomId: "abc-mnop-xyz", sessionId: "session", isHost: true, createsMeeting: true }),
    }));
    expect(reserve).toHaveBeenCalledExactlyOnceWith("POST");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Meeting placement is temporarily unavailable. Try again shortly." });
  });
});

import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/sfu/join/route";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/sfu-user-auth", () => ({ lookupScheduledWebinarByRoomId: vi.fn() }));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));
vi.mock("@/lib/sfu-super-admin", () => import("../src/lib/sfu-super-admin"));
vi.mock("@/lib/sfu-url", () => import("../src/lib/sfu-url"));
vi.mock("@/lib/sfu-routing-policy", () => import("../src/lib/sfu-routing-policy"));

beforeEach(() => {
  getSession.mockResolvedValue(null);
  vi.stubEnv("SFU_SECRET", "super-admin-test-secret");
  vi.stubEnv("SFU_DEBUG_SECRET", "0");
  vi.stubEnv("SFU_URL", "http://localhost:3031");
  vi.stubEnv("SFU_URLS", "http://localhost:3031");
  vi.stubEnv("SFU_ADMIN_ALLOWLIST_EMAILS", "admin@example.com");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    local: true,
    owner: { instanceUrl: "http://localhost:3031" },
    draining: false,
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const join = async (user: { email: string }) => {
  const response = await POST(new Request("http://localhost/api/sfu/join", {
    method: "POST",
    body: JSON.stringify({ roomId: "room", sessionId: "session", user, isAdmin: true }),
  }));
  expect(response.status).toBe(200);
  const result = await response.json() as { token: string };
  return jwt.verify(result.token, "super-admin-test-secret");
};

describe("join token super admin authorization", () => {
  it("bounds routing and placement response bodies when an upstream stalls after headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true })),
    })));
    const started = performance.now();
    const response = await POST(new Request("http://localhost/api/sfu/join", {
      method: "POST",
      body: JSON.stringify({ roomId: "room", sessionId: "session" }),
    }));
    expect(response.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(4500);
  });
  it("grants super admin and host privileges to an authenticated allowlisted email", async () => {
    getSession.mockResolvedValue({ user: { id: "admin", email: " ADMIN@example.com ", name: "Admin" } });
    expect(await join({ email: "guest@example.com" })).toMatchObject({
      isSuperAdmin: true, isForcedHost: true, isHost: true, isAdmin: true,
    });
  });

  it("does not trust an unauthenticated body email or admin request", async () => {
    expect(await join({ email: "admin@example.com" })).toMatchObject({
      isSuperAdmin: false, isForcedHost: false, isHost: false, isAdmin: false,
    });
  });

  it("mints the protected claim for the dashboard email fallback", async () => {
    vi.stubEnv("SFU_ADMIN_ALLOWLIST_EMAILS", "");
    vi.stubEnv("SFU_ADMIN_ALLOWED_EMAILS", "");
    vi.stubEnv("SFU_DASHBOARD_ALLOWLIST_EMAILS", "admin@example.com");
    getSession.mockResolvedValue({ user: { id: "admin", email: "admin@example.com", name: "Admin" } });
    expect(await join({ email: "guest@example.com" })).toMatchObject({
      isSuperAdmin: true, isForcedHost: true, isHost: true, isAdmin: true,
    });
  });

  it("uses the authenticated session over a forged allowlisted body email", async () => {
    getSession.mockResolvedValue({ user: { id: "guest", email: "guest@example.com", name: "Guest" } });
    expect(await join({ email: "admin@example.com" })).toMatchObject({
      isSuperAdmin: false, isForcedHost: false, isHost: false, isAdmin: false,
    });
  });
});

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
vi.mock("@/app/lib/site-version", () => import("../src/app/lib/site-version"));

const SECRET = "guest-pass-test-secret";

beforeEach(() => {
  getSession.mockResolvedValue(null);
  vi.stubEnv("SFU_SECRET", SECRET);
  vi.stubEnv("SFU_DEBUG_SECRET", "0");
  vi.stubEnv("SFU_URL", "http://localhost:3031");
  vi.stubEnv("SFU_URLS", "http://localhost:3031");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    local: true,
    owner: { instanceUrl: "http://localhost:3031" },
    draining: false,
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type JoinClaims = { userId: string; sessionId: string; email?: string; guestProof?: string };
type JoinResult = {
  status: number;
  body: { token?: string; guestId?: string; guestGrant?: string; error?: string };
  claims: JoinClaims | null;
  setCookies: string[];
};

// One browser profile: it keeps the cookies the join route sets and sends
// them back, like a real cookie jar. JavaScript never reads them.
const browser = () => {
  const jar = new Map<string, string>();
  const join = async (body: Record<string, unknown>): Promise<JoinResult> => {
    const response = await POST(new Request("http://localhost/api/sfu/join", {
      method: "POST",
      headers: jar.size > 0
        ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") }
        : {},
      body: JSON.stringify({ roomId: "room", ...body }),
    }));
    const setCookies = response.headers.getSetCookie();
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const payload = await response.json() as JoinResult["body"];
    return {
      status: response.status,
      body: payload,
      claims: payload.token ? jwt.verify(payload.token, SECRET) as JoinClaims : null,
      setCookies,
    };
  };
  return { join, jar };
};

describe("guest identity", () => {
  it("never issues a guest's identity to another browser that knows its public ids", async () => {
    const victim = await browser().join({ sessionId: "tab-1", guestId: "", isHost: true });
    expect(victim.status).toBe(200);
    const victimKey = victim.claims!.userId;

    const replays: Record<string, unknown>[] = [
      { sessionId: "tab-1" },
      { sessionId: "tab-1", guestId: "" },
      { sessionId: "tab-1", guestId: victim.body.guestId },
      { sessionId: victimKey.slice("guest-".length) },
      { sessionId: victimKey.slice("guest-".length), guestId: "" },
    ];
    for (const replay of replays) {
      const attempt = await browser().join({ ...replay, isHost: true });
      expect([200, 400, 409], JSON.stringify(replay)).toContain(attempt.status);
      expect(attempt.claims?.userId, JSON.stringify(replay)).not.toBe(victimKey);
    }
  });

  it("gives a browser the same identity again when it reconnects or reloads", async () => {
    const tab = browser();
    const first = await tab.join({ sessionId: "tab-1", guestId: "" });
    const reconnect = await tab.join({ sessionId: "tab-1", guestId: first.body.guestId });
    const reload = await tab.join({ sessionId: "tab-1", guestId: "" });

    expect(first.status).toBe(200);
    expect(reconnect.claims!.userId).toBe(first.claims!.userId);
    expect(reload.claims!.userId).toBe(first.claims!.userId);
  });
});

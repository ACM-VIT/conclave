import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/sfu/join/route";
import { buildGuestUserKey } from "../src/lib/guest-identity";
import { guestPassCookieName, resolveGuestSession } from "../src/lib/guest-pass";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/sfu-user-auth", () => ({ lookupScheduledWebinarByRoomId: vi.fn() }));
vi.mock("@/lib/guest-pass", () => import("../src/lib/guest-pass"));
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
  const join = async (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<JoinResult> => {
    const response = await POST(new Request("http://localhost/api/sfu/join", {
      method: "POST",
      headers: {
        ...(jar.size > 0
          ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") }
          : {}),
        ...headers,
      },
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

  it("keeps tabs of one browser apart, as separate guests of the same pass", async () => {
    const tabs = browser();
    const one = await tabs.join({ sessionId: "tab-1", guestId: "" });
    const two = await tabs.join({ sessionId: "tab-2", guestId: one.body.guestId });

    expect(two.body.guestId).toBe(one.body.guestId);
    expect(two.claims!.userId).not.toBe(one.claims!.userId);
    expect(two.claims!.guestProof).toBe(one.claims!.guestProof);
  });

  it("builds the identity the client computes from the id it was handed", async () => {
    const joined = await browser().join({ sessionId: "tab-1", guestId: "" });

    expect(joined.body.guestId).toMatch(/^gp_[A-Za-z0-9_-]{22}$/);
    expect(joined.claims!.userId).toBe(`guest-${joined.body.guestId}.tab-1`);
    expect(buildGuestUserKey(joined.body.guestId!, "tab-1")).toBe(joined.claims!.userId);
    expect(joined.claims!.sessionId).toBe("tab-1");
  });

  it("signs a proof of the pass that the public ids do not reveal", async () => {
    const one = await browser().join({ sessionId: "tab-1", guestId: "" });
    const other = await browser().join({ sessionId: "tab-1", guestId: "" });

    expect(one.claims!.guestProof).toEqual(expect.any(String));
    expect(other.claims!.guestProof).not.toBe(one.claims!.guestProof);
    expect(one.claims!.userId).not.toContain(one.claims!.guestProof!);
    expect(JSON.stringify(one.body)).not.toContain(one.claims!.guestProof!);
  });

  it("binds webinar attendees to the pass the same way", async () => {
    const viewer = browser();
    const first = await viewer.join({ sessionId: "tab-1", guestId: "", joinMode: "webinar_attendee" });
    const again = await viewer.join({ sessionId: "tab-1", guestId: first.body.guestId, joinMode: "webinar_attendee" });
    const stranger = await browser().join({ sessionId: "tab-1", guestId: first.body.guestId, joinMode: "webinar_attendee" });

    expect(again.claims!.userId).toBe(first.claims!.userId);
    expect(again.claims!.guestProof).toBe(first.claims!.guestProof);
    expect(stranger.status).toBe(409);
  });

  it.each(["", "tab#1", "x".repeat(129), "tab\u0000", "alice@example.com"])(
    "rejects session id %j for a pass identity",
    async (sessionId) => {
      const attempt = await browser().join({ sessionId, guestId: "" });
      expect(attempt.status).toBe(400);
    },
  );
});

describe("guest pass cookie", () => {
  it("is HttpOnly, SameSite and scoped to the site", async () => {
    const [cookie] = (await browser().join({ sessionId: "tab-1", guestId: "" })).setCookies;
    const attributes = cookie.split("; ").slice(1);

    expect(cookie.startsWith(`${guestPassCookieName(SECRET)}=`)).toBe(true);
    expect(attributes).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Path=/"]));
    expect(attributes.some((attribute) => /^Max-Age=\d+$/.test(attribute))).toBe(true);
  });

  it("is Secure and host-locked in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const [cookie] = (await browser().join({ sessionId: "tab-1", guestId: "" })).setCookies;

    expect(cookie.startsWith("__Host-conclave-guest-")).toBe(true);
    expect(cookie.split("; ")).toEqual(expect.arrayContaining(["Secure", "HttpOnly", "Path=/"]));
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("never returns the pass to page scripts", async () => {
    const joined = await browser().join({ sessionId: "tab-1", guestId: "" });
    const pass = joined.setCookies[0].split(";")[0].split("=")[1];

    expect(JSON.stringify(joined.body)).not.toContain(pass);
  });

  it.each([
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
    ["a sibling subdomain", { "sec-fetch-site": "same-site" }],
    ["a cross-site form post from an older browser", { origin: "https://elsewhere.example", host: "localhost" }],
    ["an opaque origin", { origin: "null", host: "localhost" }],
    ["the same host over plain http", { origin: "http://localhost", host: "localhost", "x-forwarded-proto": "https" }],
  ])("is neither read nor replaced by %s", async (_label, headers) => {
    const tab = browser();
    const mine = await tab.join({ sessionId: "tab-1", guestId: "" });
    const passBefore = tab.jar.get(guestPassCookieName(SECRET));

    const forged = await tab.join({ sessionId: "tab-1", guestId: "" }, headers);
    expect(forged.status).toBe(200);
    expect(forged.setCookies).toHaveLength(0);
    expect(forged.claims!.userId).not.toBe(mine.claims!.userId);
    expect(tab.jar.get(guestPassCookieName(SECRET))).toBe(passBefore);

    const after = await tab.join({ sessionId: "tab-1", guestId: mine.body.guestId });
    expect(after.claims!.userId).toBe(mine.claims!.userId);
  });

  it("is read and refreshed for the site's own requests", async () => {
    const tab = browser();
    const mine = await tab.join({ sessionId: "tab-1", guestId: "" });

    const sameOrigin = await tab.join(
      { sessionId: "tab-1", guestId: mine.body.guestId },
      { "sec-fetch-site": "same-origin", origin: "http://localhost", host: "localhost" },
    );
    expect(sameOrigin.claims!.userId).toBe(mine.claims!.userId);
    expect(sameOrigin.setCookies).toHaveLength(1);
  });

  it("leaves the pass of a deployment with another secret alone", async () => {
    const tab = browser();
    tab.jar.set(guestPassCookieName("another-stack-secret"), "another-stack-pass");

    const joined = await tab.join({ sessionId: "tab-1", guestId: "" });
    expect(joined.setCookies[0].startsWith(`${guestPassCookieName(SECRET)}=`)).toBe(true);
    expect(tab.jar.get(guestPassCookieName("another-stack-secret"))).toBe("another-stack-pass");
  });

  it("is accepted when a cookie jar sends it back in quotes", async () => {
    const app = browser();
    const first = await app.join({ sessionId: "native-session", guestId: "" });
    const name = guestPassCookieName(SECRET);
    app.jar.set(name, `"${app.jar.get(name)}"`);
    app.jar.set("$Version", '"1"');

    const again = await app.join({ sessionId: "native-session", guestId: "" });
    expect(again.claims!.userId).toBe(first.claims!.userId);
    expect(again.body.guestGrant).toBeUndefined();
  });

  it("rejects a pass signed with another key", async () => {
    const tab = browser();
    const first = await tab.join({ sessionId: "tab-1", guestId: "" });
    const forged = jwt.sign({ gid: first.body.guestId }, "not-the-server-key", {
      audience: "conclave-guest-pass",
    });
    const intruder = browser();
    intruder.jar.set(guestPassCookieName(SECRET), forged);

    expect((await intruder.join({ sessionId: "tab-1", guestId: first.body.guestId })).status).toBe(409);
  });

  it("does not accept an SFU join token as a pass", async () => {
    const first = await browser().join({ sessionId: "tab-1", guestId: "" });
    const intruder = browser();
    intruder.jar.set(guestPassCookieName(SECRET), first.body.token!);

    const attempt = await intruder.join({ sessionId: "tab-1", guestId: "" });
    expect(attempt.claims!.userId).not.toBe(first.claims!.userId);
  });
});

describe("guest identity handed to a page render", () => {
  it("is the identity of the pass cookie, with no grant", async () => {
    const tab = browser();
    const joined = await tab.join({ sessionId: "tab-1", guestId: "" });

    const session = resolveGuestSession(SECRET, tab.jar.get(guestPassCookieName(SECRET)));
    expect(session).toEqual({ id: joined.body.guestId });
  });

  it("lets a first visit join as the identity it was rendered with, then relies on the cookie", async () => {
    const session = resolveGuestSession(SECRET, undefined);
    const tab = browser();

    const first = await tab.join({ sessionId: "tab-1", guestId: session.id, guestGrant: session.grant });
    expect(first.status).toBe(200);
    expect(first.claims!.userId).toBe(buildGuestUserKey(session.id, "tab-1"));
    expect(first.setCookies).toHaveLength(1);
    expect(first.body.guestGrant).toEqual(expect.any(String));

    const second = await tab.join({ sessionId: "tab-1", guestId: session.id });
    expect(second.claims!.userId).toBe(first.claims!.userId);
    expect(second.body.guestGrant).toBeUndefined();
  });

  it("keeps a browser that drops cookies on its identity through rolling grants", async () => {
    const session = resolveGuestSession(SECRET, undefined);
    const first = await browser().join({ sessionId: "tab-1", guestId: session.id, guestGrant: session.grant });
    const second = await browser().join({ sessionId: "tab-1", guestId: session.id, guestGrant: first.body.guestGrant });

    expect(second.claims!.userId).toBe(first.claims!.userId);
    expect(second.body.guestGrant).toEqual(expect.any(String));
  });

  it("does not replace another tab's pass with a second first-visit identity", async () => {
    const tabs = browser();
    const one = resolveGuestSession(SECRET, undefined);
    const two = resolveGuestSession(SECRET, undefined);
    await tabs.join({ sessionId: "tab-1", guestId: one.id, guestGrant: one.grant });

    const second = await tabs.join({ sessionId: "tab-2", guestId: two.id, guestGrant: two.grant });
    expect(second.claims!.userId).toBe(buildGuestUserKey(two.id, "tab-2"));
    expect(second.setCookies).toHaveLength(0);
    expect(second.body.guestGrant).toEqual(expect.any(String));

    const firstAgain = await tabs.join({ sessionId: "tab-1", guestId: one.id });
    expect(firstAgain.status).toBe(200);
  });

  it("refuses a rendered identity once neither its cookie nor a grant backs it", async () => {
    const session = resolveGuestSession(SECRET, undefined);

    const attempt = await browser().join({ sessionId: "tab-1", guestId: session.id });
    expect(attempt.status).toBe(409);
    expect(attempt.body.token).toBeUndefined();
    expect(attempt.setCookies).toHaveLength(0);
  });

  it("does not accept a grant for another identity", async () => {
    const mine = resolveGuestSession(SECRET, undefined);
    const theirs = resolveGuestSession(SECRET, undefined);

    const attempt = await browser().join({ sessionId: "tab-1", guestId: theirs.id, guestGrant: mine.grant });
    expect(attempt.status).toBe(409);
  });
});

describe("signed-in identity", () => {
  it("is the account, with no guest pass involved", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "me@example.com", name: "Me" } });
    const session = resolveGuestSession(SECRET, undefined);

    const joined = await browser().join({ sessionId: "tab-1", guestId: session.id, guestGrant: session.grant });
    expect(joined.claims).toMatchObject({ userId: "me@example.com", email: "me@example.com", sessionId: "tab-1" });
    expect(joined.claims!.guestProof).toBeUndefined();
    expect(joined.body.guestId).toBeUndefined();
    expect(joined.setCookies).toHaveLength(0);
  });
});

describe("clients that predate guest passes", () => {
  it("keep the identity they derive themselves", async () => {
    const joined = await browser().join({ sessionId: "1700000000000-abc123" });

    expect(joined.claims!.userId).toBe("guest-1700000000000-abc123");
    expect(joined.body.guestId).toBeUndefined();
  });

  it("prove their pass once they hold one, so the identity can be bound", async () => {
    const tab = browser();
    const first = await tab.join({ sessionId: "1700000000000-abc123" });
    const second = await tab.join({ sessionId: "1700000000000-abc123" });
    const third = await tab.join({ sessionId: "1700000000000-abc123" });

    expect(first.claims!.guestProof).toBeUndefined();
    expect(first.setCookies).toHaveLength(1);
    expect(second.claims!.userId).toBe("guest-1700000000000-abc123");
    expect(second.claims!.guestProof).toEqual(expect.any(String));
    expect(third.claims!.guestProof).toBe(second.claims!.guestProof);
  });

  it("give a replayed session id the replayer's proof, never the owner's", async () => {
    const owner = browser();
    await owner.join({ sessionId: "1700000000000-abc123" });
    const owned = await owner.join({ sessionId: "1700000000000-abc123" });

    const stranger = browser();
    await stranger.join({ sessionId: "another-session" });
    const replayWithPass = await stranger.join({ sessionId: "1700000000000-abc123" });
    const replayWithoutPass = await browser().join({ sessionId: "1700000000000-abc123" });

    expect(replayWithPass.claims!.userId).toBe(owned.claims!.userId);
    expect(replayWithPass.claims!.guestProof).not.toBe(owned.claims!.guestProof);
    expect(replayWithoutPass.claims!.guestProof).toBeUndefined();
  });

  it("with no cookie jar never carry a proof", async () => {
    const first = await browser().join({ sessionId: "bot-session" });
    const again = await browser().join({ sessionId: "bot-session" });

    expect(again.claims!.userId).toBe(first.claims!.userId);
    expect(first.claims!.guestProof).toBeUndefined();
    expect(again.claims!.guestProof).toBeUndefined();
  });

  it("cannot name a session id inside the pass namespace", async () => {
    const attempt = await browser().join({ sessionId: "gp_anything" });
    expect(attempt.status).toBe(400);
  });

  it("cannot name a session id that would make their key an account's email", async () => {
    const attempt = await browser().join({ sessionId: "alice@example.com" });
    expect(attempt.status).toBe(400);
  });
});

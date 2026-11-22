import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as askForPass } from "../src/app/api/guest-pass/route";
import { POST } from "../src/app/api/sfu/join/route";
import { guestPassCookieName } from "../src/lib/guest-pass";

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

type JoinClaims = {
  userId: string;
  sessionId: string;
  email?: string;
  guestProof?: string;
  guestRoom?: string;
  guestWas?: { userKey: string; guestProof: string };
};
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

  it("issues a seat key that shows neither the pass nor the tab behind it", async () => {
    const joined = await browser().join({ sessionId: "tab-1", guestId: "" });

    expect(joined.body.guestId).toMatch(/^gp_[A-Za-z0-9_-]{22}$/);
    expect(joined.claims!.userId).toMatch(/^guest-gp_[A-Za-z0-9_-]{22}$/);
    expect(joined.claims!.userId).not.toContain(joined.body.guestId!.slice(3));
    expect(joined.claims!.userId).not.toContain("tab-1");
    expect(joined.claims!.sessionId).toBe("tab-1");
  });

  it("gives one browser tab a different seat key in every room, under one pass", async () => {
    const tab = browser();
    const here = await tab.join({ roomId: "room-a", sessionId: "tab-1", guestId: "" });
    const there = await tab.join({ roomId: "room-b", sessionId: "tab-1", guestId: here.body.guestId });
    const hereAgain = await tab.join({ roomId: "room-a", sessionId: "tab-1", guestId: here.body.guestId });

    expect(there.body.guestId).toBe(here.body.guestId);
    expect(there.claims!.userId).not.toBe(here.claims!.userId);
    expect(there.claims!.guestProof).toBe(here.claims!.guestProof);
    expect(hereAgain.claims!.userId).toBe(here.claims!.userId);
  });

  it("scopes the seat key to the client's deployment as well as the room", async () => {
    const tab = browser();
    const one = await tab.join({ sessionId: "tab-1", guestId: "", clientId: "public" });
    const other = await tab.join({ sessionId: "tab-1", guestId: one.body.guestId, clientId: "internal" });

    expect(other.claims!.userId).not.toBe(one.claims!.userId);
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
    expect(stranger.claims!.userId).not.toBe(first.claims!.userId);
    expect(stranger.claims!.guestProof).not.toBe(first.claims!.guestProof);
  });

  it("signs the room the seat key was issued for into the token", async () => {
    const guest = await browser().join({ roomId: "room-a", sessionId: "tab-1", guestId: "" });
    const older = await browser().join({ roomId: "room-a", sessionId: "1700000000000-abc123" });

    expect(guest.claims!.guestRoom).toBe("room-a");
    expect(older.claims!.guestRoom).toBeUndefined();
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

    const attempt = await intruder.join({ sessionId: "tab-1", guestId: first.body.guestId });
    expect(attempt.claims!.userId).not.toBe(first.claims!.userId);
    expect(attempt.claims!.guestProof).not.toBe(first.claims!.guestProof);
  });

  it("does not accept an SFU join token as a pass", async () => {
    const first = await browser().join({ sessionId: "tab-1", guestId: "" });
    const intruder = browser();
    intruder.jar.set(guestPassCookieName(SECRET), first.body.token!);

    const attempt = await intruder.join({ sessionId: "tab-1", guestId: "" });
    expect(attempt.claims!.userId).not.toBe(first.claims!.userId);
  });
});

describe("the pass a browser joins with", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("is issued on a first visit with a grant, and then proven by the cookie alone", async () => {
    const tab = browser();

    const first = await tab.join({ sessionId: "tab-1", guestId: "" });
    expect(first.status).toBe(200);
    expect(first.setCookies).toHaveLength(1);
    expect(first.body.guestGrant).toEqual(expect.any(String));

    const second = await tab.join({ sessionId: "tab-1", guestId: first.body.guestId });
    expect(second.claims!.userId).toBe(first.claims!.userId);
    expect(second.body.guestGrant).toBeUndefined();
  });

  it("is the first tab's pass for a second tab that joins after it", async () => {
    const tabs = browser();
    const one = await tabs.join({ sessionId: "tab-1", guestId: "" });

    const two = await tabs.join({ roomId: "second-room", sessionId: "tab-2", guestId: "" });

    expect(two.body.guestId).toBe(one.body.guestId);
    expect(two.claims!.guestProof).toBe(one.claims!.guestProof);
    expect(two.setCookies).toHaveLength(1);
    expect(two.body.guestGrant).toBeUndefined();
  });

  it("is the cookie's pass even when the tab still carries a grant for another", async () => {
    const tabs = browser();
    const one = await tabs.join({ sessionId: "tab-1", guestId: "" });
    const strayGrant = (await browser().join({ sessionId: "tab-2", guestId: "" })).body.guestGrant;

    const two = await tabs.join({
      roomId: "second-room",
      sessionId: "tab-2",
      guestId: "",
      guestGrant: strayGrant,
      isHost: true,
    });
    const afterReload = await tabs.join({ roomId: "second-room", sessionId: "tab-2", guestId: "" });

    expect(two.body.guestId).toBe(one.body.guestId);
    expect(two.body.guestGrant).toBeUndefined();
    expect(afterReload.claims!.userId).toBe(two.claims!.userId);
    expect(afterReload.claims!.guestProof).toBe(two.claims!.guestProof);
  });

  it("keeps a browser that drops cookies on its identity through rolling grants", async () => {
    const first = await browser().join({ sessionId: "tab-1", guestId: "" });
    const second = await browser().join({
      sessionId: "tab-1",
      guestId: first.body.guestId,
      guestGrant: first.body.guestGrant,
    });

    expect(second.claims!.userId).toBe(first.claims!.userId);
    expect(second.body.guestGrant).toEqual(expect.any(String));
  });

  it("is replaced, not refused, when it expired before a page's first join", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 22) });
    try {
      const tab = browser();
      const before = await tab.join({ sessionId: "tab-1", guestId: "" });

      vi.setSystemTime(Date.now() + 31 * DAY);
      const after = await tab.join({
        sessionId: "tab-1",
        guestId: "",
        guestGrant: before.body.guestGrant,
      });

      expect(after.status).toBe(200);
      expect(after.body.guestId).not.toBe(before.body.guestId);
      expect(after.setCookies).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a new one for a page that has neither its cookie nor a grant", async () => {
    const first = await browser().join({ sessionId: "tab-1", guestId: "" });

    const later = await browser().join({ sessionId: "tab-1", guestId: first.body.guestId });

    expect(later.status).toBe(200);
    expect(later.claims!.userId).not.toBe(first.claims!.userId);
    expect(later.claims!.guestProof).not.toBe(first.claims!.guestProof);
  });
});

describe("two tabs of a new browser whose first joins cross", () => {
  // Both calls leave before either answer sets the cookie, so each tab is
  // given its own pass and the browser keeps the one that was set last.
  const crossedJoins = async () => {
    const tabs = browser();
    const [one, two] = await Promise.all([
      tabs.join({ roomId: "first-room", sessionId: "tab-1", guestId: "", isHost: true }),
      tabs.join({ roomId: "second-room", sessionId: "tab-2", guestId: "", isHost: true }),
    ]);
    expect(two.body.guestId).not.toBe(one.body.guestId);
    const kept = (await tabs.join({ roomId: "probe", sessionId: "probe", guestId: "" })).body.guestId;
    const [winner, loser] = kept === one.body.guestId ? [one, two] : [two, one];
    const seat = (tab: JoinResult) =>
      tab === one
        ? { roomId: "first-room", sessionId: "tab-1" }
        : { roomId: "second-room", sessionId: "tab-2" };
    return { tabs, winner, loser, seat };
  };

  it("move the tab that lost to the browser's pass, with proof of the seat it held", async () => {
    const { tabs, loser, seat } = await crossedJoins();

    const reloaded = await tabs.join({
      ...seat(loser),
      guestId: "",
      guestSeatToken: loser.body.token,
    });

    expect(reloaded.claims!.userId).not.toBe(loser.claims!.userId);
    expect(reloaded.claims!.guestWas).toEqual({
      userKey: loser.claims!.userId,
      guestProof: loser.claims!.guestProof,
    });
  });

  it("leave the tab whose pass the browser kept as it is", async () => {
    const { tabs, winner, seat } = await crossedJoins();

    const reloaded = await tabs.join({
      ...seat(winner),
      guestId: "",
      guestSeatToken: winner.body.token,
    });

    expect(reloaded.claims!.userId).toBe(winner.claims!.userId);
    expect(reloaded.claims!.guestWas).toBeUndefined();
  });

  it.each([
    ["another room", { roomId: "third-room" }],
    ["another tab", { sessionId: "tab-9" }],
    ["another deployment", { clientId: "internal" }],
  ])("do not let a token carry a seat over to %s", async (_label, elsewhere) => {
    const { tabs, loser, seat } = await crossedJoins();

    const attempt = await tabs.join({
      ...seat(loser),
      ...elsewhere,
      guestId: "",
      guestSeatToken: loser.body.token,
    });

    expect(attempt.claims!.guestWas).toBeUndefined();
  });

  it("do not accept a token the SFU would not accept as proof of an earlier seat", async () => {
    const { tabs, loser, seat } = await crossedJoins();
    const forged = jwt.sign(
      { ...loser.claims, userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA" },
      "not-the-sfu-secret",
    );

    const attempt = await tabs.join({ ...seat(loser), guestId: "", guestSeatToken: forged });

    expect(attempt.claims!.guestWas).toBeUndefined();
  });
});

describe("a page that asks for the browser's pass as it loads", () => {
  const ask = (headers: Record<string, string> = {}) =>
    askForPass(new Request("http://localhost/api/guest-pass", { method: "POST", headers }));
  const passFrom = (response: Response) =>
    response.headers.getSetCookie().find((cookie) => cookie.startsWith(guestPassCookieName(SECRET)));
  const keep = (tab: ReturnType<typeof browser>, cookie: string) => {
    const [pair] = cookie.split(";");
    tab.jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  };

  it("is given a pass that the first join then uses, with no grant", async () => {
    const answer = await ask({ "sec-fetch-site": "same-origin" });
    const pass = passFrom(answer);
    expect(answer.status).toBe(204);
    expect(pass).toMatch(/HttpOnly/);
    const tab = browser();
    keep(tab, pass!);

    const first = await tab.join({ sessionId: "tab-1", guestId: "" });
    const otherTab = await tab.join({ roomId: "second-room", sessionId: "tab-2", guestId: "" });

    expect(first.body.guestGrant).toBeUndefined();
    expect(first.setCookies.map((cookie) => cookie.split(";")[0])).toEqual([pass!.split(";")[0]]);
    expect(otherTab.body.guestId).toBe(first.body.guestId);
  });

  it("is not given another pass once the browser has one", async () => {
    const tab = browser();
    await tab.join({ sessionId: "tab-1", guestId: "" });
    const cookie = [...tab.jar].map(([name, value]) => `${name}=${value}`).join("; ");

    const answer = await ask({ "sec-fetch-site": "same-origin", cookie });

    expect(answer.status).toBe(204);
    expect(passFrom(answer)).toBeUndefined();
  });

  it("is given a new pass in place of one that does not verify", async () => {
    const cookie = `${guestPassCookieName(SECRET)}=not-a-pass`;

    expect(passFrom(await ask({ "sec-fetch-site": "same-origin", cookie }))).toMatch(/HttpOnly/);
  });

  it.each(["cross-site", "same-site"])(
    "gets no pass when another site makes the call (%s)",
    async (fetchSite) => {
      expect(passFrom(await ask({ "sec-fetch-site": fetchSite }))).toBeUndefined();
    },
  );

  it("leaves two tabs that asked at once on the pass the browser kept", async () => {
    const [first, second] = await Promise.all([ask(), ask()]);
    const tabs = browser();
    keep(tabs, passFrom(first)!);
    keep(tabs, passFrom(second)!);

    const one = await tabs.join({ sessionId: "tab-1", guestId: "", isHost: true });
    const two = await tabs.join({ roomId: "second-room", sessionId: "tab-2", guestId: "", isHost: true });

    expect(passFrom(first)).not.toBe(passFrom(second));
    expect(two.body.guestId).toBe(one.body.guestId);
    expect(two.claims!.guestProof).toBe(one.claims!.guestProof);
  });
});

describe("signed-in identity", () => {
  it("is the account, with no guest pass involved", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "me@example.com", name: "Me" } });

    const joined = await browser().join({ sessionId: "tab-1", guestId: "" });
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

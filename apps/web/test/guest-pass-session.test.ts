import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGuestPassSession,
  guestPassRequestFor,
  type GuestPassFields,
} from "../src/app/lib/guest-pass-session";

// A join route that records what it was sent and answers as scripted.
const joinRoute = (answers: Array<{ token: string; guestId?: string; guestGrant?: string }>) => {
  const sent: GuestPassFields[] = [];
  const send = async (fields: GuestPassFields) => {
    sent.push({ ...fields });
    return answers[sent.length - 1];
  };
  return { sent, send };
};

// A page whose request for the browser's pass has already been answered.
const openPage = () => createGuestPassSession(async () => undefined).join;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a page's guest join calls", () => {
  it("never name a pass, and carry the grant of the last answer", async () => {
    const join = openPage();
    const route = joinRoute([
      { token: "token-1", guestId: "gp_issued", guestGrant: "grant-1" },
      { token: "token-2", guestId: "gp_issued" },
      { token: "token-3", guestId: "gp_issued" },
    ]);

    await join(route.send);
    await join(route.send);
    await join(route.send);

    expect(route.sent).toEqual([{ guestId: "" }, { guestId: "", guestGrant: "grant-1" }, { guestId: "" }]);
  });

  it("keep nothing the tab would have to hand back later", async () => {
    const stored = vi.fn();
    vi.stubGlobal("window", { sessionStorage: { getItem: () => null, setItem: stored } });
    const route = joinRoute([{ token: "token-1", guestId: "gp_issued", guestGrant: "grant-1" }]);

    await openPage()(route.send);

    expect(stored).not.toHaveBeenCalled();
  });

  it("keep the grant they have when an account's answer comes in between", async () => {
    const join = openPage();
    const route = joinRoute([
      { token: "token-1", guestId: "gp_issued", guestGrant: "grant-1" },
      { token: "account-token" },
      { token: "token-3", guestId: "gp_issued" },
    ]);

    await join(route.send);
    await join(route.send);
    await join(route.send);

    expect(route.sent[2]).toEqual({ guestId: "", guestGrant: "grant-1" });
  });

  it("go one at a time, so the second carries what the first was answered", async () => {
    const join = openPage();
    const sent: GuestPassFields[] = [];
    let answerFirst = (_answer: { token: string; guestId: string; guestGrant: string }) => {};
    const first = join((fields) => {
      sent.push({ ...fields });
      return new Promise<{ token: string; guestId: string; guestGrant: string }>((resolve) => {
        answerFirst = resolve;
      });
    });
    const second = join(async (fields) => {
      sent.push({ ...fields });
      return { token: "token-2", guestId: "gp_issued" };
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    answerFirst({ token: "token-1", guestId: "gp_issued", guestGrant: "grant-1" });
    await Promise.all([first, second]);

    expect(sent[1]).toEqual({ guestId: "", guestGrant: "grant-1" });
  });

  it("go on after a call that failed", async () => {
    const join = openPage();

    await expect(
      join(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    const route = joinRoute([{ token: "token-1", guestId: "gp_issued" }]);
    await join(route.send);

    expect(route.sent).toEqual([{ guestId: "" }]);
  });
});

describe("a page's request for the browser's pass", () => {
  it("is answered before the first join call goes out", async () => {
    const order: string[] = [];
    let answerPass = () => {};
    const page = createGuestPassSession(() => {
      order.push("pass asked");
      return new Promise<void>((resolve) => {
        answerPass = () => {
          order.push("pass answered");
          resolve();
        };
      });
    });

    page.pageLoaded();
    const joined = page.join(async () => {
      order.push("join sent");
      return { token: "token-1", guestId: "gp_issued" };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["pass asked"]);
    answerPass();
    await joined;

    expect(order).toEqual(["pass asked", "pass answered", "join sent"]);
  });

  it("is made once, however often the page reports it loaded", async () => {
    const askForPass = vi.fn(async () => undefined);
    const page = createGuestPassSession(askForPass);

    page.pageLoaded();
    page.pageLoaded();
    await page.join(joinRoute([{ token: "token-1", guestId: "gp_issued" }]).send);

    expect(askForPass).toHaveBeenCalledTimes(1);
  });

  it("is made by the first join call when the page has not reported yet", async () => {
    const order: string[] = [];
    const page = createGuestPassSession(async () => void order.push("pass asked"));

    await page.join(async () => {
      order.push("join sent");
      return { token: "token-1", guestId: "gp_issued" };
    });

    expect(order).toEqual(["pass asked", "join sent"]);
  });

  it("does not stop a join when it fails", async () => {
    const page = createGuestPassSession(async () => {
      throw new Error("offline");
    });
    const route = joinRoute([{ token: "token-1", guestId: "gp_issued" }]);

    page.pageLoaded();
    await page.join(route.send);

    expect(route.sent).toEqual([{ guestId: "" }]);
  });
});

describe("how a page asks for the browser's pass", () => {
  // One browser: a cookie that the pass route sets on a request without it,
  // and Web Locks shared by its tabs. Answers take a moment to arrive.
  const oneBrowser = ({ webLocks = true } = {}) => {
    let cookie: string | null = null;
    let minted = 0;
    const requests: Array<{ url: string; method?: string; hadCookie: boolean }> = [];
    const fetched = vi.fn(async (url: string, init?: RequestInit) => {
      const hadCookie = cookie !== null;
      requests.push({ url, method: init?.method, hadCookie });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!hadCookie) cookie = `pass-${(minted += 1)}`;
      return new Response(null, { status: 204 });
    });
    let held: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, _options: unknown, callback: () => Promise<unknown>) => {
      const turn = held.then(callback, callback);
      held = turn.catch(() => undefined);
      return turn;
    });
    vi.stubGlobal("fetch", fetched);
    vi.stubGlobal("navigator", webLocks ? { locks: { request } } : {});
    return { requests, request, fetched, passesMinted: () => minted };
  };

  it("is a POST to the pass route for a guest's page, and nothing for an account's", async () => {
    const browser = oneBrowser();

    await guestPassRequestFor({ id: "u1", email: "me@example.com" })();
    expect(browser.fetched).not.toHaveBeenCalled();
    await guestPassRequestFor(undefined)();
    await guestPassRequestFor({ name: "Asha" } as { id?: string })();

    expect(browser.requests.map(({ url, method }) => [url, method])).toEqual([
      ["/api/guest-pass", "POST"],
      ["/api/guest-pass", "POST"],
    ]);
  });

  it("takes turns across tabs, so two tabs that load at once are given one pass", async () => {
    const browser = oneBrowser();

    await Promise.all([guestPassRequestFor()(), guestPassRequestFor()()]);

    expect(browser.request).toHaveBeenCalledWith(
      "conclave:guest-pass",
      expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
      expect.any(Function),
    );
    expect(browser.requests.map(({ hadCookie }) => hadCookie)).toEqual([false, true]);
    expect(browser.passesMinted()).toBe(1);
  });

  it("is made without a turn in a browser that has no Web Locks, where each tab can be given a pass", async () => {
    const browser = oneBrowser({ webLocks: false });

    await Promise.all([guestPassRequestFor()(), guestPassRequestFor()()]);

    expect(browser.requests.map(({ hadCookie }) => hadCookie)).toEqual([false, false]);
    expect(browser.passesMinted()).toBe(2);
  });

  it("is made anyway when the tab's turn does not come in time", async () => {
    const browser = oneBrowser();
    browser.request.mockRejectedValueOnce(new DOMException("The lock request timed out", "TimeoutError"));

    await guestPassRequestFor()();

    expect(browser.requests).toHaveLength(1);
  });

  it("is made once when the request fails during the tab's turn", async () => {
    const browser = oneBrowser();
    browser.fetched.mockRejectedValueOnce(new Error("offline"));

    await expect(guestPassRequestFor()()).rejects.toThrow("offline");

    expect(browser.fetched).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGuestPassSession,
  type GuestPassFields,
} from "../src/app/lib/guest-pass-session";

// One tab's session storage. A reload keeps it, another tab has its own.
const tabStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};
const openTab = (storage = tabStorage()) => {
  vi.stubGlobal("window", { sessionStorage: storage });
  return storage;
};

// A join route that records what it was sent and answers as scripted.
const joinRoute = (answers: Array<{ token: string; guestId?: string; guestGrant?: string }>) => {
  const sent: GuestPassFields[] = [];
  const send = async (fields: GuestPassFields) => {
    sent.push({ ...fields });
    return answers[sent.length - 1];
  };
  return { sent, send };
};

beforeEach(() => {
  openTab();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a page's guest join calls", () => {
  it("never name a pass, and carry the last grant and the room's last token", async () => {
    const withGuestPass = createGuestPassSession();
    const route = joinRoute([
      { token: "token-1", guestId: "gp_issued", guestGrant: "grant-1" },
      { token: "token-2", guestId: "gp_issued" },
      { token: "token-3", guestId: "gp_issued" },
    ]);

    await withGuestPass("conclave:room", route.send);
    await withGuestPass("conclave:room", route.send);
    await withGuestPass("conclave:room", route.send);

    expect(route.sent).toEqual([
      { guestId: "" },
      { guestId: "", guestGrant: "grant-1", guestSeatToken: "token-1" },
      { guestId: "", guestSeatToken: "token-2" },
    ]);
  });

  it("carry the room's last token again after a reload, and no other tab's", async () => {
    const storage = openTab();
    await createGuestPassSession()("conclave:room", joinRoute([
      { token: "token-before-reload", guestId: "gp_issued" },
    ]).send);

    openTab(storage);
    const reloaded = joinRoute([{ token: "token-after-reload", guestId: "gp_issued" }]);
    await createGuestPassSession()("conclave:room", reloaded.send);
    openTab();
    const otherTab = joinRoute([{ token: "other-tab-token", guestId: "gp_issued" }]);
    await createGuestPassSession()("conclave:room", otherTab.send);

    expect(reloaded.sent).toEqual([{ guestId: "", guestSeatToken: "token-before-reload" }]);
    expect(otherTab.sent).toEqual([{ guestId: "" }]);
  });

  it("keep each room's token to that room", async () => {
    const withGuestPass = createGuestPassSession();
    const route = joinRoute([
      { token: "token-a", guestId: "gp_issued" },
      { token: "token-b", guestId: "gp_issued" },
      { token: "token-a2", guestId: "gp_issued" },
    ]);

    await withGuestPass("conclave:room-a", route.send);
    await withGuestPass("conclave:room-b", route.send);
    await withGuestPass("conclave:room-a", route.send);

    expect(route.sent.map((fields) => fields.guestSeatToken)).toEqual([
      undefined,
      undefined,
      "token-a",
    ]);
  });

  it("keep nothing from an account's answer", async () => {
    const withGuestPass = createGuestPassSession();
    const route = joinRoute([{ token: "account-token" }, { token: "account-token-2" }]);

    await withGuestPass("conclave:room", route.send);
    await withGuestPass("conclave:room", route.send);

    expect(route.sent).toEqual([{ guestId: "" }, { guestId: "" }]);
  });

  it("go one at a time, so the second carries what the first was answered", async () => {
    const withGuestPass = createGuestPassSession();
    const sent: GuestPassFields[] = [];
    let answerFirst = (_answer: { token: string; guestId: string; guestGrant: string }) => {};
    const first = withGuestPass("conclave:room", (fields) => {
      sent.push({ ...fields });
      return new Promise<{ token: string; guestId: string; guestGrant: string }>((resolve) => {
        answerFirst = resolve;
      });
    });
    const second = withGuestPass("conclave:room", async (fields) => {
      sent.push({ ...fields });
      return { token: "token-2", guestId: "gp_issued" };
    });

    await Promise.resolve();
    expect(sent).toHaveLength(1);
    answerFirst({ token: "token-1", guestId: "gp_issued", guestGrant: "grant-1" });
    await Promise.all([first, second]);

    expect(sent[1]).toEqual({ guestId: "", guestGrant: "grant-1", guestSeatToken: "token-1" });
  });

  it("go on after a call that failed", async () => {
    const withGuestPass = createGuestPassSession();

    await expect(
      withGuestPass("conclave:room", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    const route = joinRoute([{ token: "token-1", guestId: "gp_issued" }]);
    await withGuestPass("conclave:room", route.send);

    expect(route.sent).toEqual([{ guestId: "" }]);
  });
});

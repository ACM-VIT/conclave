// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fetchMock: ReturnType<typeof vi.fn>;

// A page load: fresh modules, the same tab storage.
const loadPage = async () => {
  vi.resetModules();
  const [{ requestJoinInfo }, joinedRoom] = await Promise.all([
    import("../src/app/lib/join-info"),
    import("../src/app/lib/joined-room"),
  ]);
  const askedToOpenRoom = async (roomId: string, isKnownMeeting = false) => {
    fetchMock.mockClear();
    await requestJoinInfo({
      roomId,
      sessionId: "session-1",
      isHost: false,
      isKnownMeeting,
      clientId: "conclave",
      joinMode: "meeting",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return (JSON.parse(String(init.body)) as { allowRoomCreation: boolean })
      .allowRoomCreation;
  };
  return { ...joinedRoom, askedToOpenRoom };
};

beforeEach(() => {
  window.sessionStorage.clear();
  fetchMock = vi.fn(async () =>
    Response.json({ token: "token", sfuUrl: "http://sfu.test" }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("which joins may open a room", () => {
  it("does not let a visitor following a link open the room", async () => {
    const page = await loadPage();
    expect(await page.askedToOpenRoom("abc-mnop-xyz")).toBe(false);
  });

  it("lets a tab that was in the meeting reopen it, also after a reload", async () => {
    const page = await loadPage();
    page.rememberJoinedRoom("abc-mnop-xyz", "pass-1");
    expect(await page.askedToOpenRoom("abc-mnop-xyz")).toBe(true);

    const reloaded = await loadPage();
    expect(await reloaded.askedToOpenRoom("abc-mnop-xyz")).toBe(true);
    expect(reloaded.getJoinedRoom("abc-mnop-xyz")?.recoveryPass).toBe("pass-1");
  });

  it("does not carry that over to another meeting's code", async () => {
    const page = await loadPage();
    page.rememberJoinedRoom("abc-mnop-xyz", "pass-1");
    expect(await page.askedToOpenRoom("qwe-rtyu-iop")).toBe(false);
    expect(page.getJoinedRoom("qwe-rtyu-iop")).toBeNull();
  });

  it("forgets the meeting once the tab was put out of it", async () => {
    const page = await loadPage();
    page.rememberJoinedRoom("abc-mnop-xyz", "pass-1");
    page.forgetJoinedRoom();
    expect(await page.askedToOpenRoom("abc-mnop-xyz")).toBe(false);

    const reloaded = await loadPage();
    expect(await reloaded.askedToOpenRoom("abc-mnop-xyz")).toBe(false);
  });

  it("keeps the newest pass the SFU sends during the call, also after a reload", async () => {
    const page = await loadPage();
    page.rememberJoinedRoom("abc-mnop-xyz", "pass-1");
    page.renewRoomRecoveryPass("abc-mnop-xyz", "pass-2");
    expect(page.getJoinedRoom("abc-mnop-xyz")?.recoveryPass).toBe("pass-2");

    const reloaded = await loadPage();
    expect(reloaded.getJoinedRoom("abc-mnop-xyz")?.recoveryPass).toBe("pass-2");
  });

  it("does not let a renewal stand in for being let into a meeting", async () => {
    const page = await loadPage();
    page.renewRoomRecoveryPass("abc-mnop-xyz", "pass-2");
    expect(await page.askedToOpenRoom("abc-mnop-xyz")).toBe(false);

    page.rememberJoinedRoom("abc-mnop-xyz", "pass-1");
    page.forgetJoinedRoom();
    page.renewRoomRecoveryPass("abc-mnop-xyz", "pass-3");
    expect(page.getJoinedRoom("abc-mnop-xyz")).toBeNull();
  });

  it("still opens a known meeting for its first visitor", async () => {
    const page = await loadPage();
    expect(await page.askedToOpenRoom("abc-mnop-xyz", true)).toBe(true);
  });

  it("keeps working in a tab whose storage is blocked", async () => {
    const page = await loadPage();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    page.rememberJoinedRoom("abc-mnop-xyz", null);
    expect(await page.askedToOpenRoom("abc-mnop-xyz")).toBe(true);
  });
});

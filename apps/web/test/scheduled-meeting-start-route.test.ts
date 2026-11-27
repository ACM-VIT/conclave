import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/meetings/scheduled/[id]/start/route";
import { fetchFromScheduledMeetingSfu } from "../src/lib/scheduled-meetings";

vi.mock("@/lib/sfu-user-auth", () => ({
  requireSfuSessionUser: async () => ({ ok: true, user: { email: "host@example.com" } }),
  buildScheduledWebinarHeaders: () => new Headers({ "x-sfu-user-email": "host@example.com" }),
}));
vi.mock("@/lib/sfu-admin-auth", () => ({
  resolveSfuSecret: () => "fixture",
  resolveSfuUrl: () => "http://sfu-a.test",
}));
vi.mock("@/lib/sfu-url", () => ({
  resolveSfuUrls: () => ["http://sfu-a.test", "http://sfu-b.test"],
}));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));
vi.mock("@/lib/scheduled-meetings", () => import("../src/lib/scheduled-meetings"));
vi.mock("@/app/lib/utils", () => ({
  readResponseError: async (response: Response) =>
    ((await response.json()) as { error: string }).error,
}));

const start = () =>
  POST(new Request("http://localhost/api/meetings/scheduled/m1/start", { method: "POST" }), {
    params: Promise.resolve({ id: "m1" }),
  });
const notFound = () => Response.json({ error: "Scheduled meeting not found" }, { status: 404 });
const started = () => Response.json({ scheduledMeeting: { id: "m1", status: "live" } });
const asked = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([url]) => String(url));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("starting a scheduled meeting early", () => {
  it("starts a meeting that only the second SFU has", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("http://sfu-b.test") ? started() : notFound());
    vi.stubGlobal("fetch", fetchMock);

    const response = await start();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scheduledMeeting: { id: "m1", status: "live" } });
  });

  it("starts it once, on the first SFU that has it", async () => {
    const fetchMock = vi.fn(async () => started());
    vi.stubGlobal("fetch", fetchMock);

    expect((await start()).status).toBe(200);
    expect(asked(fetchMock)).toEqual(["http://sfu-a.test/scheduled-meetings/m1/start"]);
  });

  it("does not look further once an SFU refuses the visitor", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("http://sfu-a.test")
        ? Response.json({ error: "Not authorized for this meeting" }, { status: 403 })
        : started());
    vi.stubGlobal("fetch", fetchMock);

    const response = await start();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Not authorized for this meeting" });
    expect(asked(fetchMock)).toHaveLength(1);
  });

  it("says the meeting was not found when no SFU has it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));

    expect((await start()).status).toBe(404);
  });

  it("does not call a meeting missing when an SFU could not be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("http://sfu-a.test")) throw new Error("fetch failed");
      return notFound();
    }));

    expect((await start()).status).toBe(502);
  });
});

describe("an SFU that does not answer a request about a scheduled meeting", () => {
  // Never answers. Fails the way fetch does if it was given a signal and the
  // signal fires.
  const untilAborted = (init: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
        once: true,
      });
    });
  const startWithin = (deadlineMs: number) =>
    fetchFromScheduledMeetingSfu("/m1/start", { method: "POST" }, deadlineMs);

  it("is passed over for the next one when it never answers", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) =>
      url.startsWith("http://sfu-a.test") ? untilAborted(init) : started());
    vi.stubGlobal("fetch", fetchMock);

    const response = await startWithin(40);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scheduledMeeting: { id: "m1", status: "live" } });
    expect(asked(fetchMock)).toHaveLength(2);
  });

  it("is passed over when it sends headers and then stalls on the reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) =>
      url.startsWith("http://sfu-a.test")
        ? { ok: true, status: 200, headers: new Headers(), text: () => untilAborted(init) }
        : started()));

    const response = await startWithin(40);
    expect(await response.json()).toEqual({ scheduledMeeting: { id: "m1", status: "live" } });
  });

  it("is passed over when it answers 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("http://sfu-a.test")
        ? Response.json({ error: "Draining" }, { status: 503 })
        : started()));

    expect((await startWithin(40)).status).toBe(200);
  });

  it("is not mistaken for a missing meeting when the others do not have it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("http://sfu-a.test")
        ? Response.json({ error: "Draining" }, { status: 503 })
        : notFound()));

    await expect(startWithin(40)).rejects.toThrow();
  });
});

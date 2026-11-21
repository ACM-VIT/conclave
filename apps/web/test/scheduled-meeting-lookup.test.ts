import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupScheduledMeetingForCode } from "../src/lib/scheduled-meetings";

vi.mock("@/lib/sfu-user-auth", () => ({ buildScheduledWebinarHeaders: vi.fn() }));
vi.mock("@/lib/sfu-admin-auth", () => ({
  resolveSfuSecret: () => "fixture",
  resolveSfuUrl: () => "http://sfu.test",
}));
vi.mock("@/app/lib/utils", () => ({ readResponseError: async () => "Unavailable" }));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));

const meeting = { id: "m1", roomCode: "abc-mnop-xyz", status: "scheduled" };
const notFound = () => Response.json({ error: "Scheduled meeting not found" }, { status: 404 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("looking up whether a link is a scheduled meeting", () => {
  it("finds the meeting and the client it belongs to", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("clientId=public") ? Response.json({ scheduledMeeting: meeting }) : notFound()));

    expect(await lookupScheduledMeetingForCode("abc-mnop-xyz")).toEqual({
      kind: "scheduled",
      clientId: "public",
      meeting,
    });
  });

  it("says a code nobody scheduled is not a scheduled meeting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));

    expect(await lookupScheduledMeetingForCode("abc-mnop-xyz")).toEqual({
      kind: "unscheduled",
    });
  });

  it.each([
    ["the SFU errors", async () => new Response(null, { status: 503 })],
    ["the SFU cannot be reached", async () => { throw new Error("fetch failed"); }],
    ["the SFU answers with something unreadable", async () => new Response("<html>", { status: 200 })],
  ])("does not call a meeting unscheduled when %s", async (_case, respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));

    expect(await lookupScheduledMeetingForCode("abc-mnop-xyz")).toEqual({
      kind: "unknown",
    });
  });

  it("still finds the meeting when another client's lookup failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("clientId=public")
        ? Response.json({ scheduledMeeting: meeting })
        : new Response(null, { status: 503 })));

    expect(await lookupScheduledMeetingForCode("abc-mnop-xyz")).toMatchObject({
      kind: "scheduled",
      clientId: "public",
    });
  });
});

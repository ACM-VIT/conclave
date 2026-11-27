import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lookupScheduledMeetingForCode,
  lookupScheduledMeetingHostEmail,
} from "../src/lib/scheduled-meetings";

let sfuUrls = ["http://sfu.test"];
vi.mock("@/lib/sfu-user-auth", () => ({ buildScheduledWebinarHeaders: vi.fn() }));
vi.mock("@/lib/sfu-admin-auth", () => ({
  resolveSfuSecret: () => "fixture",
  resolveSfuUrl: () => sfuUrls[0],
}));
vi.mock("@/lib/sfu-url", () => ({ resolveSfuUrls: () => sfuUrls }));
vi.mock("@/app/lib/utils", () => ({ readResponseError: async () => "Unavailable" }));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));

const destination = { clientId: "conclave", roomCode: "abc-mnop-xyz" };
const meeting = { id: "m1", roomCode: "abc-mnop-xyz", status: "scheduled" };
const notFound = () => Response.json({ error: "Scheduled meeting not found" }, { status: 404 });

// An SFU that accepts the request and then goes quiet, either before it
// answers at all or part way through the reply.
const stalledSfu = async (stallAt: "headers" | "body") => {
  const server: Server = createServer((_request, response) => {
    if (stallAt === "headers") return;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"scheduledMeeting":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const servers: Server[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  sfuUrls = ["http://sfu.test"];
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("looking up whether a link is a scheduled meeting", () => {
  it("finds the meeting, and the client and SFU it belongs to", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("clientId=conclave") ? Response.json({ scheduledMeeting: meeting }) : notFound()));

    expect(await lookupScheduledMeetingForCode(destination)).toEqual({
      kind: "scheduled",
      sfuUrl: "http://sfu.test",
      clientId: "conclave",
      meeting,
    });
  });

  it("says a code nobody scheduled is not a scheduled meeting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));

    expect(await lookupScheduledMeetingForCode(destination)).toEqual({
      kind: "unscheduled",
    });
  });

  it.each([
    ["the SFU errors", async () => new Response(null, { status: 503 })],
    ["the SFU cannot be reached", async () => { throw new Error("fetch failed"); }],
    ["the SFU answers with something unreadable", async () => new Response("<html>", { status: 200 })],
  ])("does not call a meeting unscheduled when %s", async (_case, respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));

    expect(await lookupScheduledMeetingForCode(destination)).toEqual({
      kind: "unknown",
    });
  });

  it.each(["headers", "body"] as const)(
    "does not hold the link page when an SFU stalls sending its %s",
    async (stallAt) => {
      sfuUrls = [await stalledSfu(stallAt)];
      const started = Date.now();

      expect(await lookupScheduledMeetingForCode(destination)).toEqual({
        kind: "unknown",
      });
      expect(Date.now() - started).toBeLessThan(4000);
    },
    8000,
  );

  it("finds a meeting on another SFU while the first one stalls", async () => {
    sfuUrls = [await stalledSfu("headers"), "http://sfu-b.test"];
    const realFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith("http://sfu-b.test")
        ? Response.json({ scheduledMeeting: meeting })
        : realFetch(url, init)));

    expect(await lookupScheduledMeetingForCode(destination)).toMatchObject({
      kind: "scheduled",
      meeting,
    });
  }, 8000);

  it("does not call a meeting unscheduled when one of two SFUs could not say", async () => {
    sfuUrls = ["http://sfu-a.test", "http://sfu-b.test"];
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("http://sfu-a.test") ? notFound() : new Response(null, { status: 503 })));

    expect(await lookupScheduledMeetingForCode(destination)).toEqual({
      kind: "unknown",
    });
  });

  it("says a code is unscheduled when every SFU says so", async () => {
    sfuUrls = ["http://sfu-a.test", "http://sfu-b.test"];
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));

    expect(await lookupScheduledMeetingForCode(destination)).toEqual({
      kind: "unscheduled",
    });
  });

  it("does not look for a booking in other tenants", async () => {
    const request = vi.fn(async (url: string) =>
      url.includes("clientId=public")
        ? Response.json({ scheduledMeeting: meeting })
        : notFound());
    vi.stubGlobal("fetch", request);

    expect(await lookupScheduledMeetingForCode(destination)).toEqual({ kind: "unscheduled" });
    expect(request.mock.calls.map(([url]) => new URL(url).searchParams.get("clientId"))).toEqual(["conclave"]);
  });
});

describe("checking whether the visitor hosts a scheduled meeting", () => {
  const hosted = { ...meeting, hostEmail: "Host@Example.com" };
  const found = async () => {
    const lookup = await lookupScheduledMeetingForCode(destination);
    if (lookup.kind !== "scheduled") throw new Error(`Lookup was ${lookup.kind}`);
    return lookup;
  };

  it("finds the host of a meeting that only the second SFU has", async () => {
    sfuUrls = ["http://sfu-a.test", "http://sfu-b.test"];
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("http://sfu-b.test") && url.includes("clientId=conclave")
        ? Response.json({ scheduledMeeting: hosted })
        : notFound()));

    expect(await lookupScheduledMeetingHostEmail(await found())).toBe(
      "host@example.com",
    );
  });

  it("does not hold the page when that SFU stalls after the lookup", async () => {
    sfuUrls = [await stalledSfu("headers")];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ scheduledMeeting: hosted })));
    const lookup = await found();
    vi.unstubAllGlobals();
    const started = Date.now();

    expect(await lookupScheduledMeetingHostEmail(lookup)).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
  }, 8000);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJoinInfo } from "../src/app/lib/join-info";
import { markMeetingCreatedHere } from "../src/app/lib/new-meeting";

const sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ token: "token", sfuUrl: "http://localhost:3031" });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ask = (roomId: string) =>
  requestJoinInfo({
    roomId,
    sessionId: "session",
    isHost: true,
    isKnownMeeting: false,
    clientId: "conclave",
    joinMode: "meeting",
  });

describe("a join request from a tab that made a new meeting", () => {
  it("says it creates the meeting only for the code the tab made", async () => {
    markMeetingCreatedHere("abc-mnop-xyz");
    await ask("abc-mnop-xyz");
    await ask("def-ghij-klm");

    expect(sent.map((body) => body.createsMeeting)).toEqual([true, false]);
  });
});

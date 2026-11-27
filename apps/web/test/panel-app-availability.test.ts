import { expect, it } from "vitest";
import { panelAppNeedsServerUpdate } from "../src/app/lib/panel-app-availability";

const joined = { isJoined: true, isWebinarAttendee: false };

it("says nothing while the server may still answer", () => {
  expect(panelAppNeedsServerUpdate({ ...joined, runtime: "unknown", offered: false })).toBe(false);
});

it("says an app needs a server update on a server that runs no such apps", () => {
  expect(panelAppNeedsServerUpdate({ ...joined, runtime: "unsupported", offered: false })).toBe(true);
});

it("says so too on a server that runs such apps and does not have this one", () => {
  // A server with the runtime on and no polls or Q&A answers with a list
  // that leaves them out. To the person in the call that is the same thing.
  expect(panelAppNeedsServerUpdate({ ...joined, runtime: "ready", offered: false })).toBe(true);
});

it("says nothing of an app the server offers", () => {
  expect(panelAppNeedsServerUpdate({ ...joined, runtime: "ready", offered: true })).toBe(false);
});

it("says nothing before the call is joined, or to a webinar attendee, who has no Apps panel", () => {
  expect(
    panelAppNeedsServerUpdate({ isJoined: false, isWebinarAttendee: false, runtime: "ready", offered: false }),
  ).toBe(false);
  expect(
    panelAppNeedsServerUpdate({ isJoined: true, isWebinarAttendee: true, runtime: "unsupported", offered: false }),
  ).toBe(false);
});

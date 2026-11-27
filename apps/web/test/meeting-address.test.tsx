// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingAddress } from "../src/app/hooks/useMeetingAddress";
import type { ConnectionState, JoinMode } from "../src/app/lib/types";

type Props = {
  enabled?: boolean;
  joinMode?: JoinMode;
  connectionState: ConnectionState;
  roomId: string;
};

function Harness({
  enabled = true,
  joinMode = "meeting",
  connectionState,
  roomId,
}: Props) {
  useMeetingAddress({ enabled, joinMode, connectionState, roomId });
  return null;
}

let root: Root;

const render = async (props: Props) => {
  await act(async () => root.render(<Harness {...props} />));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/");
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("meeting address bar", () => {
  it("shows the meeting code once a guest who typed it is in the call", async () => {
    await render({ connectionState: "joining", roomId: "abc-mnop-xyz" });
    expect(window.location.pathname).toBe("/");

    await render({ connectionState: "joined", roomId: "abc-mnop-xyz" });
    expect(window.location.pathname).toBe("/abc-mnop-xyz");
  });

  it("shows the meeting code while the guest is knocking", async () => {
    await render({ connectionState: "waiting", roomId: "abc-mnop-xyz" });
    expect(window.location.pathname).toBe("/abc-mnop-xyz");
  });

  it("leaves the address alone when a join fails", async () => {
    await render({ connectionState: "error", roomId: "abc-mnop-xyz" });
    expect(window.location.pathname).toBe("/");
  });

  it("keeps the query string of a link that already names the meeting", async () => {
    window.history.replaceState(null, "", "/abc-mnop-xyz?clientId=conclave");
    const before = window.history.length;
    await render({ connectionState: "joined", roomId: "abc-mnop-xyz" });
    expect(window.location.search).toBe("?clientId=conclave");
    expect(window.history.length).toBe(before);
  });

  it("does not rewrite webinar attendee links", async () => {
    window.history.replaceState(null, "", "/w/launch");
    await render({
      joinMode: "webinar_attendee",
      connectionState: "joined",
      roomId: "launch",
    });
    expect(window.location.pathname).toBe("/w/launch");
  });

  it("does nothing for tenants without room routing", async () => {
    await render({
      enabled: false,
      connectionState: "joined",
      roomId: "default-room",
    });
    expect(window.location.pathname).toBe("/");
  });
});

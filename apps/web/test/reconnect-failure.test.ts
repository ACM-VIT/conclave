import { ROOM_LEASE_UNCONFIRMED_ERROR } from "@conclave/meeting-core/host-commands";
import { isRecoverableReconnectFailure } from "../src/app/hooks/useMeetSocket";
import { describe, expect, it } from "vitest";
import {
  describeReconnectFailure,
  reconnectFailureKind,
} from "../src/app/lib/reconnect-failure";
import { ServerError } from "../src/app/lib/server-error";

const refusedWith = (responseStatus: number) =>
  Object.assign(new Error("Join info request failed"), { responseStatus });

describe("whether a failed reconnect is worth another try", () => {
  it("keeps trying while the room is not back yet after a restart", () => {
    // What someone who was knocking gets until a member recreates the room.
    expect(isRecoverableReconnectFailure(new Error("No room found."))).toBe(true);
  });

  it("keeps trying while the server is still opening the meeting", () => {
    // The SFU answers a join whose room is slow to open before the tab would
    // give up; the next try takes that opening over.
    expect(
      isRecoverableReconnectFailure(
        new Error("The meeting is still opening. Try again in a moment."),
      ),
    ).toBe(true);
  });

  it("keeps trying while the meeting is moving between servers", () => {
    expect(isRecoverableReconnectFailure(new Error(ROOM_LEASE_UNCONFIRMED_ERROR))).toBe(true);
  });

  it("keeps trying when the server cannot be reached or is failing", () => {
    expect(isRecoverableReconnectFailure(new Error("websocket error"))).toBe(true);
    expect(isRecoverableReconnectFailure(new Error("Connection timeout"))).toBe(true);
    expect(isRecoverableReconnectFailure(refusedWith(503))).toBe(true);
  });

  it("stops for an answer that trying again will not change", () => {
    expect(
      isRecoverableReconnectFailure(new Error("You are not allowed to join this meeting.")),
    ).toBe(false);
    expect(isRecoverableReconnectFailure(refusedWith(403))).toBe(false);
  });
});

describe("reconnect failures", () => {
  it("records a category for telemetry but shows the server's words on screen", () => {
    const ended = new ServerError("Riya, continue in room lime-pear-plum");

    expect(reconnectFailureKind(ended)).toBe("other");
    expect(describeReconnectFailure(ended)).toBe(
      "Riya, continue in room lime-pear-plum",
    );
  });

  it.each([
    [new Error("xhr poll error"), "network", "The browser could not reach the meeting server."],
    [new Error("Request timeout after 15000ms"), "timeout", "The meeting server did not respond before the timeout."],
    [new Error("NotAllowedError: Permission denied"), "permission", "Browser permission is blocking camera or microphone access."],
    [new Error(""), "no_reason", "The meeting server did not return an error reason."],
  ])("classifies %s as %s", (error, kind, text) => {
    expect(reconnectFailureKind(error)).toBe(kind);
    expect(describeReconnectFailure(error)).toBe(text);
  });
});

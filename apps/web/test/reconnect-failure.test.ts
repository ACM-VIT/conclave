import { describe, expect, it } from "vitest";
import {
  describeReconnectFailure,
  reconnectFailureKind,
} from "../src/app/lib/reconnect-failure";
import { ServerError } from "../src/app/lib/server-error";

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

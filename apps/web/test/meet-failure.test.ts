import { describe, expect, it } from "vitest";
import { joinFailureReason } from "../src/app/lib/call-quality-metrics";
import { createMeetError, MeetFailure } from "../src/app/lib/utils";

describe("failure reasons", () => {
  it("keeps a timeout's category when the message is rewritten for the user", () => {
    const meetError = createMeetError(new MeetFailure("Connection timeout", "timeout"));

    expect(meetError).toMatchObject({
      code: "CONNECTION_FAILED",
      message: "Failed to connect to server",
      reason: "timeout",
    });
    expect(joinFailureReason(meetError)).toBe("timeout");
  });

  it("still classifies an error that carries no reason", () => {
    expect(joinFailureReason(createMeetError(new Error("websocket error")))).toBe("connection_failed");
    expect(joinFailureReason(createMeetError(new Error("Invalid meeting invite code.")))).toBe("invite_code");
  });
});

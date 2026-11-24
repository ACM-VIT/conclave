import { describe, expect, it } from "vitest";
import { describeEnterError } from "../src/app/lib/meeting-enter-error";
import { createMediaDeviceError } from "../src/app/lib/utils";

const denied = () => new DOMException("Permission denied", "NotAllowedError");
const missing = () => new DOMException("Requested device not found", "NotFoundError");

describe("meeting entry errors", () => {
  it("explains a join that failed on device access with each device's own advice", () => {
    const error = createMediaDeviceError({ microphone: denied(), camera: missing() }, "PERMISSION_DENIED")!;
    expect(describeEnterError("join", error)).toEqual({
      title: "Microphone is blocked and no camera found",
      detail: "Allow microphone access in your browser, and connect or select a camera, then try again.",
      canRetry: false,
    });
  });

  it("describes a host rejection as a rejection, not a blocked device", () => {
    const result = describeEnterError("join", {
      code: "JOIN_REJECTED",
      message: "The host has denied your request to join.",
      recoverable: false,
    });
    expect(result.detail).toBe("The host has denied your request to join.");
    expect(result.title).not.toMatch(/blocked|camera|mic/i);
  });

  it("keeps the network wording for connection failures", () => {
    expect(
      describeEnterError("join", { code: "CONNECTION_FAILED", message: "Failed to connect to server", recoverable: true }),
    ).toMatchObject({ title: "Couldn't join the meeting", canRetry: true });
  });
});

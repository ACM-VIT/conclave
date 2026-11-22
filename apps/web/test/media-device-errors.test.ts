import { describe, expect, it, vi } from "vitest";
import { clearMediaDeviceError, createMeetError } from "../src/app/lib/utils";
import { retryFailedMediaDevices } from "../src/app/lib/media-retry";

const denied = new DOMException("Permission denied", "NotAllowedError");
const missing = new DOMException("Requested device not found", "NotFoundError");

describe("media device errors", () => {
  it("names only the device that was denied", () => {
    expect(createMeetError(denied, "PERMISSION_DENIED", "camera")).toMatchObject({
      code: "PERMISSION_DENIED",
      device: "camera",
      message: "Camera is blocked",
    });
    expect(createMeetError(denied, "MEDIA_ERROR", "microphone")).toMatchObject({
      code: "PERMISSION_DENIED",
      device: "microphone",
      message: "Microphone is blocked",
    });
    expect(createMeetError(denied, "PERMISSION_DENIED", "both").message).toBe(
      "Camera and microphone are blocked",
    );
  });

  it("names only the device that is missing", () => {
    expect(createMeetError(missing, "MEDIA_ERROR", "camera").message).toBe("No camera found");
    expect(createMeetError(missing, "MEDIA_ERROR", "microphone").message).toBe("No microphone found");
    expect(createMeetError(missing, "MEDIA_ERROR").message).toBe("Camera or microphone not found");
  });

  it("clears an error only when the device it names recovers", () => {
    const camera = createMeetError(denied, "MEDIA_ERROR", "camera");
    const microphone = createMeetError(denied, "MEDIA_ERROR", "microphone");
    const both = createMeetError(denied, "PERMISSION_DENIED", "both");
    const transport = { code: "TRANSPORT_ERROR" as const, message: "Failed to mute microphone", recoverable: true };

    expect(clearMediaDeviceError(camera, "camera")).toBeNull();
    expect(clearMediaDeviceError(camera, "microphone")).toBe(camera);
    expect(clearMediaDeviceError(microphone, "microphone")).toBeNull();
    expect(clearMediaDeviceError(microphone, "camera")).toBe(microphone);
    expect(clearMediaDeviceError(both, "camera")).toBe(both);
    expect(clearMediaDeviceError(transport, "microphone")).toBeNull();
    expect(clearMediaDeviceError(transport, "camera")).toBe(transport);
    expect(clearMediaDeviceError(null, "camera")).toBeNull();
  });
});

describe("retrying failed media devices", () => {
  const setup = (state: { isMuted: boolean; isCameraOff: boolean }) => {
    const calls: string[] = [];
    const unmute = vi.fn(async () => void calls.push("unmute"));
    const turnOnCamera = vi.fn(async () => void calls.push("camera"));
    return { calls, run: (device: "camera" | "microphone" | "both") => retryFailedMediaDevices({ device, ...state, unmute, turnOnCamera }) };
  };

  it("turns the camera back on after a camera failure and leaves the mic alone", async () => {
    const { calls, run } = setup({ isMuted: true, isCameraOff: true });
    await run("camera");
    expect(calls).toEqual(["camera"]);
  });

  it("unmutes after a microphone failure and leaves the camera alone", async () => {
    const { calls, run } = setup({ isMuted: true, isCameraOff: true });
    await run("microphone");
    expect(calls).toEqual(["unmute"]);
  });

  it("restores both devices after both failed, microphone first", async () => {
    const { calls, run } = setup({ isMuted: true, isCameraOff: true });
    await run("both");
    expect(calls).toEqual(["unmute", "camera"]);
  });

  it("requests nothing for a device that is already on", async () => {
    const { calls, run } = setup({ isMuted: false, isCameraOff: false });
    await run("both");
    expect(calls).toEqual([]);
  });
});

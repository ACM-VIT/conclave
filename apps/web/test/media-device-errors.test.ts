import { describe, expect, it, vi } from "vitest";
import { clearMediaDeviceError, createMeetError, mergeMediaDeviceError } from "../src/app/lib/utils";
import { isDevicePublishing, retryFailedMediaDevices } from "../src/app/lib/media-retry";

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
    expect(createMeetError(missing, "MEDIA_ERROR").message).toBe("No camera or microphone found");
  });

  it("clears an error only when the device it names recovers", () => {
    const camera = createMeetError(denied, "MEDIA_ERROR", "camera");
    const microphone = createMeetError(denied, "MEDIA_ERROR", "microphone");
    const screenShare = { code: "MEDIA_ERROR" as const, message: "Screen share stopped", recoverable: true };

    expect(clearMediaDeviceError(camera, "camera")).toBeNull();
    expect(clearMediaDeviceError(camera, "microphone")).toBe(camera);
    expect(clearMediaDeviceError(microphone, "microphone")).toBeNull();
    expect(clearMediaDeviceError(microphone, "camera")).toBe(microphone);
    expect(clearMediaDeviceError(screenShare, "microphone")).toBe(screenShare);
    expect(clearMediaDeviceError(null, "camera")).toBeNull();
  });

  it("narrows a two-device error to the device that is still failing", () => {
    const blocked = createMeetError(denied, "PERMISSION_DENIED", "both");
    expect(clearMediaDeviceError(blocked, "camera")).toMatchObject({
      code: "PERMISSION_DENIED",
      device: "microphone",
      message: "Microphone is blocked",
    });
    const absent = createMeetError(missing, "MEDIA_ERROR", "both");
    expect(clearMediaDeviceError(absent, "microphone")).toMatchObject({
      device: "camera",
      message: "No camera found",
    });
  });
});

describe("retrying failed media devices", () => {
  const setup = (initial: { microphone: boolean; camera: boolean }) => {
    const on = { ...initial };
    const calls: string[] = [];
    const run = (device: "camera" | "microphone" | "both") =>
      retryFailedMediaDevices({
        device,
        isOn: (d) => on[d],
        turnOn: async (d) => {
          calls.push(`turn on ${d}`);
          on[d] = true;
        },
        markRecovered: (d) => void calls.push(`recovered ${d}`),
      });
    return { calls, run, on };
  };

  it("turns the camera back on after a camera failure and leaves the mic alone", async () => {
    const { calls, run } = setup({ microphone: false, camera: false });
    await run("camera");
    expect(calls).toEqual(["turn on camera"]);
  });

  it("unmutes after a microphone failure and leaves the camera alone", async () => {
    const { calls, run } = setup({ microphone: false, camera: false });
    await run("microphone");
    expect(calls).toEqual(["turn on microphone"]);
  });

  it("restores both devices after both failed, microphone first", async () => {
    const { calls, run } = setup({ microphone: false, camera: false });
    await run("both");
    expect(calls).toEqual(["turn on microphone", "turn on camera"]);
  });

  it("re-reads device state between steps instead of using a stale snapshot", async () => {
    const { calls, on } = setup({ microphone: false, camera: false });
    await retryFailedMediaDevices({
      device: "both",
      isOn: (d) => on[d],
      turnOn: async (d) => {
        calls.push(`turn on ${d}`);
        on.microphone = true;
        on.camera = true;
      },
      markRecovered: (d) => void calls.push(`recovered ${d}`),
    });
    expect(calls).toEqual(["turn on microphone", "recovered camera"]);
  });

  it("only marks a device recovered when it is already live, without requesting it", async () => {
    const { calls, run } = setup({ microphone: true, camera: true });
    await run("both");
    expect(calls).toEqual(["recovered microphone", "recovered camera"]);
  });
});

describe("deciding whether a retried device is publishing", () => {
  const liveTrack = { readyState: "live", enabled: true } as MediaStreamTrack;
  const producer = (overrides: Partial<{ closed: boolean; paused: boolean; track: MediaStreamTrack | null }> = {}) => ({
    closed: false,
    paused: false,
    track: liveTrack,
    ...overrides,
  });

  it("counts a device as publishing only through a live, open, unpaused producer", () => {
    expect(isDevicePublishing({ intendedOn: true, producer: producer() })).toBe(true);
  });

  it("is not publishing when recovery threw and left the live local track without a producer", () => {
    expect(isDevicePublishing({ intendedOn: true, producer: null })).toBe(false);
    expect(isDevicePublishing({ intendedOn: true, producer: producer({ closed: true }) })).toBe(false);
  });

  it("is not publishing when the producer track ended, was disabled, or is paused", () => {
    expect(isDevicePublishing({ intendedOn: true, producer: producer({ track: { readyState: "ended", enabled: true } as MediaStreamTrack }) })).toBe(false);
    expect(isDevicePublishing({ intendedOn: true, producer: producer({ track: { readyState: "live", enabled: false } as MediaStreamTrack }) })).toBe(false);
    expect(isDevicePublishing({ intendedOn: true, producer: producer({ paused: true }) })).toBe(false);
  });

  it("is not publishing when the user has the device turned off", () => {
    expect(isDevicePublishing({ intendedOn: false, producer: producer() })).toBe(false);
  });
});

describe("tracking every device that is still failing", () => {
  it("keeps the microphone when the camera fails after it", () => {
    const mic = createMeetError(denied, "MEDIA_ERROR", "microphone");
    const camera = createMeetError(denied, "MEDIA_ERROR", "camera");
    const merged = mergeMediaDeviceError(mic, camera);
    expect(merged).toMatchObject({ device: "both", message: "Camera and microphone are blocked" });
    const afterMic = clearMediaDeviceError(merged, "microphone");
    expect(afterMic).toMatchObject({ device: "camera", message: "Camera is blocked" });
    expect(clearMediaDeviceError(afterMic, "camera")).toBeNull();
  });

  it("replaces an error for the same device, or one that names no device", () => {
    const camera = createMeetError(denied, "MEDIA_ERROR", "camera");
    const missingCamera = createMeetError(missing, "MEDIA_ERROR", "camera");
    expect(mergeMediaDeviceError(camera, missingCamera)).toBe(missingCamera);
    const transport = { code: "CONNECTION_FAILED" as const, message: "Failed to connect to server", recoverable: true };
    expect(mergeMediaDeviceError(transport, camera)).toBe(camera);
    expect(mergeMediaDeviceError(null, camera)).toBe(camera);
  });
});

describe("keeping each device's own cause", () => {
  it("restores the microphone's permission cause after a missing camera is fixed", () => {
    const micBlocked = createMeetError(denied, "PERMISSION_DENIED", "microphone");
    const cameraMissing = createMeetError(missing, "MEDIA_ERROR", "camera");
    const merged = mergeMediaDeviceError(micBlocked, cameraMissing);
    expect(merged).toMatchObject({
      device: "both",
      code: "PERMISSION_DENIED",
      message: "Microphone is blocked and no camera found",
    });
    expect(clearMediaDeviceError(merged, "camera")).toMatchObject({
      device: "microphone",
      code: "PERMISSION_DENIED",
      message: "Microphone is blocked",
    });
    expect(clearMediaDeviceError(merged, "microphone")).toMatchObject({
      device: "camera",
      code: "MEDIA_ERROR",
      message: "No camera found",
    });
  });
});


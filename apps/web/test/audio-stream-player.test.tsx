// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AudioStreamPlayer from "../src/app/components/AudioStreamPlayer";
import { DeviceSettingsSection } from "../src/app/components/DeviceCaretMenu";

vi.mock("../src/app/lib/telemetry", () => ({ telemetry: { capture: vi.fn() } }));

const originalSink = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
let root: Root;
let container: HTMLDivElement;
let mediaDevices: EventTarget & { enumerateDevices: ReturnType<typeof vi.fn> };
let inGesture: boolean;
let gestureAttempts: boolean[];
let play: ReturnType<typeof vi.spyOn>;

const stream = () => {
  const value = new MediaStream();
  const track = Object.assign(new EventTarget(), { readyState: "live", muted: false });
  vi.spyOn(value, "getAudioTracks").mockReturnValue([track as unknown as MediaStreamTrack]);
  return value;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mediaDevices = Object.assign(new EventTarget(), { enumerateDevices: vi.fn().mockResolvedValue([]) });
  vi.stubGlobal("navigator", { mediaDevices });
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  inGesture = false;
  gestureAttempts = [];
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
    gestureAttempts.push(inGesture);
    return Promise.reject(new DOMException("Tap required", "NotAllowedError"));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  if (originalSink) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", originalSink);
  else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AudioStreamPlayer gesture listeners", () => {
  it.each(["touchend", "click", "keydown"])("retries synchronously on %s with background retries pending", async (type) => {
    await act(async () => root.render(<AudioStreamPlayer kind="participant" stream={stream()} />));
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    play.mockClear();
    gestureAttempts = [];
    inGesture = true;
    window.dispatchEvent(new Event(type));
    inGesture = false;
    expect(play).toHaveBeenCalledTimes(1);
    expect(gestureAttempts).toEqual([true]);
  });

  it("removes gesture listeners and pending retries on unmount", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    await act(async () => root.render(<AudioStreamPlayer kind="participant" stream={stream()} />));
    const gestures = added.mock.calls.filter(([type]) => ["touchend", "click", "keydown"].includes(type));
    expect(gestures).toHaveLength(3);
    await act(async () => root.render(null));
    for (const [type, listener] of gestures) {
      expect(removed).toHaveBeenCalledWith(type, listener, true);
    }
    play.mockClear();
    for (const type of ["touchend", "click", "keydown"]) window.dispatchEvent(new Event(type));
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(play).not.toHaveBeenCalled();
  });
});

describe("speaker controls with restricted enumeration", () => {
  it("shows OS routing guidance when setSinkId exists but no output is exposed", async () => {
    await act(async () => root.render(<DeviceSettingsSection active onAudioOutputDeviceChange={() => {}} />));
    expect(container.textContent).toContain("System default speaker");
    expect(container.textContent).toContain("sound controls");
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("AudioStreamPlayer output lifecycle", () => {
  it("routes a disconnected current headset to the system output on devicechange", async () => {
    const headset = { kind: "audiooutput", deviceId: "headset", label: "Headset" };
    mediaDevices.enumerateDevices.mockResolvedValue([headset]);
    let sinkId = "";
    const setSinkId = vi.spyOn(HTMLMediaElement.prototype, "setSinkId")
      .mockImplementation(async (nextId) => { sinkId = nextId; });
    await act(async () => root.render(
      <AudioStreamPlayer kind="participant" stream={stream()} audioOutputDeviceId="headset" />,
    ));
    expect(sinkId).toBe("headset");
    mediaDevices.enumerateDevices.mockResolvedValue([]);
    setSinkId.mockClear();
    await act(async () => { mediaDevices.dispatchEvent(new Event("devicechange")); });
    expect(sinkId).toBe("");
    expect(setSinkId).toHaveBeenCalledExactlyOnceWith("");
  });

  it("does not fall back from an obsolete effect after the user selects another output", async () => {
    mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: "audiooutput", deviceId: "headset" },
      { kind: "audiooutput", deviceId: "speaker" },
    ]);
    let rejectOld: (error: Error) => void = () => {};
    const pending = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    let sinkId = "";
    const setSinkId = vi.spyOn(HTMLMediaElement.prototype, "setSinkId").mockImplementation((nextId) => {
      if (nextId === "headset") return pending;
      sinkId = nextId;
      return Promise.resolve();
    });
    const media = stream();
    await act(async () => root.render(
      <AudioStreamPlayer kind="participant" stream={media} audioOutputDeviceId="headset" />,
    ));
    expect(setSinkId).toHaveBeenCalledWith("headset");
    await act(async () => root.render(
      <AudioStreamPlayer kind="participant" stream={media} audioOutputDeviceId="speaker" />,
    ));
    await act(async () => { rejectOld(new DOMException("Disconnected", "NotFoundError")); });
    expect(sinkId).toBe("speaker");
    expect(setSinkId).not.toHaveBeenCalledWith("");
  });

  it("does not switch to a fallback after the player unmounts", async () => {
    mediaDevices.enumerateDevices.mockResolvedValue([{ kind: "audiooutput", deviceId: "headset" }]);
    let rejectOld: (error: Error) => void = () => {};
    const setSinkId = vi.spyOn(HTMLMediaElement.prototype, "setSinkId")
      .mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    await act(async () => root.render(
      <AudioStreamPlayer kind="participant" stream={stream()} audioOutputDeviceId="headset" />,
    ));
    expect(setSinkId).toHaveBeenCalledWith("headset");
    await act(async () => root.render(null));
    await act(async () => { rejectOld(new DOMException("Disconnected", "NotFoundError")); });
    expect(setSinkId).not.toHaveBeenCalledWith("");
  });
});

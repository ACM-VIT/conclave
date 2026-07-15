import { describe, expect, it, vi } from "vitest";
import {
  notifyRemoteVideoPresented,
  observeRemoteVideoPresentation,
  waitForRemoteVideoPresentation,
} from "../src/app/lib/remote-video-presentation";

const stream = () => ({}) as MediaStream;

describe("remote video presentation handoff", () => {
  it("settles only the exact presented stream", async () => {
    vi.useFakeTimers();
    try {
      const expected = stream();
      const unrelated = stream();
      const result = waitForRemoteVideoPresentation({
        stream: expected,
        timeoutMs: 1_000,
      });

      notifyRemoteVideoPresented(unrelated);
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      notifyRemoteVideoPresented(expected);
      await expect(result).resolves.toBe("presented");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds streams without a mounted presentation surface", async () => {
    vi.useFakeTimers();
    try {
      const result = waitForRemoteVideoPresentation({
        stream: stream(),
        timeoutMs: 250,
      });
      await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toBe("unobserved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes a mounted surface that never presents a frame", async () => {
    vi.useFakeTimers();
    try {
      const expected = stream();
      const video = {
        srcObject: expected,
        requestVideoFrameCallback: vi.fn(() => 7),
        cancelVideoFrameCallback: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLVideoElement;
      const stop = observeRemoteVideoPresentation(video, expected);
      const result = waitForRemoteVideoPresentation({
        stream: expected,
        timeoutMs: 250,
      });
      await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toBe("observed-timeout");
      stop();
      expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlaybackRecoveryScheduler } from "../src/app/lib/playback-recovery";

describe("playback recovery user gestures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      cancelAnimationFrame: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries synchronously inside a tap even with background retries pending", () => {
    let inGesture = false;
    const play = vi.fn(() => inGesture);
    const recovery = createPlaybackRecoveryScheduler({ attemptPlayback: play });
    recovery.schedule();
    vi.advanceTimersByTime(50);
    recovery.schedule();
    expect(play).toHaveBeenCalledTimes(1);
    inGesture = true;
    recovery.scheduleFromUserGesture();
    expect(play).toHaveBeenCalledTimes(2);
    expect(play).toHaveLastReturnedWith(true);
    inGesture = false;
    vi.advanceTimersByTime(120);
    expect(play).toHaveBeenCalledTimes(3);
    recovery.clear();
    vi.runAllTimers();
    expect(play).toHaveBeenCalledTimes(3);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyBackgroundAudioBuffer,
  BACKGROUND_AUDIO_JITTER_BUFFER_TARGET_MS,
} from "../src/app/lib/background-audio-playback";

describe("background audio playback", () => {
  it("adds receive headroom while the document is hidden", () => {
    const receiver = { jitterBufferTarget: null as number | null };

    expect(applyBackgroundAudioBuffer(receiver, false)).toEqual({
      status: "applied",
      observedTargetMs: BACKGROUND_AUDIO_JITTER_BUFFER_TARGET_MS,
    });
    expect(receiver.jitterBufferTarget).toBe(
      BACKGROUND_AUDIO_JITTER_BUFFER_TARGET_MS,
    );
  });

  it("restores browser-managed buffering in the foreground", () => {
    const receiver = {
      jitterBufferTarget: BACKGROUND_AUDIO_JITTER_BUFFER_TARGET_MS as
        | number
        | null,
    };

    expect(applyBackgroundAudioBuffer(receiver, true)).toEqual({
      status: "reset",
      observedTargetMs: null,
    });
    expect(receiver.jitterBufferTarget).toBeNull();
  });

  it("fails safely when the receiver does not support the API", () => {
    expect(applyBackgroundAudioBuffer({}, false)).toEqual({
      status: "unsupported",
      observedTargetMs: null,
    });
  });
});

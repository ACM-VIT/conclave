import { describe, expect, it, vi } from "vitest";
import {
  applyAudioOutputDevice,
  getAudioOutputOptions,
  SYSTEM_AUDIO_OUTPUT,
} from "../src/app/lib/audio-output";

const headset = { kind: "audiooutput" as const, deviceId: "headset", label: "Headset" };

describe("audio output devices", () => {
  it("keeps a system speaker visible when mobile enumeration omits outputs", () => {
    expect(getAudioOutputOptions([], false)).toEqual([SYSTEM_AUDIO_OUTPUT]);
    expect(getAudioOutputOptions([], true)).toEqual([SYSTEM_AUDIO_OUTPUT]);
  });

  it("does not offer devices a browser cannot route audio to", () => {
    expect(getAudioOutputOptions([headset], false)).toEqual([SYSTEM_AUDIO_OUTPUT]);
    expect(getAudioOutputOptions([headset], true)).toEqual([{ deviceId: "headset", label: "Headset" }]);
  });

  it("uses the system default when clearing a previous output selection", async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    await applyAudioOutputDevice({ setSinkId } as unknown as HTMLMediaElement);
    expect(setSinkId).toHaveBeenCalledWith("");
  });

  it("recovers to the system output when a selected headset disappears", async () => {
    const setSinkId = vi.fn()
      .mockRejectedValueOnce(new DOMException("Headset disconnected", "NotFoundError"))
      .mockResolvedValueOnce(undefined);
    await applyAudioOutputDevice({ setSinkId } as unknown as HTMLMediaElement, "headset");
    expect(setSinkId.mock.calls).toEqual([["headset"], [""]]);
  });

  it("preserves permission errors instead of silently claiming a switch succeeded", async () => {
    const error = new DOMException("Permission denied", "NotAllowedError");
    const setSinkId = vi.fn().mockRejectedValue(error);
    await expect(applyAudioOutputDevice({ setSinkId } as unknown as HTMLMediaElement, "headset"))
      .rejects.toBe(error);
    expect(setSinkId).toHaveBeenCalledTimes(1);
  });

  it("plays through the system output without a routing API", async () => {
    await expect(applyAudioOutputDevice({} as HTMLMediaElement, "headset"))
      .resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { acquireLocalTracks, settleLocalTracks } from "../src/app/lib/media-acquisition";

const track = (kind: "audio" | "video", id: string) =>
  ({ kind, id, readyState: "live" }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) =>
  ({ getTracks: () => tracks }) as unknown as MediaStream;
const denied = () => new DOMException("Permission denied", "NotAllowedError");

describe("acquiring one device while the other is already live", () => {
  it("keeps the live microphone as the same track when only the camera is asked for and denied", async () => {
    const microphone = track("audio", "mic");
    const request = vi.fn(async () => {
      throw denied();
    });
    const { streams, failures } = await acquireLocalTracks({ audio: false, video: true, request });
    expect(request).toHaveBeenCalledWith(false, true);
    expect(Object.keys(failures)).toEqual(["camera"]);

    const prepareAudio = vi.fn(async (input: MediaStreamTrack) => track("audio", `processed-${input.id}`));
    const settled = await settleLocalTracks({
      acquired: streams.flatMap((s) => s.getTracks()),
      reusable: { audio: microphone, video: null },
      prepareAudio,
    });
    expect(settled.audio).toBe(microphone);
    expect(settled.video).toBeNull();
    expect(prepareAudio).not.toHaveBeenCalled();
  });

  it("keeps the live camera when only the microphone is asked for and denied", async () => {
    const camera = track("video", "cam");
    const { streams, failures } = await acquireLocalTracks({
      audio: true,
      video: false,
      request: async () => {
        throw denied();
      },
    });
    expect(Object.keys(failures)).toEqual(["microphone"]);
    const settled = await settleLocalTracks({
      acquired: streams.flatMap((s) => s.getTracks()),
      reusable: { audio: null, video: camera },
      prepareAudio: async (input) => input,
    });
    expect(settled.video).toBe(camera);
    expect(settled.audio).toBeNull();
  });

  it("prepares a freshly acquired microphone for publishing", async () => {
    const fresh = track("audio", "fresh");
    const processed = track("audio", "processed");
    const { streams } = await acquireLocalTracks({
      audio: true,
      video: false,
      request: async () => stream(fresh),
    });
    const settled = await settleLocalTracks({
      acquired: streams.flatMap((s) => s.getTracks()),
      reusable: { audio: null, video: null },
      prepareAudio: async () => processed,
    });
    expect(settled.audio).toBe(processed);
  });

  it("drops only the microphone when preparing a fresh one fails", async () => {
    const camera = track("video", "cam");
    const failure = new Error("worklet failed");
    const settled = await settleLocalTracks({
      acquired: [track("audio", "fresh"), camera],
      reusable: { audio: null, video: null },
      prepareAudio: async () => {
        throw failure;
      },
    });
    expect(settled.audio).toBeNull();
    expect(settled.video).toBe(camera);
    expect(settled.audioFailure).toBe(failure);
  });
});

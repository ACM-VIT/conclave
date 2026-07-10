import { describe, expect, it } from "vitest";
import {
  createWatchDoc,
  getPlayback,
  setVideo,
  writePlayback,
} from "../../../packages/apps-sdk/src/apps/watch/core/doc/index";
import {
  liveEdgeLag,
  liveEdgeTime,
  planPlaybackCorrection,
} from "../../../packages/apps-sdk/src/apps/watch/web/playbackSync";

describe("watch-together live playback", () => {
  it("persists live-edge mode and clears it for the next video", () => {
    const doc = createWatchDoc();
    setVideo(doc, "abcdefghijk", { play: true });
    expect(getPlayback(doc).liveEdge).toBe(false);

    writePlayback(doc, {
      state: "playing",
      positionSeconds: 3_600,
      rate: 1,
      liveEdge: true,
    });
    expect(getPlayback(doc).liveEdge).toBe(true);

    setVideo(doc, "lmnopqrstuv", { play: true });
    expect(getPlayback(doc).liveEdge).toBe(false);
  });

  it("keeps small playing drift seamless and seeks real jumps", () => {
    expect(
      planPlaybackCorrection({
        current: 10,
        target: 10.3,
        state: "playing",
        baseRate: 1,
      }),
    ).toEqual({ kind: "settled", rate: 1 });

    expect(
      planPlaybackCorrection({
        current: 10,
        target: 12,
        state: "playing",
        baseRate: 1,
      }),
    ).toEqual({ kind: "rate", rate: 1.25 });

    expect(
      planPlaybackCorrection({
        current: 10,
        target: 12,
        state: "playing",
        baseRate: 1,
        forceSeek: true,
      }),
    ).toEqual({ kind: "seek", rate: 1, target: 12 });
  });

  it("leaves headroom at the live edge and reports viewer delay", () => {
    expect(liveEdgeTime(100)).toBe(98.75);
    expect(liveEdgeLag(90, 100)).toBe(8.75);
    expect(liveEdgeTime(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

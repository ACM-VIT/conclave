import { describe, expect, it } from "vitest";
import {
  advanceQueue,
  createWatchDoc,
  enqueue,
  getPlayback,
  playQueueItemNow,
  setVideo,
  writePlayback,
} from "../../../packages/apps-sdk/src/apps/watch/core/doc/index";
import {
  liveEdgeLag,
  liveEdgeTime,
  planPlaybackCorrection,
} from "../../../packages/apps-sdk/src/apps/watch/web/playbackSync";

describe("watch-together live playback", () => {
  it("keeps fresh live-edge intent but preserves an early explicit seek", () => {
    const doc = createWatchDoc();
    setVideo(doc, "abcdefghijk", { play: true });
    expect(getPlayback(doc).liveEdge).toBe(true);

    writePlayback(doc, {
      state: "playing",
      positionSeconds: 0.25,
      rate: 1,
      liveEdge: false,
    });
    expect(getPlayback(doc).liveEdge).toBe(false);

    setVideo(doc, "lmnopqrstuv", { play: true });
    expect(getPlayback(doc).liveEdge).toBe(true);

    const playNow = enqueue(doc, { videoId: "01234567890" });
    playQueueItemNow(doc, playNow.id);
    expect(getPlayback(doc).liveEdge).toBe(true);

    writePlayback(doc, {
      state: "playing",
      positionSeconds: 15,
      liveEdge: false,
    });
    enqueue(doc, { videoId: "zyxwvutsrqp" });
    advanceQueue(doc, "01234567890");
    expect(getPlayback(doc).liveEdge).toBe(true);
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

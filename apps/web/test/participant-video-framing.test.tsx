// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ParticipantVideo from "../src/app/components/ParticipantVideo";
import {
  readVideoAspect,
  resolveTileAspect,
} from "../src/app/lib/tile-video-framing";
import type { Participant } from "../src/app/lib/types";

vi.mock("../src/app/components/games/GameTileOverlay", () => ({
  default: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const fakeStream = () => new MediaStream();

const cameraParticipant = (videoStream: MediaStream): Participant => ({
  userId: "phone",
  videoStream,
  audioStream: null,
  screenShareStream: null,
  screenShareAudioStream: null,
  audioProducerId: null,
  videoProducerId: "producer",
  screenShareProducerId: null,
  screenShareAudioProducerId: null,
  isMuted: true,
  isCameraOff: false,
  isVideoAdaptivelyPaused: false,
  isHandRaised: false,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const renderTile = (
  props: Partial<Parameters<typeof ParticipantVideo>[0]> = {},
  asScreenShare = false,
) => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const stream = fakeStream();
  const participant = asScreenShare
    ? { ...cameraParticipant(stream), screenShareStream: stream, screenShareProducerId: "share" }
    : cameraParticipant(stream);
  const render = (next: Partial<Parameters<typeof ParticipantVideo>[0]>) =>
    act(() =>
      root!.render(
        <ParticipantVideo
          participant={participant}
          displayName="Phone"
          disableAudio
          tileWidth={960}
          tileHeight={540}
          onToggleFullVideo={() => {}}
          {...props}
          {...next}
        />,
      ),
    );
  render({});
  const video = host.querySelector("video")!;
  const receiveFrames = (width: number, height: number) => {
    Object.defineProperty(video, "videoWidth", { configurable: true, value: width });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: height });
    act(() => {
      video.dispatchEvent(new Event("resize"));
    });
  };
  const toggle = () => host!.querySelector("[data-meet-tile-crop-toggle]");
  const backdrop = () =>
    host!.querySelector<HTMLVideoElement>("[data-meet-tile-video-backdrop]");
  return { video, receiveFrames, toggle, backdrop, render };
};

describe("remote tile framing", () => {
  it("zooms a portrait phone part way over a blurred copy and offers the full video", () => {
    const tile = renderTile({ videoObjectFit: "contain" });
    expect(tile.video.dataset.meetTileVideoFraming).toBe("contain");
    expect(tile.toggle()).toBeNull();
    expect(tile.backdrop()).toBeNull();

    tile.receiveFrames(720, 1280);
    expect(tile.video.dataset.meetTileVideoFraming).toBe("portrait-zoom");
    expect(tile.video.style.height).toBe("166.66666666666669%");
    expect(tile.video.style.top).toBe("-33.33333333333334%");
    expect(tile.video.className).not.toContain("bg-black");
    expect(tile.backdrop()?.srcObject).toBe(tile.video.srcObject);
    expect(tile.backdrop()?.style.filter).toBe("blur(32px) brightness(1.05) saturate(1.15)");
    expect(tile.toggle()?.getAttribute("aria-label")).toBe("Show the full video");

    tile.render({ isFullVideoShown: true });
    expect(tile.video.dataset.meetTileVideoFraming).toBe("portrait-full");
    expect(tile.video.style.height).toBe("");
    expect(tile.backdrop()).not.toBeNull();
  });

  it("keeps cropping landscape video and zooms less when the phone turns portrait", () => {
    const tile = renderTile({ videoObjectFit: "cover" });
    tile.receiveFrames(1280, 720);
    expect(tile.video.dataset.meetTileVideoFraming).toBe("cover");
    expect(tile.toggle()).toBeNull();
    expect(tile.backdrop()).toBeNull();

    tile.receiveFrames(720, 1280);
    expect(tile.video.dataset.meetTileVideoFraming).toBe("portrait-zoom");
  });

  it("keeps the full video and the way back after the phone turns landscape", () => {
    const tile = renderTile();
    tile.receiveFrames(720, 1280);
    tile.render({ isFullVideoShown: true });
    expect(tile.video.dataset.meetTileVideoFraming).toBe("portrait-full");

    tile.receiveFrames(1280, 720);
    expect(tile.video.dataset.meetTileVideoFraming).toBe("contain");
    expect(tile.toggle()?.getAttribute("aria-label")).toBe("Crop this video");
  });

  it("never crops a portrait shared screen", () => {
    const tile = renderTile({ videoObjectFit: "contain" }, true);
    tile.receiveFrames(720, 1280);
    expect(tile.video.dataset.meetVideoStreamType).toBe("screen");
    expect(tile.video.dataset.meetTileVideoFraming).toBe("contain");
    expect(tile.toggle()).toBeNull();
    expect(tile.backdrop()).toBeNull();
  });
});

describe("grid tile shape", () => {
  const tileAspectFor = (width: number, height: number, full: boolean) =>
    resolveTileAspect(readVideoAspect(width, height), full);

  it("gives landscape, unknown and camera-off video a 16:9 tile", () => {
    expect(tileAspectFor(1280, 720, false)).toBe(16 / 9);
    expect(tileAspectFor(640, 480, true)).toBe(16 / 9);
    expect(tileAspectFor(0, 0, false)).toBe(16 / 9);
    expect(resolveTileAspect(null, true)).toBe(16 / 9);
  });

  it("crops a portrait phone to 3:4 and shows its own shape in full", () => {
    expect(tileAspectFor(720, 1280, false)).toBe(3 / 4);
    expect(tileAspectFor(720, 1280, true)).toBe(9 / 16);
    expect(tileAspectFor(1080, 1440, true)).toBe(3 / 4);
  });

  it("treats a nearly square portrait camera as portrait", () => {
    expect(tileAspectFor(479, 480, false)).toBe(3 / 4);
    expect(tileAspectFor(480, 480, false)).toBe(16 / 9);
  });

  it("never makes a full-video tile narrower than 9:16", () => {
    expect(tileAspectFor(720, 1600, true)).toBe(9 / 16);
  });

  it("keeps one shape across the simulcast layers of a camera", () => {
    const layers = [
      [720, 1280],
      [540, 960],
      [360, 640],
      [136, 240],
      [180, 318],
    ];
    for (const full of [false, true]) {
      const shapes = new Set(layers.map(([w, h]) => tileAspectFor(w, h, full)));
      expect(shapes.size).toBe(1);
    }
  });
});

describe("remote tile shape reporting", () => {
  it("reports the video's shape only when it changes", () => {
    const onVideoAspectChange = vi.fn();
    const tile = renderTile({ onVideoAspectChange });
    onVideoAspectChange.mockClear();

    tile.receiveFrames(720, 1280);
    expect(onVideoAspectChange.mock.calls).toEqual([[9 / 16]]);

    tile.receiveFrames(360, 640);
    tile.receiveFrames(136, 240);
    expect(onVideoAspectChange).toHaveBeenCalledTimes(1);

    tile.receiveFrames(1280, 720);
    expect(onVideoAspectChange.mock.calls).toEqual([[9 / 16], [16 / 9]]);
  });

  it("holds a shape between two camera shapes across layer switches", () => {
    const onVideoAspectChange = vi.fn();
    const tile = renderTile({ onVideoAspectChange });
    onVideoAspectChange.mockClear();

    // 0.773 and 0.775 sit either side of the 3:4 / 4:5 midpoint.
    tile.receiveFrames(495, 640);
    tile.receiveFrames(124, 160);
    expect(onVideoAspectChange.mock.calls).toEqual([[3 / 4]]);

    tile.receiveFrames(512, 640);
    expect(onVideoAspectChange.mock.calls).toEqual([[3 / 4], [4 / 5]]);
  });

  it("fills a tile already shaped to the video without zoom or blur", () => {
    const tile = renderTile({ videoObjectFit: "cover", isTileShapedToVideo: true });
    tile.receiveFrames(720, 1280);
    expect(tile.video.dataset.meetTileVideoFraming).toBe("cover");
    expect(tile.video.style.height).toBe("");
    expect(tile.backdrop()).toBeNull();

    tile.render({ videoObjectFit: "contain", isFullVideoShown: true });
    expect(tile.video.dataset.meetTileVideoFraming).toBe("contain");
    expect(tile.backdrop()).toBeNull();
  });
});

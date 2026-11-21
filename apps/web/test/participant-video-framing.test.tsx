// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ParticipantVideo from "../src/app/components/ParticipantVideo";
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
) => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const participant = cameraParticipant(fakeStream());
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
});

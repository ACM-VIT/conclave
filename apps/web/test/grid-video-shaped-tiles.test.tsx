// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GridLayout from "../src/app/components/GridLayout";
import {
  DEFAULT_MEET_VIEW_SETTINGS,
  type MeetViewSettings,
} from "../src/app/lib/meet-view";
import type { Participant } from "../src/app/lib/types";

vi.mock("../src/app/components/games/GameTileOverlay", () => ({
  default: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const GRID_WIDTH = 1312;
const GRID_HEIGHT = 752;

const cameraParticipant = (userId: string): Participant => ({
  userId,
  videoStream: new MediaStream(),
  audioStream: null,
  screenShareStream: null,
  screenShareAudioStream: null,
  audioProducerId: null,
  videoProducerId: `producer-${userId}`,
  screenShareProducerId: null,
  screenShareAudioProducerId: null,
  isMuted: true,
  isCameraOff: false,
  isVideoAdaptivelyPaused: false,
  isHandRaised: false,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-meet-view-layout")
        ? new DOMRect(0, 0, GRID_WIDTH, GRID_HEIGHT)
        : measure.call(this);
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const renderGrid = (viewSettings: Partial<MeetViewSettings> = {}) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <GridLayout
        meetingPath="/team-room?clientId=conclave"
        localStream={null}
        isCameraOff
        isMuted
        isHandRaised={false}
        participants={
          new Map([
            ["phone", cameraParticipant("phone")],
            ["laptop", cameraParticipant("laptop")],
          ])
        }
        userEmail="local"
        currentUserId="local"
        isMirrorCamera={false}
        activeSpeakerId={null}
        getDisplayName={(id) => id}
        viewSettings={{ ...DEFAULT_MEET_VIEW_SETTINGS, ...viewSettings }}
        isMobile={false}
      />,
    ),
  );
  const tile = (userId: string) =>
    host!.querySelector<HTMLElement>(`[data-userid="${userId}"]`)!;
  const size = (userId: string) => ({
    width: parseFloat(tile(userId).style.width),
    height: parseFloat(tile(userId).style.height),
  });
  const sendFrames = (userId: string, width: number, height: number) => {
    const video = tile(userId).querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: width });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: height });
    act(() => {
      video.dispatchEvent(new Event("resize"));
    });
  };
  const toggleFullVideo = (userId: string) =>
    act(() => {
      host!
        .querySelector<HTMLButtonElement>(`[data-meet-tile-crop-toggle="${userId}"]`)!
        .click();
    });
  const framing = (userId: string) =>
    tile(userId).querySelector<HTMLVideoElement>("[data-meet-tile-video]")!.dataset
      .meetTileVideoFraming;
  return { tile, size, sendFrames, toggleFullVideo, framing };
};

describe("auto grid tiles shaped to each camera", () => {
  it("gives a portrait phone a narrower tile at the landscape tile's height", () => {
    const grid = renderGrid();
    grid.sendFrames("phone", 720, 1280);
    grid.sendFrames("laptop", 1280, 720);

    const phone = grid.size("phone");
    const laptop = grid.size("laptop");
    expect(phone.height).toBe(laptop.height);
    expect(phone.width / phone.height).toBeCloseTo(3 / 4, 2);
    expect(laptop.width / laptop.height).toBeCloseTo(16 / 9, 2);
    expect(grid.framing("phone")).toBe("cover");
    expect(grid.tile("phone").querySelector("[data-meet-tile-video-backdrop]")).toBeNull();
  });

  it("narrows the phone to its full 9:16 shape and back when toggled", () => {
    const grid = renderGrid();
    grid.sendFrames("phone", 720, 1280);
    const cropped = grid.size("phone");

    grid.toggleFullVideo("phone");
    const full = grid.size("phone");
    expect(full.width / full.height).toBeCloseTo(9 / 16, 2);
    expect(full.width / full.height).toBeLessThan(cropped.width / cropped.height);
    expect(grid.framing("phone")).toBe("contain");

    grid.toggleFullVideo("phone");
    expect(grid.size("phone").width / grid.size("phone").height).toBeCloseTo(3 / 4, 2);
  });

  it("returns the tile to 16:9 when the phone turns landscape", () => {
    const grid = renderGrid();
    grid.sendFrames("phone", 720, 1280);
    expect(grid.size("phone").width / grid.size("phone").height).toBeCloseTo(3 / 4, 2);

    grid.sendFrames("phone", 1280, 720);
    const phone = grid.size("phone");
    expect(phone.width / phone.height).toBeCloseTo(16 / 9, 2);
  });

  it("keeps every tile 16:9 with the blurred fill in the fixed tiled layout", () => {
    const grid = renderGrid({ mode: "tiled" });
    grid.sendFrames("phone", 720, 1280);

    const phone = grid.size("phone");
    expect(phone.width / phone.height).toBeCloseTo(16 / 9, 2);
    expect(grid.framing("phone")).toBe("portrait-zoom");
    expect(
      grid.tile("phone").querySelector("[data-meet-tile-video-backdrop]"),
    ).not.toBeNull();
  });
});

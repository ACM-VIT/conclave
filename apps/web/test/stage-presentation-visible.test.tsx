// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GridLayout from "../src/app/components/GridLayout";
import { DEFAULT_MEET_VIEW_SETTINGS, type MeetViewMode } from "../src/app/lib/meet-view";
import type { Participant } from "../src/app/lib/types";

vi.mock("../src/app/components/games/GameTileOverlay", () => ({
  default: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const liveVideo = (id: string) => {
  const track = {
    kind: "video",
    id,
    enabled: true,
    muted: false,
    readyState: "live",
    getSettings: () => ({ width: 1280, height: 720 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    stop: () => {},
  } as unknown as MediaStreamTrack;
  return Object.assign(new MediaStream(), {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  });
};

const cameraParticipant = (userId: string): Participant => ({
  userId,
  videoStream: liveVideo(`camera-${userId}`),
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
let gridSize = { width: 0, height: 0 };

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-meet-view-layout")
        ? new DOMRect(0, 0, gridSize.width, gridSize.height)
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

const DESKTOP = { width: 1312, height: 752 };

const renderPinnedShare = (mode: MeetViewMode, size: { width: number; height: number }) => {
  const activeSpeakerId = mode === "auto" ? "bob" : null;
  gridSize = DESKTOP;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const grid = (sidePanelReserve: number) => (
    <GridLayout
      localStream={null}
      isCameraOff
      isMuted
      isHandRaised={false}
      participants={
        new Map([
          ["bob", cameraParticipant("bob")],
          ["carol", cameraParticipant("carol")],
        ])
      }
      userEmail="local"
      currentUserId="local"
      isMirrorCamera={false}
      activeSpeakerId={activeSpeakerId}
      getDisplayName={(id) => id}
      viewSettings={{ ...DEFAULT_MEET_VIEW_SETTINGS, mode }}
      isMobile={false}
      presentationStream={screen}
      presenterName="carol"
      presentationPresenterId="carol"
      sidePanelReserve={sidePanelReserve}
    />
  );
  act(() => root!.render(grid(0)));
  const pin = host!.querySelector<HTMLButtonElement>(
    '[data-userid="bob"] button[aria-label="Pin to spotlight"]',
  );
  expect(pin).not.toBeNull();
  act(() => pin!.click());
  gridSize = size;
  act(() => root!.render(grid(DESKTOP.width - size.width)));
  const presentation = host!.querySelector<HTMLElement>("[data-meet-presentation-tile]");
  return {
    split: host!.querySelector("[data-meet-stage-split]")?.getAttribute("data-meet-stage-split"),
    main: host!.querySelector("[data-meet-stage-main]")?.getAttribute("data-meet-stage-main"),
    presentationInRail: Boolean(presentation?.closest("[data-meet-stage-rail]")),
    presentationPin:
      presentation?.querySelector('button[aria-label="Pin to spotlight"], button[aria-label="Unpin"]') ?? null,
  };
};

const screen = liveVideo("screen");

const MODES = ["sidebar", "tiled", "auto"] as const;

it.each(MODES)(
  "in %s view, a pinned camera that leaves no room for a side rail hands the stage to the live presentation",
  (mode) => {
    const view = renderPinnedShare(mode, { width: 248, height: 171 });

    expect(view.split).toBe("main-only");
    expect(view.main).toBe("__presentation__");
    expect(view.presentationInRail).toBe(false);
    expect(view.presentationPin).not.toBeNull();
  },
);

it.each(MODES)(
  "in %s view, a pinned camera takes the stage and the live presentation stays in the side rail",
  (mode) => {
    const view = renderPinnedShare(mode, DESKTOP);

    expect(view.split).toBe("side");
    expect(view.main).toBe("bob");
    expect(view.presentationInRail).toBe(true);
    expect(view.presentationPin).not.toBeNull();
  },
);

it("in sidebar view, a stacked rail hands the stage to the live presentation", () => {
  const view = renderPinnedShare("sidebar", { width: 248, height: 600 });

  expect(view.split).toBe("stack");
  expect(view.main).toBe("__presentation__");
  expect(view.presentationInRail).toBe(false);
});

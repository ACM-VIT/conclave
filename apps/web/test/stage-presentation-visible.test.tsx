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
  const grid = (viewMode: MeetViewMode, sidePanelReserve: number, presenting: boolean) => (
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
      viewSettings={{ ...DEFAULT_MEET_VIEW_SETTINGS, mode: viewMode }}
      isMobile={false}
      presentationStream={presenting ? screen : null}
      presenterName="carol"
      presentationPresenterId="carol"
      sidePanelReserve={sidePanelReserve}
    />
  );
  act(() => root!.render(grid("sidebar", 0, false)));
  const pin = host!.querySelector<HTMLButtonElement>(
    '[data-userid="bob"] button[aria-label="Pin to spotlight"]',
  );
  expect(pin).not.toBeNull();
  act(() => pin!.click());
  gridSize = size;
  act(() => root!.render(grid(mode, DESKTOP.width - size.width, true)));
  const presentation = host!.querySelector<HTMLElement>("[data-meet-presentation-tile]");
  return {
    split: host!.querySelector("[data-meet-stage-split]")?.getAttribute("data-meet-stage-split"),
    main: host!.querySelector("[data-meet-stage-main]")?.getAttribute("data-meet-stage-main"),
    presentation,
    presentationInRail: Boolean(presentation?.closest("[data-meet-stage-rail]")),
    presentationPin:
      presentation?.querySelector<HTMLButtonElement>('button[aria-label="Pin to spotlight"], button[aria-label="Unpin"]') ?? null,
  };
};

const screen = liveVideo("screen");

const MODES = ["sidebar", "tiled", "auto", "spotlight"] as const;

it.each(MODES.flatMap((mode) => [
  { mode, size: { width: 248, height: 171 }, split: "main-only" },
  { mode, size: { width: 248, height: 196 }, split: "main-only" },
  { mode, size: { width: 248, height: 600 }, split: "stack" },
  { mode, size: DESKTOP, split: "side" },
]))(
  "keeps the live presentation and its pin in $mode view with a $split split",
  ({ mode, size, split }) => {
    const view = renderPinnedShare(mode, size);

    expect(view.presentation).not.toBeNull();
    expect(view.presentation?.closest(".hidden")).toBeNull();
    expect(view.split).toBe(split);
    expect(view.main).toBe(split === "side" ? "bob" : "__presentation__");
    expect(view.presentationInRail).toBe(split === "side");
    expect(view.presentationPin?.disabled).toBe(false);
    act(() => view.presentationPin!.click());
    expect(host!.querySelector('[data-meet-presentation-tile] button[aria-label="Unpin"]')).not.toBeNull();
  },
);

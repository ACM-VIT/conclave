// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GridLayout from "../src/app/components/GridLayout";
import { DEFAULT_MEET_VIEW_SETTINGS, type MeetSelfViewMode, type MeetViewMode } from "../src/app/lib/meet-view";
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

function stageHarness(remoteIds: string[], selfViewMode: MeetSelfViewMode) {
  gridSize = DESKTOP;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const participants = new Map(remoteIds.map((id) => [id, cameraParticipant(id)]));
  return (mode: MeetViewMode, size = DESKTOP, presenting = false) => {
    gridSize = size;
    act(() => root!.render(
      <GridLayout
        localStream={null}
        isCameraOff
        isMuted
        isHandRaised={false}
        participants={participants}
        userEmail="local"
        currentUserId="local"
        isMirrorCamera={false}
        activeSpeakerId={mode === "auto" ? remoteIds[0] ?? null : null}
        getDisplayName={(id) => id}
        viewSettings={{ ...DEFAULT_MEET_VIEW_SETTINGS, mode, selfViewMode }}
        isMobile={false}
        presentationStream={presenting ? screen : null}
        presenterName="carol"
        presentationPresenterId="carol"
        sidePanelReserve={DESKTOP.width - size.width}
      />,
    ));
    return host!.querySelector<HTMLElement>("[data-meet-view-layout]")!;
  };
}

function pinRemote(grid: HTMLElement, id: string) {
  const pin = grid.querySelector<HTMLButtonElement>(
    `[data-userid="${id}"] button[aria-label="Pin to spotlight"]`,
  );
  expect(pin).not.toBeNull();
  act(() => pin!.click());
}

const renderPinnedShare = (mode: MeetViewMode, size: { width: number; height: number }) => {
  const render = stageHarness(["bob", "carol"], "auto");
  pinRemote(render("sidebar"), "bob");
  const grid = render(mode, size, true);
  const presentation = grid.querySelector<HTMLElement>("[data-meet-presentation-tile]");
  return {
    split: grid.querySelector("[data-meet-stage-split]")?.getAttribute("data-meet-stage-split"),
    main: grid.querySelector("[data-meet-stage-main]")?.getAttribute("data-meet-stage-main"),
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

const REMOTES = ["bob", "carol", "dave", "erin"];
const SELF_VIEWS = ["floating", "tile"] as const;
const STAGE_SIZES = [{ width: 248, height: 600 }, { width: 248, height: 196 }];

it.each(MODES.flatMap((mode) => SELF_VIEWS.flatMap((selfViewMode) =>
  REMOTES.flatMap((id) => STAGE_SIZES.map((size) => ({ mode, selfViewMode, id, size, height: size.height }))),
)))("keeps $id visible and unpinnable during a share in $mode with $selfViewMode self-view at height $height", ({
  mode, selfViewMode, id, size,
}) => {
  const render = stageHarness(REMOTES, selfViewMode);
  pinRemote(render("sidebar"), id);
  const grid = render(mode, size, true);
  const tile = grid.querySelector<HTMLElement>(`.acm-video-tile[data-userid="${id}"]`);
  const button = tile?.querySelector<HTMLButtonElement>('button[aria-label="Unpin"]');

  expect(grid.querySelector("[data-meet-stage-main] [data-meet-presentation-tile]")).not.toBeNull();
  expect(button, "pin is not in a rendered camera tile").toBeDefined();
  expect(tile?.closest(".hidden")).toBeNull();
  if (size.height === 600) {
    expect(tile?.closest("[data-meet-stage-rail]")).not.toBeNull();
    expect(grid.querySelector("[data-meet-stage-rail] .acm-video-tile")).toBe(tile);
  }
  act(() => button!.click());
  expect(grid.querySelector(`.acm-video-tile[data-userid="${id}"] button[aria-label="Unpin"]`)).toBeNull();
});

it.each(MODES.flatMap((mode) => SELF_VIEWS.map((selfViewMode) => ({ mode, selfViewMode }))))(
  "reports only rendered cameras in $mode with $selfViewMode self-view at 248 x 196",
  ({ mode, selfViewMode }) => {
    const remoteIds = REMOTES.slice(0, 2);
    const grid = stageHarness(remoteIds, selfViewMode)(mode, STAGE_SIZES[1]);
    const rendered = remoteIds.filter((id) =>
      [...grid.querySelectorAll(`.acm-video-tile[data-userid="${id}"]`)]
        .some((tile) => !tile.closest('.hidden, [aria-hidden="true"]')),
    );
    const visible = grid.getAttribute("data-meet-room-tiling-visible-ids")?.split(",").filter(Boolean) ?? [];
    expect.soft(visible.sort()).toEqual(rendered);
    const primary = grid.getAttribute("data-meet-room-tiling-primary-ids")?.split(",") ?? [];
    expect(primary.filter((id) => remoteIds.includes(id)).sort()).toEqual(rendered);
  },
);

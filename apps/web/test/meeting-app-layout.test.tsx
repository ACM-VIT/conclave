// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GameProvider } from "@conclave/apps-sdk";
import MeetingAppLayout from "../src/app/components/MeetingAppLayout";
import SharedBrowserStage from "../src/app/components/SharedBrowserStage";
import type { Participant } from "../src/app/lib/types";

const remote = (userId: string, overrides: Partial<Participant> = {}): Participant => ({
  userId,
  videoStream: null,
  audioStream: null,
  screenShareStream: null,
  screenShareAudioStream: null,
  audioProducerId: null,
  videoProducerId: null,
  screenShareProducerId: null,
  screenShareAudioProducerId: null,
  isMuted: false,
  isCameraOff: true,
  isVideoAdaptivelyPaused: false,
  isHandRaised: false,
  ...overrides,
});

const names: Record<string, string> = {
  "alice#1": "Alice Host",
  "bob#2": "Bob Guest",
  "carol#3": "Carol Viewer",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("puts the shared browser on the stage with everyone in the rail", () => {
  const bobAudio = new MediaStream();
  const carolAudio = new MediaStream();
  const participants = new Map<string, Participant>([
    ["alice#1", remote("alice#1")],
    ["bob#2", remote("bob#2", { isMuted: true, audioStream: bobAudio })],
    ["carol#3", remote("carol#3", { audioStream: carolAudio })],
    ["shared-browser-video:room", remote("shared-browser-video:room")],
  ]);

  act(() => {
    root.render(
      <GameProvider socket={null}>
        <MeetingAppLayout
          stageId="shared-browser"
          localStream={null}
          isCameraOff
          isMuted={false}
          isHandRaised={false}
          participants={participants}
          userEmail="alice@example.com"
          isMirrorCamera
          activeSpeakerId={null}
          currentUserId="alice#1"
          getDisplayName={(userId) => names[userId] ?? userId}
        >
          <SharedBrowserStage
            noVncUrl="https://live-view.invalid/ui/view?mode=tab"
            controllerName="Alice Host"
            isLocalController
            provider="kitesurf"
          />
        </MeetingAppLayout>
      </GameProvider>,
    );
  });

  const stage = container.querySelector('[data-meet-stage-main="shared-browser"]');
  expect(stage?.textContent).toContain("You’re sharing a browser");
  expect(stage?.querySelector('[aria-label="Shared browser"]')).not.toBeNull();

  const rail = container.querySelector("[data-meet-stage-rail]");
  const tiles = Array.from(rail?.children ?? []);
  expect(tiles.map((tile) => tile.getAttribute("data-userid"))).toEqual([
    "alice#1",
    "bob#2",
    "carol#3",
  ]);
  expect(tiles[0]?.textContent).toContain("Alice Host");
  expect(tiles[0]?.textContent).toContain("You");
  expect(tiles[0]?.textContent).not.toContain("YouYou");
  expect(rail?.textContent).toContain("Bob Guest");
  expect(rail?.textContent).toContain("Carol Viewer");
  expect(rail?.textContent).not.toContain("shared-browser-video");

  const playing = Array.from(container.querySelectorAll("audio")).map(
    (audio) => audio.srcObject,
  );
  expect(playing).toContain(bobAudio);
  expect(playing).toContain(carolAudio);
});

const renderStage = (participants: Map<string, Participant>, activeSpeakerId: string | null = null) =>
  act(() => {
    root.render(
      <GameProvider socket={null}>
        <MeetingAppLayout
          stageId="shared-browser"
          localStream={null}
          isCameraOff
          isMuted={false}
          isHandRaised={false}
          participants={participants}
          userEmail="alice@example.com"
          isMirrorCamera
          activeSpeakerId={activeSpeakerId}
          currentUserId="alice#1"
          getDisplayName={(userId) => names[userId] ?? userId}
        >
          <div />
        </MeetingAppLayout>
      </GameProvider>,
    );
  });

const stageSize = (width: number, height: number) => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
};

const publishedHints = () =>
  (
    window as unknown as {
      __conclaveGetMeetRoomTilingDebug?: () => {
        current: {
          visibleRemoteIds: string[];
          primaryIds: string[];
          hiddenIds: string[];
          focusIds: string[];
        } | null;
      };
    }
  ).__conclaveGetMeetRoomTilingDebug?.().current;

it("tells the download policy which rail cameras the stage shows", () => {
  stageSize(1216, 664);
  renderStage(new Map([["bob#2", remote("bob#2")], ["carol#3", remote("carol#3")]]));

  expect(container.querySelector("[data-meet-stage-split]")?.getAttribute("data-meet-stage-split")).toBe("side");
  expect(publishedHints()).toMatchObject({
    visibleRemoteIds: ["bob#2", "carol#3"],
    primaryIds: ["local", "bob#2", "carol#3"],
    hiddenIds: [],
  });
});

it("reports every camera hidden when the stage has no room for the rail", () => {
  stageSize(216, 139);
  const bobAudio = new MediaStream();
  renderStage(
    new Map([["bob#2", remote("bob#2", { audioStream: bobAudio })], ["carol#3", remote("carol#3")]]),
  );

  expect(container.querySelector("[data-meet-stage-split]")?.getAttribute("data-meet-stage-split")).toBe("main-only");
  expect(container.querySelector("[data-meet-stage-rail]")).toBeNull();
  expect(container.querySelector(".acm-video-tile[data-userid]")).toBeNull();
  expect(publishedHints()).toMatchObject({
    visibleRemoteIds: [],
    primaryIds: [],
    hiddenIds: ["bob#2", "carol#3"],
  });
  expect(Array.from(container.querySelectorAll("audio")).map((audio) => audio.srcObject)).toContain(bobAudio);
});

it("stops publishing when the stage unmounts", () => {
  stageSize(1216, 664);
  renderStage(new Map([["bob#2", remote("bob#2")]]));
  expect(publishedHints()?.visibleRemoteIds).toEqual(["bob#2"]);

  act(() => root.render(null));
  expect(publishedHints()).toBeUndefined();
});

it("names a speaker as the focus only while the rail shows them", () => {
  stageSize(1216, 664);
  const participants = new Map([["bob#2", remote("bob#2")]]);
  renderStage(participants, "bob#2");
  expect(publishedHints()?.focusIds).toEqual(["bob#2"]);

  stageSize(216, 139);
  act(() => root.render(null));
  renderStage(participants, "bob#2");
  expect(publishedHints()).toMatchObject({ visibleRemoteIds: [], focusIds: [] });
});

it("reports only the cameras inside the rail's scroll window", () => {
  stageSize(1216, 164);
  let scrollTop = 0;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(164);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-meet-stage-rail")) return new DOMRect(0, 0, 240, 164);
    const rail = this.parentElement?.hasAttribute("data-meet-stage-rail") ? this.parentElement : null;
    if (!rail) return new DOMRect(0, 0, 0, 0);
    return new DOMRect(0, Array.from(rail.children).indexOf(this) * 124 - scrollTop, 240, 112);
  });
  const ids = ["bob#2", "carol#3", "dave#4", "erin#5"];
  renderStage(new Map(ids.map((id) => [id, remote(id)])));

  expect(container.querySelectorAll("[data-meet-stage-rail] > [data-userid]")).toHaveLength(5);
  expect(publishedHints()).toMatchObject({
    visibleRemoteIds: ["bob#2"],
    primaryIds: ["local", "bob#2"],
    hiddenIds: ["carol#3", "dave#4", "erin#5"],
  });

  scrollTop = 372;
  act(() => {
    container.querySelector("[data-meet-stage-rail]")!.dispatchEvent(new Event("scroll"));
  });
  expect(publishedHints()).toMatchObject({
    visibleRemoteIds: ["dave#4", "erin#5"],
    primaryIds: ["dave#4", "erin#5"],
    hiddenIds: ["bob#2", "carol#3"],
  });
});

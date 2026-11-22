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
});

it("puts the shared browser on the stage with everyone in the rail", () => {
  const participants = new Map<string, Participant>([
    ["alice#1", remote("alice#1")],
    ["bob#2", remote("bob#2", { isMuted: true })],
    ["carol#3", remote("carol#3")],
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
});

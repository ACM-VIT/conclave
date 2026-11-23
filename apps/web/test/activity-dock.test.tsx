// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ControlsBar from "../src/app/components/ControlsBar";
import type { ControlsBarProps } from "../src/app/components/controls-config";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const noop = () => {};
const baseProps: ControlsBarProps = {
  isMuted: true,
  isCameraOff: true,
  isScreenSharing: false,
  activeScreenShareId: null,
  isChatOpen: false,
  unreadCount: 0,
  isHandRaised: false,
  reactionOptions: [],
  onToggleMute: noop,
  onToggleCamera: noop,
  onToggleScreenShare: noop,
  onToggleChat: noop,
  onToggleHandRaised: noop,
  onSendReaction: noop,
  onLeave: noop,
  onToggleParticipants: noop,
  onToggleGames: noop,
  onToggleApps: noop,
  onToggleTranscript: noop,
};

const render = (props: Partial<ControlsBarProps>) =>
  act(async () => root.render(<ControlsBar {...baseProps} {...props} />));

const dockAnnouncement = () =>
  [...container.querySelectorAll('.sr-only[aria-live="polite"]')]
    .map((region) => region.textContent)
    .join("");
const dots = () =>
  [...container.querySelectorAll("span")].filter((span) =>
    /\bh-2\b/.test(span.className) && /\bw-2\b/.test(span.className) && /rounded-full/.test(span.className),
  );
const openFlyout = async () => {
  const face = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  await act(async () => face?.click());
  return [...container.querySelectorAll("[data-tray] button")].map((row) => row.textContent);
};

describe("activities dock", () => {
  it("names a live game, app and transcript in text instead of a dot", async () => {
    await render({ hasActiveGame: true, hasActiveApp: true, transcriptStatus: "live" });
    expect(dots()).toEqual([]);
    expect(await openFlyout()).toEqual(["Game in progress", "App in use", "Transcript on"]);
    expect(dots()).toEqual([]);
    expect(dockAnnouncement()).toBe("Game in progress. App in use. Transcript on");
  });

  it("puts a transcript that needs attention on the dock button and announces it", async () => {
    await render({ hasActiveApp: true, transcriptStatus: "error" });
    expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-label")).toBe(
      "Transcript needs attention",
    );
    expect(dockAnnouncement()).toBe("App in use. Transcript needs attention");
    expect(dots()).toEqual([]);
  });

  it("announces nothing while no activity is running", async () => {
    await render({});
    expect(dockAnnouncement()).toBe("");
    expect(await openFlyout()).toEqual(["Games", "Apps", "Transcript"]);
  });
});

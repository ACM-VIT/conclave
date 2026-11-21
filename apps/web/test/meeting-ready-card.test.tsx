// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GridLayout from "../src/app/components/GridLayout";
import MeetingReadyCard, {
  useMeetingReadyCard,
} from "../src/app/components/MeetingReadyCard";
import { DEFAULT_MEET_VIEW_SETTINGS } from "../src/app/lib/meet-view";
import type { Participant } from "../src/app/lib/types";

vi.mock("../src/app/components/games/GameTileOverlay", () => ({
  default: () => null,
}));

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) ===
      label,
  );

const click = async (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`No button labelled ${label}`);
  await act(async () => target.click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "share");
});

describe("MeetingReadyCard", () => {
  const renderCard = () =>
    act(async () =>
      root.render(
        <MeetingReadyCard
          roomId="abc-defg-hij"
          isHost
          isMobile={false}
          onDismiss={() => {}}
        />,
      ),
    );

  it("copies the full meeting link, not the bare code", async () => {
    await renderCard();

    expect(container.textContent).toContain(`${location.host}/abc-defg-hij`);
    await click("Copy meeting link");

    expect(writeText).toHaveBeenCalledWith(`${location.origin}/abc-defg-hij`);
    expect(button("Meeting link copied")).toBeDefined();
  });

  it("opens the system share sheet for Add others when the browser has one", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await renderCard();

    await click("Add others");

    expect(share).toHaveBeenCalledWith({
      title: "Join my Conclave meeting",
      url: `${location.origin}/abc-defg-hij`,
    });
    expect(container.textContent).toContain("Invite sent");
  });

  it("copies the invite when the share sheet is refused, but not when you cancel it", async () => {
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))
      .mockRejectedValueOnce(new DOMException("no share target", "NotAllowedError"));
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await renderCard();

    await click("Add others");
    expect(writeText).not.toHaveBeenCalled();

    await click("Add others");
    expect(writeText).toHaveBeenCalledWith(
      `Join my Conclave meeting: ${location.origin}/abc-defg-hij`,
    );
  });

  it("copies a ready-to-send invite for Add others without a share sheet", async () => {
    await renderCard();

    await click("Add others");

    expect(writeText).toHaveBeenCalledWith(
      `Join my Conclave meeting: ${location.origin}/abc-defg-hij`,
    );
    expect(container.textContent).toContain("Invite copied");
  });
});

describe("GridLayout meeting-ready card", () => {
  const peer: Participant = {
    userId: "peer",
    videoStream: null,
    audioStream: null,
    screenShareStream: null,
    screenShareAudioStream: null,
    audioProducerId: null,
    videoProducerId: null,
    screenShareProducerId: null,
    screenShareAudioProducerId: null,
    isMuted: true,
    isCameraOff: true,
    isVideoAdaptivelyPaused: false,
    isHandRaised: false,
  };

  function Stage({
    peers,
    showsGrid,
    roomId,
  }: {
    peers: Participant[];
    showsGrid: boolean;
    roomId: string;
  }) {
    const card = useMeetingReadyCard(roomId, peers.length > 0);
    if (!showsGrid) return <p>Whiteboard</p>;
    return (
      <GridLayout
        localStream={null}
        isCameraOff={false}
        isMuted
        isHandRaised={false}
        participants={new Map(peers.map((p) => [p.userId, p]))}
        userEmail="local"
        currentUserId="local"
        isMirrorCamera={false}
        activeSpeakerId={null}
        getDisplayName={(id) => id}
        viewSettings={{ ...DEFAULT_MEET_VIEW_SETTINGS, hideTilesWithoutVideo: false }}
        meetingReadyCard={
          card.isOpen ? (
            <MeetingReadyCard
              roomId={roomId}
              isHost
              isMobile={false}
              onDismiss={card.dismiss}
            />
          ) : null
        }
      />
    );
  }

  const renderStage = (
    peers: Participant[],
    { showsGrid = true, roomId = "abc-defg-hij" } = {},
  ) =>
    act(async () =>
      root.render(<Stage peers={peers} showsGrid={showsGrid} roomId={roomId} />),
    );

  const greets = () => container.textContent?.includes("Your meeting's ready");

  it("greets a solo host with the camera on", async () => {
    await renderStage([]);

    expect(greets()).toBe(true);
    expect(button("Add others")).toBeDefined();
  });

  it("goes away once someone joins and stays away after they leave", async () => {
    await renderStage([]);
    await renderStage([peer]);
    expect(greets()).toBe(false);

    await renderStage([]);
    expect(greets()).toBe(false);
  });

  it("stays dismissed after the stage switches to an app and back", async () => {
    await renderStage([]);
    await click("Dismiss");
    expect(greets()).toBe(false);

    await renderStage([], { showsGrid: false });
    await renderStage([]);

    expect(greets()).toBe(false);
  });

  it("stays away when a guest came and went while an app had the stage", async () => {
    await renderStage([]);
    await renderStage([], { showsGrid: false });
    await renderStage([peer], { showsGrid: false });
    await renderStage([], { showsGrid: false });

    await renderStage([]);

    expect(greets()).toBe(false);
  });

  it("greets you again in a new meeting", async () => {
    await renderStage([]);
    await click("Dismiss");

    await renderStage([], { roomId: "xyz-wxyz-xyz" });

    expect(greets()).toBe(true);
  });
});

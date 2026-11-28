// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GridLayout from "../src/app/components/GridLayout";
import MeetingInvite, {
  inviteFormFor,
  useMeetingInvite,
  type MeetingInvitePhase,
} from "../src/app/components/MeetingInvite";
import MeetingInfoTag from "../src/app/components/MeetingInfoTag";
import { DEFAULT_MEET_VIEW_SETTINGS } from "../src/app/lib/meet-view";
import type { Participant } from "../src/app/lib/types";

vi.mock("../src/app/components/games/GameTileOverlay", () => ({
  default: () => null,
}));

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;
let gridSize = { width: 1312, height: 752 };

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

const announced = () =>
  container.querySelector("[data-meeting-invite] [role=status]")?.textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  gridSize = { width: 1312, height: 752 };
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-meet-view-layout")
        ? new DOMRect(0, 0, gridSize.width, gridSize.height)
        : measure.call(this);
    },
  );
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "share");
});

describe("MeetingInvite", () => {
  const renderInvite = ({
    roomId = "abc-defg-hij",
    clientId,
    phase = "empty",
    isMobile = false,
  }: {
    roomId?: string;
    clientId?: string;
    phase?: MeetingInvitePhase;
    isMobile?: boolean;
  } = {}) =>
    act(async () =>
      root.render(
        <MeetingInvite
          phase={phase}
          form={inviteFormFor(phase)}
          roomId={roomId}
          clientId={clientId}
          isMobile={isMobile}
          onDismiss={() => {}}
        />,
      ),
    );

  it("shows a clean address but copies the whole link and announces it", async () => {
    await renderInvite();

    expect(container.textContent).toContain("No one else is here yet");
    expect(container.textContent).toContain(`${location.host}/abc-defg-hij`);
    expect(container.textContent).not.toContain("clientId");
    await click("Copy link");

    expect(writeText).toHaveBeenCalledWith(
      `${location.origin}/abc-defg-hij?clientId=conclave`,
    );
    expect(button("Copied")).toBeDefined();
    expect(announced()).toBe("Meeting link copied");
  });

  it("keeps a non-default client ID in the copied link", async () => {
    await renderInvite({ clientId: "acme" });

    await click("Copy link");

    expect(writeText).toHaveBeenCalledWith(
      `${location.origin}/abc-defg-hij?clientId=acme`,
    );
  });

  it("says so when the clipboard refuses the link", async () => {
    writeText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await renderInvite();

    await click("Copy link");

    expect(button("Couldn't copy")).toBeDefined();
    expect(announced()).toBe("Couldn't copy the meeting link");
  });

  it("offers one Copy link action on desktop even when the browser can share", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn() });
    await renderInvite();

    expect(button("Share invite")).toBeUndefined();
    expect(button("Copy link")).toBeDefined();
  });

  it("opens the share sheet on touch and copies only when sharing fails", async () => {
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))
      .mockRejectedValueOnce(new DOMException("no target", "NotAllowedError"));
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await renderInvite({ isMobile: true });

    await click("Share invite");
    expect(share).toHaveBeenCalledWith({
      title: "Join my Conclave meeting",
      url: `${location.origin}/abc-defg-hij?clientId=conclave`,
    });
    expect(writeText).not.toHaveBeenCalled();

    await click("Share invite");
    expect(writeText).toHaveBeenCalledWith(
      `${location.origin}/abc-defg-hij?clientId=conclave`,
    );
    expect(button("Meeting link copied")).toBeDefined();
  });

  it("never builds a link for a room the address bar cannot open", async () => {
    await renderInvite({ roomId: "Team-Room" });

    expect(container.textContent).toContain("This room has no shareable link.");
    expect(button("Copy link")).toBeUndefined();
    expect(container.textContent).not.toContain("Team-Room");
  });

  it("tells you everyone left in the quiet notice", async () => {
    await renderInvite({ phase: "emptied" });

    expect(container.textContent).toContain("Everyone else left");
    expect(container.textContent).not.toContain("Share this link");
    await click("Copy link");
    expect(writeText).toHaveBeenCalledWith(
      `${location.origin}/abc-defg-hij?clientId=conclave`,
    );
  });
});

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
  isMobile,
}: {
  peers: Participant[];
  showsGrid: boolean;
  roomId: string;
  isMobile: boolean;
}) {
  const invite = useMeetingInvite(roomId, peers.length > 0);
  const phase = showsGrid ? invite.phase : null;
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
      isMobile={isMobile}
      soloInvite={
        phase
          ? {
              form: inviteFormFor(phase),
              render: ({ form }) => (
                <MeetingInvite
                  phase={phase}
                  form={form}
                  roomId={roomId}
                  isMobile={isMobile}
                  onDismiss={invite.dismiss}
                />
              ),
            }
          : null
      }
    />
  );
}

const renderStage = (
  peers: Participant[],
  { showsGrid = true, roomId = "abc-defg-hij", isMobile = false } = {},
) =>
  act(async () =>
    root.render(
      <Stage peers={peers} showsGrid={showsGrid} roomId={roomId} isMobile={isMobile} />,
    ),
  );

const slot = () =>
  container.querySelector<HTMLElement>("[data-meet-solo-invite]");
const slotText = () => slot()?.textContent ?? "";

const rectOf = (element: HTMLElement) => ({
  x: parseFloat(element.style.left),
  y: parseFloat(element.style.top),
  width: parseFloat(element.style.width),
  height: parseFloat(element.style.height),
});

const localTileRect = () => {
  const tiles = Array.from(
    container.querySelectorAll<HTMLElement>("[data-meet-view-layout] > div.absolute"),
  ).filter((element) => !element.hasAttribute("data-meet-solo-invite"));
  expect(tiles).toHaveLength(1);
  return rectOf(tiles[0]);
};

const overlaps = (
  a: ReturnType<typeof rectOf>,
  b: ReturnType<typeof rectOf>,
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

describe("Solo invite lifecycle", () => {
  it("invites you on the stage while no one else has joined", async () => {
    await renderStage([]);

    expect(slotText()).toContain("No one else is here yet");
    expect(button("Copy link")).toBeDefined();
  });

  it("leaves when someone joins and returns as a quiet notice when they go", async () => {
    await renderStage([]);
    await renderStage([peer]);
    expect(slot()).toBeNull();

    await renderStage([]);

    expect(slot()?.getAttribute("data-meet-solo-invite")).toBe("above");
    expect(slotText()).toContain("Everyone else left");
    expect(slotText()).not.toContain("No one else is here yet");
  });

  it("never comes back after you dismiss it", async () => {
    await renderStage([]);
    await click("Dismiss invite");
    expect(slot()).toBeNull();

    await renderStage([], { showsGrid: false });
    await renderStage([]);
    expect(slot()).toBeNull();

    await renderStage([peer]);
    await renderStage([]);
    expect(slot()).toBeNull();
  });

  it("stays dismissed once you close the everyone-left notice", async () => {
    await renderStage([]);
    await renderStage([peer]);
    await renderStage([]);
    await click("Dismiss invite");

    await renderStage([peer]);
    await renderStage([]);

    expect(slot()).toBeNull();
  });

  it("remembers that someone came while an app had the stage", async () => {
    await renderStage([]);
    await renderStage([], { showsGrid: false });
    await renderStage([peer], { showsGrid: false });
    await renderStage([], { showsGrid: false });

    await renderStage([]);

    expect(slotText()).toContain("Everyone else left");
  });

  it("starts fresh in a new meeting", async () => {
    await renderStage([]);
    await click("Dismiss invite");

    await renderStage([], { roomId: "xyz-wxyz-xyz" });

    expect(slotText()).toContain("No one else is here yet");
  });
});

describe("Solo invite placement", () => {
  const centerX = (rect: ReturnType<typeof rectOf>) => rect.x + rect.width / 2;
  const showsAddressField = () => slotText().includes(`${location.host}/abc-defg-hij`);

  it("centres the self tile on a desktop stage with a one-row invite right under it", async () => {
    await renderStage([]);

    const invite = rectOf(slot()!);
    const tile = localTileRect();
    expect(slot()?.getAttribute("data-meet-solo-invite")).toBe("below");
    expect(overlaps(invite, tile)).toBe(false);
    expect(centerX(tile)).toBeCloseTo(gridSize.width / 2, 0);
    expect(centerX(invite)).toBeCloseTo(centerX(tile), 0);
    expect(invite.y).toBe(tile.y + tile.height + 12);
    expect(invite.height).toBe(44);
    expect(invite.y + invite.height).toBeLessThanOrEqual(gridSize.height);
    expect(slotText()).toContain("No one else is here yet");
    expect(showsAddressField()).toBe(false);

    await click("Copy link");
    expect(writeText).toHaveBeenCalledWith(
      `${location.origin}/abc-defg-hij?clientId=conclave`,
    );
    expect(button("Copied")).toBeDefined();
  });

  it("keeps the full invite panel stacked under the self tile on a phone", async () => {
    gridSize = { width: 390, height: 700 };
    await renderStage([], { isMobile: true });

    const invite = rectOf(slot()!);
    const tile = localTileRect();
    expect(slot()?.getAttribute("data-meet-solo-invite")).toBe("below");
    expect(invite.height).toBe(184);
    expect(showsAddressField()).toBe(true);
    expect(button("Copy link")).toBeDefined();
    expect(overlaps(invite, tile)).toBe(false);
    expect(invite.y).toBeGreaterThanOrEqual(tile.y + tile.height);
    expect(invite.y + invite.height).toBeLessThanOrEqual(gridSize.height);
  });

  it.each([
    { width: 767, fullPanel: true, height: 184 },
    { width: 768, fullPanel: false, height: 44 },
  ])(
    "uses the full panel below the 768px breakpoint and one row from it ($width px)",
    async ({ width, fullPanel, height }) => {
      gridSize = { width, height: 700 };
      await renderStage([]);

      expect(showsAddressField()).toBe(fullPanel);
      expect(rectOf(slot()!).height).toBe(height);
      expect(overlaps(rectOf(slot()!), localTileRect())).toBe(false);
    },
  );

  it("shrinks to the one-row notice above the tile on a short stage", async () => {
    gridSize = { width: 1280, height: 230 };
    await renderStage([]);

    const invite = rectOf(slot()!);
    const tile = localTileRect();
    expect(slot()?.getAttribute("data-meet-solo-invite")).toBe("above");
    expect(slotText()).toContain("No one else is here yet");
    expect(button("Copy link")).toBeDefined();
    expect(overlaps(invite, tile)).toBe(false);
  });

  it("keeps the everyone-left notice above the tile without covering it", async () => {
    await renderStage([]);
    await renderStage([peer]);
    await renderStage([]);

    const notice = rectOf(slot()!);
    const tile = localTileRect();
    expect(slot()?.getAttribute("data-meet-solo-invite")).toBe("above");
    expect(overlaps(notice, tile)).toBe(false);
    expect(notice.y + notice.height).toBeLessThanOrEqual(tile.y);
  });

  it("leaves a stage too short for the notice to the tile alone", async () => {
    gridSize = { width: 1280, height: 150 };
    await renderStage([]);

    expect(slot()).toBeNull();
    expect(localTileRect().height).toBeGreaterThan(0);
  });

  it("centres the one-row invite under the pinned self view without covering it", async () => {
    await renderStage([]);
    await click("Pin to spotlight");

    const stage = container.querySelector<HTMLElement>("[data-meet-stage-split]");
    expect(stage).not.toBeNull();
    const pinned = rectOf(stage!);
    const invite = rectOf(slot()!);
    expect(slot()?.getAttribute("data-meet-solo-invite")).toBe("below");
    expect(overlaps(invite, pinned)).toBe(false);
    expect(centerX(invite)).toBeCloseTo(centerX(pinned), 0);
    expect(invite.y).toBe(pinned.y + pinned.height + 12);
    expect(invite.height).toBe(44);
  });

  it("gives the whole stage back to the tile after you dismiss it", async () => {
    await renderStage([]);
    const withInvite = localTileRect();

    await click("Dismiss invite");

    expect(slot()).toBeNull();
    expect(localTileRect().height).toBeGreaterThan(withInvite.height);
  });
});

describe("Solo invite and who counts as company", () => {
  const cameraOff = (userId: string): Participant => ({ ...peer, userId });

  const renderGrid = (userIds: string[], hideTilesWithoutVideo: boolean) =>
    act(async () =>
      root.render(
        <GridLayout
          localStream={null}
          isCameraOff
          isMuted
          isHandRaised={false}
          participants={new Map(userIds.map((id) => [id, cameraOff(id)]))}
          userEmail="local"
          currentUserId="local"
          isMirrorCamera={false}
          activeSpeakerId={null}
          getDisplayName={(id) => id}
          viewSettings={{ ...DEFAULT_MEET_VIEW_SETTINGS, hideTilesWithoutVideo }}
          soloInvite={{ form: "panel", render: () => <p>Invite people</p> }}
        />,
      ),
    );

  it.each([true, false])(
    "keeps a camera-off peer as company with the filter set to %s",
    async (hideTilesWithoutVideo) => {
      await renderGrid(["peer"], hideTilesWithoutVideo);

      expect(slot()).toBeNull();
    },
  );

  it("does not count self or shared-browser system streams as other people", async () => {
    await renderGrid(["local", "shared-browser:audio", "shared-browser-video:video"], true);

    expect(slotText()).toBe("Invite people");
  });
});

describe("Toolbar copy hint", () => {
  const hintShown = () => container.textContent?.includes("to copy link") ?? false;

  const renderTag = (quietHint: boolean) =>
    act(async () =>
      root.render(<MeetingInfoTag roomId="abc-defg-hij" quietHint={quietHint} />),
    );

  it("stays quiet while the invite explains the link, and keeps the copy action", async () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
      await renderTag(true);
      await act(async () => vi.advanceTimersByTime(3000));

      expect(hintShown()).toBe(false);
      expect(button("Copy meeting link for abc-defg-hij")).toBeDefined();

      await renderTag(false);
      await act(async () => vi.advanceTimersByTime(3000));

      expect(hintShown()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

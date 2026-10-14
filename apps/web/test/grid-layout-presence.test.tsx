import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GridLayout from "../src/app/components/GridLayout";
import { DEFAULT_MEET_VIEW_SETTINGS } from "../src/app/lib/meet-view";
import type { Participant } from "../src/app/lib/types";

vi.mock("../src/app/components/games/GameTileOverlay", () => ({
  default: () => null,
}));

const cameraOffParticipant = (userId: string): Participant => ({
  userId,
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
});

function renderGrid(
  userIds: string[],
  hideTilesWithoutVideo = true,
  isMobile = false,
) {
  return renderToStaticMarkup(
    <GridLayout
      localStream={null}
      isCameraOff
      isMuted
      isHandRaised={false}
      participants={new Map(userIds.map((id) => [id, cameraOffParticipant(id)]))}
      userEmail="local"
      currentUserId="local"
      isMirrorCamera={false}
      activeSpeakerId={null}
      getDisplayName={(id) => id}
      viewSettings={{ ...DEFAULT_MEET_VIEW_SETTINGS, hideTilesWithoutVideo }}
      isMobile={isMobile}
    />,
  );
}

describe("GridLayout meeting presence", () => {
  it.each([1, 35])(
    "does not show a solo invite when %i camera-off peers are hidden",
    (count) => {
      const html = renderGrid(Array.from({ length: count }, (_, i) => `peer-${i}`));

      expect(html).toContain('data-meet-view-ordered-count="0"');
      expect(html).not.toContain("You are the only one here");
      expect(html).not.toContain("Invite people");
    },
  );

  it("does not show the mobile solo invite when peers are hidden", () => {
    expect(renderGrid(["peer"], true, true)).not.toContain("Invite people");
  });

  it("does not show a solo invite when camera-off peers are visible", () => {
    const html = renderGrid(["peer"], false);

    expect(html).toContain('data-meet-view-ordered-count="1"');
    expect(html).not.toContain("You are the only one here");
  });

  it.each([true, false])(
    "keeps the solo invite when alone with the filter set to %s",
    (hideTilesWithoutVideo) => {
      expect(renderGrid([], hideTilesWithoutVideo)).toContain(
        "You are the only one here",
      );
    },
  );

  it("does not count self or shared-browser system streams as other people", () => {
    expect(
      renderGrid(["local", "shared-browser:audio", "shared-browser-video:video"]),
    ).toContain("You are the only one here");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GridLayout from "../src/app/components/GridLayout";
import {
  DEFAULT_MEET_VIEW_SETTINGS,
  type MeetSelfViewMode,
} from "../src/app/lib/meet-view";
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

describe("GridLayout meeting presence", () => {
  it.each<[MeetSelfViewMode, boolean]>([
    ["auto", false],
    ["floating", false],
    ["minimized", false],
    ["tile", true],
  ])(
    "in a two-person sidebar with the self view %s, renders the rail only when it has tiles",
    (selfViewMode, expectsRail) => {
      const html = renderToStaticMarkup(
        <GridLayout
          localStream={null}
          isCameraOff
          isMuted
          isHandRaised={false}
          participants={new Map([["peer", cameraOffParticipant("peer")]])}
          userEmail="local"
          currentUserId="local"
          isMirrorCamera={false}
          activeSpeakerId={null}
          getDisplayName={(id) => id}
          viewSettings={{
            ...DEFAULT_MEET_VIEW_SETTINGS,
            mode: "sidebar",
            hideTilesWithoutVideo: false,
            selfViewMode,
          }}
          isMobile={false}
        />,
      );

      expect(html).toContain('data-meet-stage-main="peer"');
      expect(html.includes("data-meet-stage-rail")).toBe(expectsRail);
    },
  );
});

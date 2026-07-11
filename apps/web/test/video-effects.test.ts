import { describe, expect, it } from "vitest";
import {
  BACKGROUND_EFFECTS,
  DEFAULT_VIDEO_EFFECTS,
  normalizeVideoEffectsState,
} from "../src/app/lib/video-effects";

const RETIRED_BACKGROUND_EFFECT_IDS = [
  "desk-motion",
  "loft-motion",
  "aurora-motion",
  "home-office-living-room",
  "home-office-sofa",
  "lounge",
  "living-room-close",
  "living-room-shelf",
  "office-break-room",
  "office-meeting-space",
  "stylish-home-office",
  "stylish-living-room-couch",
  "cyberpunk-penthouse",
  "tropical-beach",
  "gaming-room",
  "rainy-conservatory",
  "rainy-cafe",
  "sunny-cafe",
  "rustic-cabin",
  "snowy-chalet",
  "underwater-sea-lab",
  "space-station",
  "japanese-courtyard",
  "parisian-skyline",
  "greenhouse",
  "italian-terrace-countryside",
  "physics-lab",
  "lakeside-tent",
  "gradient",
] as const;

describe("video effect backgrounds", () => {
  it.each(RETIRED_BACKGROUND_EFFECT_IDS)(
    "normalizes the retired %s background to none",
    (background) => {
      expect(
        normalizeVideoEffectsState({
          ...DEFAULT_VIDEO_EFFECTS,
          background,
        }).background,
      ).toBe("none");
    },
  );

  it("accepts every exposed background option", () => {
    for (const option of BACKGROUND_EFFECTS) {
      const normalized = normalizeVideoEffectsState({
        ...DEFAULT_VIDEO_EFFECTS,
        background: option.id,
        customBackgroundDataUrl:
          option.id === "custom" ? "data:image/png;base64,AA==" : null,
      });

      expect(normalized.background).toBe(option.id);
    }
  });
});

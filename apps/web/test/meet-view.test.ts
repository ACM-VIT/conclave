import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEET_VIEW_SETTINGS,
  normalizeMeetViewSettings,
} from "../src/app/lib/meet-view";

describe("normalizeMeetViewSettings", () => {
  it("defaults old saved settings to video mode", () => {
    expect(normalizeMeetViewSettings({}).audioOnlyMode).toBe(false);
  });

  it("preserves audio-only participant intent", () => {
    expect(
      normalizeMeetViewSettings({
        ...DEFAULT_MEET_VIEW_SETTINGS,
        audioOnlyMode: true,
      }).audioOnlyMode,
    ).toBe(true);
  });
});

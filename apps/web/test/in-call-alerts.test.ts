import { expect, it } from "vitest";
import { deriveInCallAlerts } from "../src/app/lib/in-call-alerts";
import type { MediaPathHealth } from "../src/app/lib/media-path-recovery";

const receiveBlocked: MediaPathHealth = { producer: "healthy", consumer: "blocked" };

it("keeps the blocked warning after an unmute clears the error", () => {
  expect(deriveInCallAlerts({ meetError: null, mediaPathHealth: receiveBlocked })).toEqual({
    mediaBlocked: true,
    error: null,
  });
});

it("keeps the blocked warning next to an error from a device change", () => {
  const mediaError = { code: "MEDIA_ERROR" as const, message: "Camera is in use.", recoverable: true };

  expect(
    deriveInCallAlerts({ meetError: mediaError, mediaPathHealth: receiveBlocked }),
  ).toEqual({ mediaBlocked: true, error: mediaError });
});

it("shows no blocked warning while both directions are healthy or recovering", () => {
  expect(
    deriveInCallAlerts({
      meetError: null,
      mediaPathHealth: { producer: "recovering", consumer: "healthy" },
    }).mediaBlocked,
  ).toBe(false);
});

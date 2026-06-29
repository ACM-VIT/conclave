import { describe, expect, it } from "vitest";
import {
  canRefreshTranscriptMinutes,
  canStopTranscriptSession,
  resolveTranscriptStartPermission,
  shouldRequestControllerHandoff,
} from "../transcript-worker/src/session-policy";

describe("resolveTranscriptStartPermission", () => {
  it("blocks normal start while a live session is controlled", () => {
    expect(
      resolveTranscriptStartPermission({
        canStart: true,
        canTakeover: true,
        controllerUserId: "controller",
        existingStatus: "live",
        isTakeover: false,
        viewerUserId: "viewer",
      }),
    ).toEqual({ ok: false, message: "Transcript is already running." });
  });

  it("blocks takeover from another user while the controller is healthy", () => {
    expect(
      resolveTranscriptStartPermission({
        canStart: true,
        canTakeover: true,
        controllerUserId: "controller",
        existingStatus: "live",
        isTakeover: true,
        viewerUserId: "viewer",
      }),
    ).toEqual({ ok: false, message: "Transcript is already controlled." });
  });

  it("allows takeover when the session needs handoff", () => {
    expect(
      resolveTranscriptStartPermission({
        canStart: true,
        canTakeover: true,
        controllerUserId: "controller",
        existingStatus: "takeover_needed",
        isTakeover: true,
        viewerUserId: "viewer",
      }),
    ).toEqual({ ok: true });
  });
});

describe("canStopTranscriptSession", () => {
  it("allows the controller or an elevated participant to stop", () => {
    expect(
      canStopTranscriptSession({
        controllerUserId: "controller",
        viewerCanStop: false,
        viewerUserId: "controller",
      }),
    ).toBe(true);
    expect(
      canStopTranscriptSession({
        controllerUserId: "controller",
        viewerCanStop: true,
        viewerUserId: "host",
      }),
    ).toBe(true);
  });

  it("blocks ordinary non-controller participants", () => {
    expect(
      canStopTranscriptSession({
        controllerUserId: "controller",
        viewerCanStop: false,
        viewerUserId: "viewer",
      }),
    ).toBe(false);
  });
});

describe("canRefreshTranscriptMinutes", () => {
  it("uses the ask capability for model-backed shared minutes refreshes", () => {
    expect(canRefreshTranscriptMinutes({ viewerCanAsk: true })).toBe(true);
    expect(canRefreshTranscriptMinutes({ viewerCanAsk: false })).toBe(false);
  });
});

describe("shouldRequestControllerHandoff", () => {
  it("requests handoff when the active controller connection closes", () => {
    expect(
      shouldRequestControllerHandoff({
        closingConnectionId: "conn-a",
        closingUserId: "controller",
        controllerConnectionId: "conn-a",
        controllerUserId: "controller",
        remainingUserIds: ["controller", "viewer"],
      }),
    ).toBe(true);
  });

  it("keeps the session controlled when a non-controller connection closes", () => {
    expect(
      shouldRequestControllerHandoff({
        closingConnectionId: "conn-b",
        closingUserId: "controller",
        controllerConnectionId: "conn-a",
        controllerUserId: "controller",
        remainingUserIds: ["controller", "viewer"],
      }),
    ).toBe(false);
  });

  it("keeps legacy sessions controlled while another tab for the controller remains", () => {
    expect(
      shouldRequestControllerHandoff({
        closingUserId: "controller",
        controllerUserId: "controller",
        remainingUserIds: ["controller", "viewer"],
      }),
    ).toBe(false);
  });

  it("requests handoff for legacy sessions when the last controller connection closes", () => {
    expect(
      shouldRequestControllerHandoff({
        closingUserId: "controller",
        controllerUserId: "controller",
        remainingUserIds: ["viewer"],
      }),
    ).toBe(true);
  });
});

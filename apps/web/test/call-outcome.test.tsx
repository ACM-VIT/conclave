// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MeetingOutcomeScreen from "../src/app/components/MeetingOutcomeScreen";
import {
  reconnectEndedCall,
  type CallOutcome,
  type CallOutcomeKind,
} from "../src/app/lib/call-outcome";

let container: HTMLDivElement;
let root: Root;

const outcome = (
  kind: CallOutcomeKind,
  detail: string | null = null,
): CallOutcome => ({
  kind,
  roomId: "abc-defg-hij",
  detail,
  rejoinMedia: { isMicOn: true, isCameraOn: true, isAudioOnly: false },
  durationMs: 61_000,
});

const buttons = () =>
  Array.from(container.querySelectorAll("button")).map(
    (button) => button.getAttribute("aria-label") ?? button.textContent,
  );

async function render(value: CallOutcome) {
  const onRejoin = vi.fn();
  const onReturnHome = vi.fn();
  const onRate = vi.fn();
  await act(async () =>
    root.render(
      <MeetingOutcomeScreen
        outcome={value}
        onRejoin={onRejoin}
        onReturnHome={onReturnHome}
        onRate={onRate}
      />,
    ),
  );
  return { onRejoin, onReturnHome, onRate };
}

const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent) === label,
  );
  if (!button) throw new Error(`No button labelled ${label}`);
  await act(async () => button.click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  window.sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("MeetingOutcomeScreen", () => {
  it("offers Rejoin, home and a rating after you leave", async () => {
    const { onRejoin, onReturnHome } = await render(outcome("left"));

    expect(container.querySelector("h1")?.textContent).toBe(
      "You left the meeting",
    );
    expect(document.activeElement).toBe(container.querySelector("h1"));
    expect(container.textContent).toContain("How was the audio and video?");
    await click("Rejoin");
    await click("Return to home screen");
    expect(onRejoin).toHaveBeenCalledTimes(1);
    expect(onReturnHome).toHaveBeenCalledTimes(1);
  });

  it("asks you to rejoin first after a lost connection", async () => {
    await render(outcome("connectionLost"));

    expect(container.textContent).toContain("Check your connection, then rejoin.");
    expect(buttons().slice(0, 2)).toEqual(["Rejoin", "Return to home screen"]);
  });

  it.each<[CallOutcomeKind, string]>([
    ["endedByHost", "The host ended the meeting"],
    ["endedByYou", "You ended the meeting"],
    ["removed", "You were removed from the meeting"],
  ])("does not offer Rejoin when %s", async (kind, title) => {
    await render(outcome(kind));

    expect(container.querySelector("h1")?.textContent).toBe(title);
    expect(buttons()).not.toContain("Rejoin");
    expect(buttons()).toContain("Return to home screen");
  });

  it("shows the host's own message and skips the rating when removed", async () => {
    await render(outcome("removed", "Please rejoin from the lobby link"));

    expect(container.textContent).toContain("Please rejoin from the lobby link");
    expect(container.textContent).not.toContain("How was the audio and video?");
  });

  it("records one rating and thanks you", async () => {
    const { onRate } = await render(outcome("left"));

    await click("4 of 5, Good");
    await click("1 of 5, Very bad");

    expect(onRate).toHaveBeenCalledTimes(1);
    expect(onRate).toHaveBeenCalledWith(4);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Thanks for the feedback.",
    );
  });
});

describe("a lost connection", () => {
  const lost = {
    phase: "failed",
    connectionState: "error",
    wasInCall: true,
    showsOutcome: true,
    recoverable: true,
  } as const;

  it("ends the call only once reconnecting has given up on a lost connection, for someone who was in it", () => {
    expect(reconnectEndedCall(lost)).toBe(true);
    expect(reconnectEndedCall({ ...lost, phase: "waiting", connectionState: "reconnecting" })).toBe(false);
    expect(reconnectEndedCall({ ...lost, connectionState: "reconnecting" })).toBe(false);
    expect(reconnectEndedCall({ ...lost, wasInCall: false })).toBe(false);
    expect(reconnectEndedCall({ ...lost, phase: undefined })).toBe(false);
  });

  it("leaves a webinar viewer's page and a permanent refusal showing their own message", () => {
    expect(reconnectEndedCall({ ...lost, showsOutcome: false })).toBe(false);
    expect(reconnectEndedCall({ ...lost, recoverable: false })).toBe(false);
    expect(reconnectEndedCall({ ...lost, recoverable: undefined })).toBe(false);
  });
});

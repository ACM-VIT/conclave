// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GameProvider } from "@conclave/apps-sdk";
import MeetingAppLayout from "../src/app/components/MeetingAppLayout";

let root: Root;
let container: HTMLDivElement;

const renderLayout = async (props: { syncFailed?: boolean; onRetrySync?: () => void; rejectedChanges?: number }) => {
  await act(async () =>
    root.render(
      <GameProvider socket={null}>
        <MeetingAppLayout
          app={() => <div>board</div>}
          localStream={null}
          isCameraOff
          isMuted
          isHandRaised={false}
          participants={new Map()}
          userEmail=""
          isMirrorCamera={false}
          activeSpeakerId={null}
          currentUserId="me"
          getDisplayName={() => "Me"}
          {...props}
        />
      </GameProvider>,
    ),
  );
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("tells the participant the app could not load and lets them retry", async () => {
  const onRetrySync = vi.fn();
  await renderLayout({ syncFailed: true, onRetrySync });

  expect(container.querySelector('[role="status"]')?.textContent).toContain("Couldn't load this app");
  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
  await act(async () => retry!.click());

  expect(onRetrySync).toHaveBeenCalledTimes(1);
});

it("shows no notice while the app loads normally", async () => {
  await renderLayout({});

  expect(container.textContent).toContain("board");
  expect(container.textContent).not.toContain("Couldn't load this app");
});

it("says the last change couldn't be saved for a few seconds", async () => {
  vi.useFakeTimers();
  try {
    await renderLayout({ rejectedChanges: 0 });
    expect(container.textContent).not.toContain("Your last change couldn't be saved");

    await renderLayout({ rejectedChanges: 1 });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Your last change couldn't be saved");

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(container.textContent).not.toContain("Your last change couldn't be saved");
  } finally {
    vi.useRealTimers();
  }
});

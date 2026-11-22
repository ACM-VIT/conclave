// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GameProvider } from "@conclave/apps-sdk";
import MeetingAppLayout from "../src/app/components/MeetingAppLayout";

let root: Root;
let container: HTMLDivElement;

const renderLayout = async (props: { syncFailed?: boolean; onRetrySync?: () => void }) => {
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

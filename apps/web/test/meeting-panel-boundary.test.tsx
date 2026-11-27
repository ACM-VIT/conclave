// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import MeetingPanelBoundary, {
  meetingPanelKey,
} from "../src/app/components/MeetingPanelBoundary";

function FailedPanel(): never {
  throw new Error("Panel chunk failed to load");
}

it.each([
  ["Developer tools", false],
  ["Chat", true],
] as const)("dismisses the %s error without leaving the call", async (name, hasCloseHandler) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container, { onCaughtError: () => {} });
  const close = vi.fn();

  function Meeting() {
    const [open, setOpen] = useState(true);
    const closePanel = () => {
      close();
      setOpen(false);
    };
    return (
      <>
        <button type="button">Leave call</button>
        {open && (
          <MeetingPanelBoundary
            name={name}
            onClose={hasCloseHandler ? closePanel : undefined}
          >
            <FailedPanel />
          </MeetingPanelBoundary>
        )}
      </>
    );
  }

  try {
    await act(async () => root.render(<Meeting />));
    const panel = container.querySelector(`aside[aria-label="${name}"]`);
    expect(panel?.querySelector('[role="alert"]')).not.toBeNull();
    const closeButton = panel?.querySelector("button");
    expect(closeButton?.textContent?.trim()).toBe("Close panel");
    await act(async () => closeButton?.click());
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector("button")?.textContent).toBe("Leave call");
    expect(close).toHaveBeenCalledTimes(hasCloseHandler ? 1 : 0);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("renders Transcript when switching directly from a failed Chat panel", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container, { onCaughtError: () => {} });

  function Panels({ active }: { active: "chat" | "transcript" }) {
    return (
      <>
        {active === "chat" && (
          <MeetingPanelBoundary
            name="Chat"
            key={meetingPanelKey("chat", "user", "room")}
          >
            <FailedPanel />
          </MeetingPanelBoundary>
        )}
        {active === "transcript" && (
          <MeetingPanelBoundary
            name="Transcript"
            key={meetingPanelKey("transcript", "user", "room")}
          >
            <h2>Live transcript</h2>
          </MeetingPanelBoundary>
        )}
      </>
    );
  }

  try {
    await act(async () => root.render(<Panels active="chat" />));
    expect(container.querySelector('aside[aria-label="Chat"] [role="alert"]')).not.toBeNull();
    await act(async () => root.render(<Panels active="transcript" />));
    expect(container.querySelector("h2")?.textContent).toBe("Live transcript");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("tells its owner when the panel fails, once, so a camera preview never outlives it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container, { onCaughtError: () => {} });
  const failed = vi.fn();
  let crash: (() => void) | null = null;

  function PreviewPanel() {
    const [broken, setBroken] = useState(false);
    crash = () => setBroken(true);
    if (broken) throw new Error("Effects panel crashed");
    return <p>Camera preview</p>;
  }

  try {
    await act(async () =>
      root.render(
        <MeetingPanelBoundary name="Backgrounds and effects" onFailed={failed}>
          <PreviewPanel />
        </MeetingPanelBoundary>,
      ),
    );
    expect(container.textContent).toContain("Camera preview");
    expect(failed).not.toHaveBeenCalled();

    await act(async () => crash?.());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(failed).toHaveBeenCalledTimes(1);

    await act(async () =>
      root.render(
        <MeetingPanelBoundary name="Backgrounds and effects" onFailed={failed}>
          <PreviewPanel />
        </MeetingPanelBoundary>,
      ),
    );
    expect(failed).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

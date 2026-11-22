// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import MeetingPanelBoundary from "../src/app/components/MeetingPanelBoundary";

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

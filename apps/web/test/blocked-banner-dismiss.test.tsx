// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MeetsErrorBanner from "../src/app/components/MeetsErrorBanner";
import type { MeetError } from "../src/app/lib/types";

const BLOCKED: MeetError = {
  code: "NETWORK_BLOCKED",
  message: "Your network is blocking audio and video.",
  recoverable: true,
};

let container: HTMLDivElement;
let root: Root;

function InCallBanner({ initial, onRetry }: { initial: MeetError; onRetry: () => void }) {
  const [meetError, setMeetError] = useState<MeetError | null>(initial);
  return meetError ? (
    <MeetsErrorBanner
      meetError={meetError}
      onDismiss={() => setMeetError(null)}
      primaryActionLabel="Try again"
      onPrimaryAction={onRetry}
    />
  ) : null;
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps Try again reachable after the blocked-network warning is dismissed", async () => {
  const onRetry = vi.fn();
  await act(async () => root.render(<InCallBanner initial={BLOCKED} onRetry={onRetry} />));

  await act(async () => button("Dismiss error")?.click());

  expect(container.textContent).toContain(BLOCKED.message);
  expect(container.textContent).not.toContain("Try another network");
  expect(button("Dismiss error")).toBeUndefined();
  await act(async () => button("Try again")?.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("still removes an error that has no retry of its own", async () => {
  const mediaError: MeetError = {
    code: "MEDIA_ERROR",
    message: "Camera is in use.",
    recoverable: true,
  };
  await act(async () =>
    root.render(
      <InCallBanner initial={mediaError} onRetry={() => {}} />,
    ),
  );

  await act(async () => button("Dismiss error")?.click());

  expect(container.textContent).toBe("");
});

// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionBanner from "../src/app/components/ConnectionBanner";
import MeetsErrorBanner from "../src/app/components/MeetsErrorBanner";
import {
  InCallNotice,
  InCallNoticeSlot,
} from "../src/app/components/InCallNotices";

let root: Root;
let container: HTMLDivElement;

const render = async (node: ReactNode) => {
  await act(async () => root.render(<InCallNoticeSlot>{node}</InCallNoticeSlot>));
};
const settle = () =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
const slot = () => container.querySelector("[data-in-call-notices]");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      Object.assign(new EventTarget(), {
        matches: query.includes("reduce"),
        media: query,
        addListener() {},
        removeListener() {},
      }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("in-call notices", () => {
  it("shows a meeting error as an alert with its action and dismiss", async () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const banner = (
      <MeetsErrorBanner
        meetError={{
          code: "PERMISSION_DENIED",
          message: "Camera/microphone permission denied",
          recoverable: true,
        }}
        onDismiss={onDismiss}
        primaryActionLabel="Retry Permissions"
        onPrimaryAction={onRetry}
      />
    );
    await render(<InCallNotice show>{banner}</InCallNotice>);

    const alert = slot()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Camera/microphone permission denied");
    expect(alert?.textContent).toContain(
      "Allow camera and microphone access in your browser, then try again.",
    );
    const buttons = [...(alert?.querySelectorAll("button") ?? [])];
    buttons.find((b) => b.textContent === "Retry Permissions")?.click();
    buttons.find((b) => b.getAttribute("aria-label") === "Dismiss error")?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await render(<InCallNotice show={false}>{banner}</InCallNotice>);
    await settle();
    expect(slot()?.querySelector('[role="alert"]')).toBeNull();
  });

  it("announces the offline notice politely and clears it once back online", async () => {
    await render(<ConnectionBanner state="joined" isOffline />);
    const status = slot()?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("You’re offline. Check your internet connection.");

    await render(<ConnectionBanner state="joined" />);
    await settle();
    expect(slot()?.textContent).toBe("");
  });

  it("stacks several notices in the order they are given", async () => {
    await render(
      <>
        <ConnectionBanner state="reconnecting" />
        <InCallNotice show passive>
          <div role="status">Audio-only mode active</div>
        </InCallNotice>
      </>,
    );
    const messages = [...(slot()?.querySelectorAll('[role="status"]') ?? [])].map(
      (node) => node.textContent,
    );
    expect(messages).toEqual([
      "Connection interrupted. Reconnecting to the meeting…",
      "Audio-only mode active",
    ]);
  });
});

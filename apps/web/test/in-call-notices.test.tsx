// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionBanner from "../src/app/components/ConnectionBanner";
import MeetsErrorBanner from "../src/app/components/MeetsErrorBanner";
import InCallNotice from "../src/app/components/InCallNotice";
import InCallNoticeSlot from "../src/app/components/InCallNoticeSlot";

let root: Root;
let container: HTMLDivElement;

const render = async (node: ReactNode) => {
  await act(async () => root.render(<InCallNoticeSlot>{node}</InCallNoticeSlot>));
};
const waitOutExit = () =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
const slot = () => container.querySelector("[data-in-call-notices]");

// happy-dom's Web Animations shim cancels motion's animations mid-flight, so run
// motion on its requestAnimationFrame fallback like a browser without WAAPI.
const nativeAnimate = Element.prototype.animate;
beforeAll(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
afterAll(() => {
  Element.prototype.animate = nativeAnimate;
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
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
    await waitOutExit();
    expect(slot()?.querySelector('[role="alert"]')).toBeNull();
  });

  it("announces the offline notice politely and clears it once back online", async () => {
    await render(<ConnectionBanner state="joined" isOffline />);
    const status = slot()?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("You’re offline. Check your internet connection.");

    await render(<ConnectionBanner state="joined" />);
    await waitOutExit();
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

  it("takes no clicks and leaves the accessibility tree while it fades out", async () => {
    const onRetry = vi.fn();
    const notice = (show: boolean) => (
      <InCallNotice show={show}>
        <div role="alert">
          Camera or microphone not found
          <button type="button" onClick={onRetry}>
            Retry Devices
          </button>
        </div>
      </InCallNotice>
    );
    await render(notice(true));
    const live = slot()?.querySelector('[role="alert"]');
    expect(live?.closest("[inert]")).toBeNull();
    expect(live?.closest('[aria-hidden="true"]')).toBeNull();

    await render(notice(false));
    const fading = slot()?.querySelector('[role="alert"]');
    expect(fading).not.toBeNull();
    expect(fading?.closest("[inert]")).not.toBeNull();
    expect(fading?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("collapses to the first notice with a more toggle when the stack does not fit", async () => {
    // happy-dom has no layout: every notice is 60px tall and the slot has 150px of room.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(150);
    const stack = (count: number) =>
      ["Camera or microphone not found", "Reconnecting", "Audio-only mode active"]
        .slice(0, count)
        .map((text) => (
          <InCallNotice key={text} show>
            <div role="status">{text}</div>
          </InCallNotice>
        ));
    const toggle = () =>
      [...(slot()?.querySelectorAll("button") ?? [])].find((b) =>
        /more|less/.test(b.textContent ?? ""),
      );

    await render(stack(2));
    expect(toggle()).toBeUndefined();

    await render(stack(3));
    expect(toggle()?.textContent).toBe("+2 more");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggle()?.click());
    expect(toggle()?.textContent).toBe("Show less");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

    await render(stack(2));
    await waitOutExit();
    expect(toggle()).toBeUndefined();
  });
});

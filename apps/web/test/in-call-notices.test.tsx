// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionBanner from "../src/app/components/ConnectionBanner";
import MeetsErrorBanner from "../src/app/components/MeetsErrorBanner";
import InCallNotice from "../src/app/components/InCallNotice";
import InCallNoticeCard from "../src/app/components/InCallNoticeCard";
import InCallNoticeSlot from "../src/app/components/InCallNoticeSlot";
import { Headphones, VolumeX } from "lucide-react";

let root: Root;
let container: HTMLDivElement;

const render = async (node: ReactNode) => {
  await act(async () => root.render(<InCallNoticeSlot>{node}</InCallNoticeSlot>));
};
const waitOutExit = () =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
const slot = () => container.querySelector("[data-in-call-notices]");
const errorCard = () =>
  slot()?.querySelector<HTMLElement>('[data-in-call-notice][data-tone="error"]');
const alertRegion = () =>
  [...(slot()?.children ?? [])].find((el) => el.getAttribute("role") === "alert");

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
          message: "Camera and microphone are blocked",
          recoverable: true,
        }}
        onDismiss={onDismiss}
        primaryActionLabel="Try again"
        onPrimaryAction={onRetry}
      />
    );
    await render(<InCallNotice show>{banner}</InCallNotice>);

    expect(alertRegion()?.textContent).toContain("Camera and microphone are blocked");
    expect(alertRegion()?.textContent).toContain(
      "Allow camera and microphone access in your browser, then try again.",
    );
    expect(errorCard()?.getAttribute("role")).toBeNull();
    const buttons = [...(errorCard()?.querySelectorAll("button") ?? [])];
    buttons.find((b) => b.textContent === "Try again")?.click();
    buttons.find((b) => b.getAttribute("aria-label") === "Dismiss error")?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await render(<InCallNotice show={false}>{banner}</InCallNotice>);
    await waitOutExit();
    expect(errorCard()).toBeFalsy();
    expect(alertRegion()?.textContent).toBe("");
  });

  it("announces the offline notice politely and clears it once back online", async () => {
    await render(<ConnectionBanner state="joined" isOffline />);
    const live = slot()?.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("You’re offline");
    expect(live?.textContent).toContain("Check your internet connection.");
    expect(slot()?.querySelector("[data-in-call-notice]")?.textContent).toContain("You’re offline");

    await render(<ConnectionBanner state="joined" />);
    await waitOutExit();
    expect(slot()?.textContent).toBe("");
  });

  it("stacks several notices in the order they are given", async () => {
    await render(
      <>
        <ConnectionBanner state="reconnecting" />
        <InCallNotice show>
          <InCallNoticeCard icon={Headphones} title="Audio-only mode is on" />
        </InCallNotice>
      </>,
    );
    const messages = [...(slot()?.querySelectorAll("[data-in-call-notice]") ?? [])].map(
      (node) => node.textContent,
    );
    expect(messages).toEqual([
      "Trying to reconnect",
      "Audio-only mode is on",
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
    await waitOutExit();
    expect(toggle()).toBeUndefined();

    await render(stack(3));
    await waitOutExit();
    expect(toggle()?.textContent).toBe("+2 more");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggle()?.click());
    expect(toggle()?.textContent).toBe("Show less");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

    await render(stack(2));
    await waitOutExit();
    expect(toggle()).toBeUndefined();
  });

  it("resumes paused audio from a click anywhere on the notice, once per click", async () => {
    const onResume = vi.fn();
    await render(
      <InCallNotice show>
        <InCallNoticeCard
          tone="error"
          icon={VolumeX}
          title="Your browser paused audio"
          actionLabel="Turn on audio"
          onAction={onResume}
          actionOnCardClick
        />
      </InCallNotice>,
    );
    const card = errorCard();
    card?.querySelector("span")?.click();
    expect(onResume).toHaveBeenCalledTimes(1);
    [...(card?.querySelectorAll("button") ?? [])]
      .find((b) => b.textContent === "Turn on audio")
      ?.click();
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it("keeps one polite live region mounted and inserts each notice into it", async () => {
    await render(null);
    const live = slot()?.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe("");

    await render(
      <InCallNotice show>
        <InCallNoticeCard icon={Headphones} title="Audio-only mode is on" />
      </InCallNotice>,
    );
    expect(slot()?.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live?.textContent).toBe("Audio-only mode is on");
    expect(slot()?.querySelector('[data-in-call-notice][role="status"]')).toBeNull();
  });

  it("shrinks a notice that collapses on dismiss and keeps its action", async () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    await render(
      <InCallNotice show>
        <MeetsErrorBanner
          meetError={{ code: "PERMISSION_DENIED", message: "Camera is blocked", recoverable: true, device: "camera" }}
          onDismiss={onDismiss}
          primaryActionLabel="Try again"
          onPrimaryAction={onRetry}
          collapseOnDismiss
        />
      </InCallNotice>,
    );
    const alert = errorCard;
    const button = (name: string) =>
      [...(alert()?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === name || b.getAttribute("aria-label") === name,
      );
    expect(alert()?.textContent).toContain("Allow camera access in your browser");

    await act(async () => button("Dismiss error")?.click());
    expect(onDismiss).not.toHaveBeenCalled();
    expect(alert()?.textContent).toContain("Camera is blocked");
    expect(alert()?.textContent).not.toContain("Allow camera access");
    expect(button("Dismiss error")).toBeUndefined();
    button("Try again")?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("still announces an error that lands behind a collapsed stack", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(150);
    await render(
      <>
        <InCallNotice show>
          <InCallNoticeCard icon={Headphones} title="Audio-only mode is on" />
        </InCallNotice>
        <InCallNotice show>
          <InCallNoticeCard icon={Headphones} title="Shared browser sound is paused" />
        </InCallNotice>
        <InCallNotice show>
          <InCallNoticeCard tone="error" icon={VolumeX} title="Your browser paused audio" />
        </InCallNotice>
      </>,
    );
    await waitOutExit();
    expect(slot()?.getAttribute("data-lane-mode")).not.toBe("full");
    expect(alertRegion()?.textContent).toBe("Your browser paused audio");
  });
});

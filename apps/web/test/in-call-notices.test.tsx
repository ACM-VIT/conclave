// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionBanner from "../src/app/components/ConnectionBanner";
import MeetsErrorBanner from "../src/app/components/MeetsErrorBanner";
import InCallNotice from "../src/app/components/InCallNotice";
import InCallNoticeCard from "../src/app/components/InCallNoticeCard";
import InCallNoticeSlot from "../src/app/components/InCallNoticeSlot";
import { clearMediaDeviceError, createMeetError, mergeMediaDeviceError } from "../src/app/lib/utils";
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

  it("announces the offline warning right away and clears it once back online", async () => {
    await render(<ConnectionBanner state="joined" isOffline />);
    expect(alertRegion()?.textContent).toContain("You’re offline");
    expect(alertRegion()?.textContent).toContain("Check your internet connection.");
    const card = slot()?.querySelector("[data-in-call-notice]");
    expect(card?.getAttribute("data-tone")).toBe("warning");
    expect(card?.textContent).toContain("You’re offline");

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

  it("stacks several notices behind the first and fans them out on demand", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    const stack = (count: number) =>
      ["Camera is blocked", "You’re offline", "Audio-only mode is on"]
        .slice(0, count)
        .map((text) => (
          <InCallNotice key={text} show>
            <InCallNoticeCard icon={Headphones} title={text} />
          </InCallNotice>
        ));
    const toggle = () =>
      [...(slot()?.querySelectorAll("button") ?? [])].find((b) =>
        /more|less/.test(b.textContent ?? ""),
      );
    const peeks = () => slot()?.querySelectorAll("[data-peek]").length ?? 0;

    await render(stack(1));
    await waitOutExit();
    expect(toggle()).toBeUndefined();
    expect(peeks()).toBe(0);

    await render(stack(3));
    await waitOutExit();
    expect(toggle()?.textContent).toBe("+2 more");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(peeks()).toBe(2);

    await act(async () => toggle()?.click());
    await waitOutExit();
    expect(toggle()?.textContent).toBe("Show less");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(peeks()).toBe(0);

    await act(async () => toggle()?.click());
    await waitOutExit();
    expect(toggle()?.textContent).toBe("+2 more");
    expect(peeks()).toBe(2);

    await render(stack(1));
    await waitOutExit();
    expect(toggle()).toBeUndefined();
  });

  it("opens notices in a sheet instead of over controls when the stage has no room", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(70);
    const notices = ["Camera is blocked", "You’re offline", "Audio-only mode is on"].map((text) => (
      <InCallNotice key={text} show>
        <InCallNoticeCard tone={text === "Camera is blocked" ? "error" : "neutral"} icon={Headphones} title={text} />
      </InCallNotice>
    ));
    const button = (name: string) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === name || b.textContent === name,
      );
    const mode = () => slot()?.getAttribute("data-lane-mode");
    const sheet = () => document.querySelector("dialog");
    await render(notices);
    await waitOutExit();
    expect(mode()).toBe("compact");
    const inserted: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) inserted.push(node.textContent ?? "");
    });
    for (const region of [slot()?.querySelector('[aria-live="polite"]'), alertRegion()]) {
      if (region) observer.observe(region, { childList: true, subtree: true, characterData: true });
    }

    await act(async () => button("Show 2 more notices")?.click());
    await waitOutExit();
    expect(mode()).toBe("sheet");
    expect(sheet()?.getAttribute("aria-label")).toBe("Notices");
    expect(sheet()?.querySelectorAll("[data-in-call-notice]")).toHaveLength(3);
    expect(slot()?.querySelector("[data-in-call-notices] > div [data-in-call-notice]")).toBeNull();

    await act(async () => button("Close notices")?.click());
    await waitOutExit();
    expect(sheet()).toBeNull();
    expect(mode()).toBe("compact");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Show 2 more notices");

    clientHeight.mockReturnValue(20);
    await act(async () => window.dispatchEvent(new Event("resize")));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(mode()).toBe("chip");
    const chip = button("Show 3 notices");
    expect(chip).toBeTruthy();
    expect(slot()?.querySelector("div[inert] [data-in-call-notice]")).toBeTruthy();

    await act(async () => chip?.click());
    await waitOutExit();
    expect(mode()).toBe("sheet");
    expect(sheet()?.querySelectorAll("[data-in-call-notice]")).toHaveLength(3);
    observer.disconnect();
    expect(inserted).toEqual([]);

    await render([
      ...notices,
      <InCallNotice key="new" show>
        <InCallNoticeCard tone="warning" icon={VolumeX} title="Your browser paused audio" />
      </InCallNotice>,
    ]);
    await waitOutExit();
    expect(sheet()?.querySelector('[role="alert"]')?.textContent).toBe("Your browser paused audio");
    expect(sheet()?.querySelector('[aria-live="polite"]')?.textContent).toBe("");
  });

  it("settles within a couple of frames in chip mode through a notice change and a resize storm", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
    let height = 20;
    let width = 366;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return /\babsolute\b/.test(this.className) ? width + 24 : width;
    });
    const notices = (first: string) =>
      [first, "You’re offline", "Audio-only mode is on"].map((text, index) => (
        <InCallNotice key={index} show>
          <InCallNoticeCard tone={index === 0 ? "error" : "neutral"} icon={Headphones} title={text} detail="Check your settings." />
        </InCallNotice>
      ));
    await render(notices("Camera is blocked"));
    await waitOutExit();
    expect(slot()?.getAttribute("data-lane-mode")).toBe("chip");

    await render(notices("Camera didn’t respond"));
    for (let step = 0; step < 12; step++) {
      width = 340 + (step % 4) * 10;
      height = 16 + (step % 3) * 4;
      await act(async () => {
        container.dispatchEvent(new Event("transitionend"));
        await new Promise((resolve) => setTimeout(resolve, 8));
      });
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(slot()?.getAttribute("data-lane-mode")).toBe("chip");

    const frames = vi.spyOn(window, "requestAnimationFrame");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(frames.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("keeps a collapsed error collapsed when it moves into an opened phone panel", async () => {
    const meetError = { code: "PERMISSION_DENIED" as const, message: "Camera is blocked", recoverable: true, device: "camera" as const };
    const banner = (overPanel: boolean) => (
      <InCallNoticeSlot overPanel={overPanel}>
        <InCallNotice show>
          <MeetsErrorBanner
            meetError={meetError}
            onDismiss={() => {}}
            primaryActionLabel="Try again"
            onPrimaryAction={() => {}}
            collapseOnDismiss
          />
        </InCallNotice>
      </InCallNoticeSlot>
    );
    await act(async () => root.render(banner(false)));
    const dismiss = () => document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]');
    await act(async () => dismiss()?.click());
    expect(dismiss()).toBeNull();
    const panel = document.createElement("div");
    panel.className = "fixed";
    panel.innerHTML = "<header>Chat</header><div data-panel-notices></div><form>Composer</form>";
    panel.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
    Object.assign(panel, { __reactFiber$probe: { stateNode: panel } });
    document.body.append(panel);
    await act(async () => root.render(banner(true)));
    await waitOutExit();
    expect(panel.querySelector("[data-in-call-notice]")?.textContent).toContain("Camera is blocked");
    expect(dismiss()).toBeNull();
    await act(async () => root.render(banner(false)));
    panel.remove();
  });

  it("keeps focus on one disclosure toggle and tabs into the revealed actions", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    await render(
      ["Camera is blocked", "Your browser paused audio", "Audio-only mode is on"].map((text) => (
        <InCallNotice key={text} show>
          <InCallNoticeCard icon={Headphones} title={text} actionLabel="Fix" onAction={() => {}} />
        </InCallNotice>
      )),
    );
    await waitOutExit();
    const toggle = slot()?.querySelector<HTMLButtonElement>("[data-notice-toggle]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.focus();
    await act(async () => toggle?.click());
    await waitOutExit();
    expect(slot()?.querySelector("[data-notice-toggle]")).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const actions = [...(slot()?.querySelectorAll("[data-in-call-notice] button") ?? [])];
    expect(actions.length).toBe(3);
    for (const action of actions) {
      expect(toggle!.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await act(async () => toggle?.click());
    await waitOutExit();
    expect(slot()?.querySelector("[data-notice-toggle]")).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
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

  it("puts notices in the open phone panel's flow instead of over its rows", async () => {
    const panel = document.createElement("div");
    panel.innerHTML = '<header>Participants</header><div data-panel-notices></div><section>Host controls</section>';
    panel.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
    Object.assign(panel, { __reactFiber$probe: { stateNode: panel } });
    document.body.append(panel);
    await act(async () =>
      root.render(
        <InCallNoticeSlot overPanel>
          <InCallNotice show>
            <InCallNoticeCard icon={Headphones} title="Audio-only mode is on" />
          </InCallNotice>
        </InCallNoticeSlot>,
      ),
    );
    const target = panel.querySelector("[data-panel-notices]");
    expect(target?.querySelector("[data-in-call-notice]")?.textContent).toContain("Audio-only mode is on");
    expect(slot()?.querySelector("[data-in-call-notice]")).toBeNull();
    expect(target?.nextElementSibling?.textContent).toBe("Host controls");
    expect(alertRegion()).toBeTruthy();
    await act(async () => root.render(<InCallNoticeSlot>{null}</InCallNoticeSlot>));
    panel.remove();
  });

  it("never re-announces notices that move into and out of an opened phone panel", async () => {
    const notices = (overPanel: boolean, extra?: ReactNode) => (
      <InCallNoticeSlot overPanel={overPanel}>
        <InCallNotice show>
          <MeetsErrorBanner
            meetError={{ code: "PERMISSION_DENIED", message: "Camera is blocked", recoverable: true, device: "camera" }}
            onDismiss={() => {}}
          />
        </InCallNotice>
        <InCallNotice show>
          <InCallNoticeCard tone="warning" icon={VolumeX} title="Your browser paused audio" />
        </InCallNotice>
        <InCallNotice show>
          <InCallNoticeCard icon={Headphones} title="Audio-only mode is on" />
        </InCallNotice>
        {extra}
      </InCallNoticeSlot>
    );
    await act(async () => root.render(notices(false)));
    const regions = [
      slot()?.querySelector('[aria-live="polite"]'),
      alertRegion(),
    ].filter((region): region is Element => Boolean(region));
    expect(regions).toHaveLength(2);
    expect(alertRegion()?.textContent).toContain("Camera is blocked");
    const inserted: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) inserted.push(node.textContent ?? "");
        if (record.type === "characterData") inserted.push(record.target.textContent ?? "");
      }
    });
    for (const region of regions) observer.observe(region, { childList: true, subtree: true, characterData: true });

    const panel = document.createElement("div");
    panel.className = "fixed";
    panel.innerHTML = "<header>Chat</header><div data-panel-notices></div><form>Composer</form>";
    panel.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
    Object.assign(panel, { __reactFiber$probe: { stateNode: panel } });
    document.body.append(panel);
    await act(async () => root.render(notices(true)));
    await waitOutExit();
    expect(panel.querySelector("[data-panel-notices] [data-in-call-notice]")).toBeTruthy();
    await act(async () => root.render(notices(false)));
    await waitOutExit();
    panel.remove();
    expect(slot()?.querySelector("[data-in-call-notice]")).toBeTruthy();
    expect(inserted).toEqual([]);

    await act(async () =>
      root.render(
        notices(
          false,
          <InCallNotice show>
            <InCallNoticeCard icon={Headphones} title="Shared browser sound is paused" />
          </InCallNotice>,
        ),
      ),
    );
    observer.disconnect();
    expect(inserted).toEqual(["Shared browser sound is paused"]);
  });

  it("gives the microphone's permission advice once a missing camera is fixed", async () => {
    const micBlocked = createMeetError(new DOMException("Permission denied", "NotAllowedError"), "PERMISSION_DENIED", "microphone");
    const cameraMissing = createMeetError(new DOMException("Requested device not found", "NotFoundError"), "MEDIA_ERROR", "camera");
    const remaining = clearMediaDeviceError(mergeMediaDeviceError(micBlocked, cameraMissing), "camera");
    await render(
      <InCallNotice show>
        <MeetsErrorBanner meetError={remaining!} onDismiss={() => {}} />
      </InCallNotice>,
    );
    expect(errorCard()?.textContent).toContain("Microphone is blocked");
    expect(errorCard()?.textContent).toContain("Allow microphone access in your browser, then try again.");
  });

  it("gives each device its own advice when their causes differ", async () => {
    const merged = mergeMediaDeviceError(
      createMeetError(new DOMException("Permission denied", "NotAllowedError"), "PERMISSION_DENIED", "microphone"),
      createMeetError(new DOMException("Requested device not found", "NotFoundError"), "MEDIA_ERROR", "camera"),
    );
    await render(
      <InCallNotice show>
        <MeetsErrorBanner meetError={merged} onDismiss={() => {}} />
      </InCallNotice>,
    );
    expect(errorCard()?.textContent).toContain("Microphone is blocked and no camera found");
    expect(errorCard()?.textContent).toContain(
      "Allow microphone access in your browser, and connect or select a camera, then try again.",
    );
  });
});


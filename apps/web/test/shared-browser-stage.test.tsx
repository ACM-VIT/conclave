// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SharedBrowserStage, {
  SHARED_BROWSER_LOAD_TIMEOUT_MS,
} from "../src/app/components/SharedBrowserStage";

const LIVE_VIEW_URL = "https://live-view.invalid/ui/view?mode=tab";
const NEXT_LIVE_VIEW_URL = "https://live-view.invalid/ui/view?mode=tab&page=2";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(props: Partial<Parameters<typeof SharedBrowserStage>[0]> = {}) {
  act(() => {
    root.render(
      <SharedBrowserStage
        noVncUrl={LIVE_VIEW_URL}
        controllerName="Alice"
        isLocalController={false}
        provider="kitesurf"
        {...props}
      />,
    );
  });
}

const text = () => container.textContent ?? "";
const pageFrame = () => container.querySelector("iframe") as HTMLIFrameElement;
const finishLoading = () =>
  act(() => {
    pageFrame().dispatchEvent(new Event("load"));
  });
const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );

it("says who is sharing the browser", () => {
  render();
  expect(text()).toContain("Alice is sharing a browser");

  render({ isLocalController: true });
  expect(text()).toContain("You’re sharing a browser");

  render({ controllerName: "  " });
  expect(text()).toContain("The host is sharing a browser");
});

it("shows the page only once it has loaded", () => {
  render();
  expect(text()).toContain("Loading shared browser");
  expect(pageFrame().style.opacity).toBe("0");
  expect(pageFrame().style.pointerEvents).toBe("none");

  finishLoading();

  expect(text()).not.toContain("Loading shared browser");
  expect(pageFrame().style.opacity).toBe("1");
  expect(pageFrame().style.pointerEvents).toBe("auto");
  expect(text()).toContain("Alice is sharing a browser");
});

it("offers Retry when the page never loads, and loads it again", () => {
  render();
  const firstFrame = pageFrame();

  act(() => {
    vi.advanceTimersByTime(SHARED_BROWSER_LOAD_TIMEOUT_MS - 1);
  });
  expect(text()).toContain("Loading shared browser");

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(text()).toContain("Couldn’t load the shared browser");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();

  act(() => {
    button("Retry")?.click();
  });
  expect(text()).toContain("Loading shared browser");
  expect(text()).not.toContain("Couldn’t load");
  expect(pageFrame()).not.toBe(firstFrame);

  finishLoading();
  expect(text()).not.toContain("Loading shared browser");
  expect(pageFrame().style.opacity).toBe("1");
});

it("goes back to loading when the shared page changes", () => {
  render();
  finishLoading();
  expect(text()).not.toContain("Loading shared browser");

  render({ noVncUrl: NEXT_LIVE_VIEW_URL });
  expect(text()).toContain("Loading shared browser");
  expect(pageFrame().getAttribute("src")).toBe(NEXT_LIVE_VIEW_URL);
});

it("keeps the noVNC input layer over the browser video", () => {
  const stream = new MediaStream();
  render({ provider: "chromium", browserVideoStream: stream });

  const frame = pageFrame();
  expect(frame.getAttribute("title")).toBe("Shared browser input");
  expect(frame.getAttribute("src")).toContain("autoconnect=true&resize=scale");
  expect(frame.style.opacity).toBe("0");
  expect(frame.style.pointerEvents).toBe("auto");
  expect(container.querySelector("video")).not.toBeNull();
  expect(text()).not.toContain("Loading shared browser");
  expect(text()).toContain("Alice is sharing a browser");
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PresentedApp from "../src/app/components/apps/PresentedApp";

let host: HTMLDivElement;
let root: Root;

const Board = () => <p>board</p>;

const render = async (props: Partial<Parameters<typeof PresentedApp>[0]> = {}) => {
  await act(async () =>
    root.render(
      <PresentedApp
        app={Board}
        appName="Whiteboard"
        appKey="whiteboard:0"
        syncStatus="synced"
        onRetrySync={() => {}}
        rejectedChange={null}
        {...props}
      />,
    ),
  );
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows loading, then the app, and a retry once the sync fails", async () => {
  const onRetrySync = vi.fn();
  await render({ syncStatus: "syncing" });
  expect(host.textContent).toContain("Loading Whiteboard");

  await render({ syncStatus: "failed", onRetrySync });
  expect(host.textContent).toContain("Couldn't load this app");
  await act(async () => host.querySelector("button")!.click());
  expect(onRetrySync).toHaveBeenCalledTimes(1);

  await render({ syncStatus: "synced" });
  expect(host.textContent).toBe("board");
});

it("says a refused change was not saved, then lets the notice go", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await render({ syncStatus: "syncing", rejectedChange: { at: Date.now(), reason: "id-limit" } });
  expect(host.textContent).toContain("Your last change couldn't be saved");

  await act(async () => {
    vi.advanceTimersByTime(4_000);
  });
  expect(host.textContent).not.toContain("couldn't be saved");
});

it("says the app is full when a change was refused for size", async () => {
  await render({ rejectedChange: { at: Date.now(), reason: "too-large" } });
  expect(host.textContent).toContain("This app is full, so your last change couldn't be saved");
});

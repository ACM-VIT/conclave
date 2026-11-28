// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../../../packages/apps-sdk/src/apps/watch/core/model/types";
import { WatchQueue } from "../../../packages/apps-sdk/src/apps/watch/web/components/WatchQueue";

let root: Root;
let container: HTMLDivElement;

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
  vi.restoreAllMocks();
});

const items: QueueItem[] = [
  { id: "a", videoId: "OPf0YbXqDm0", title: "Uptown Funk", addedById: "u1", addedByName: "Hana" },
  { id: "b", videoId: "9bZkp7q19f0", title: "Gangnam Style", addedById: "u2", addedByName: "Leo" },
];

const handlers = () => ({
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onPlayNow: vi.fn(),
  onMove: vi.fn(),
});

const buttons = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)];

describe("WatchQueue rail", () => {
  it("gives editors a labeled action for every queue change, scoped to its row", async () => {
    const h = handlers();
    await act(async () =>
      root.render(
        <WatchQueue items={items} nowPlaying={{ videoId: "fJ9rUzIMcZQ", title: "Bohemian Rhapsody" }} readOnly={false} {...h} />,
      ),
    );

    expect(container.textContent).toContain("Now playing");
    expect(container.textContent).toContain("Bohemian Rhapsody");
    expect(buttons("Move up").map((b) => b.disabled)).toEqual([true, false]);
    expect(buttons("Move down").map((b) => b.disabled)).toEqual([false, true]);

    await act(async () => buttons("Play now")[1].click());
    await act(async () => buttons("Move down")[0].click());
    await act(async () => buttons("Move up")[1].click());
    await act(async () => buttons("Remove from queue")[0].click());

    expect(h.onPlayNow).toHaveBeenCalledWith("b");
    expect(h.onMove.mock.calls).toEqual([["a", 1], ["b", -1]]);
    expect(h.onRemove).toHaveBeenCalledWith("a");
  });

  it("adds a pasted YouTube link by its video id and ignores non-links for direct add", async () => {
    const h = handlers();
    await act(async () =>
      root.render(<WatchQueue items={[]} nowPlaying={null} readOnly={false} {...h} />),
    );
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Add a video to Up next"]');
    expect(input).not.toBeNull();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "https://youtu.be/dQw4w9WgXcQ?t=5");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input!.form!.requestSubmit());

    expect(h.onAdd).toHaveBeenCalledWith("dQw4w9WgXcQ");
    expect(input!.value).toBe("");
    expect(container.textContent).toContain("Nothing up next. Add a video");
  });

  it("shows no edit controls when read only and renders the request entry instead", async () => {
    const h = handlers();
    await act(async () =>
      root.render(
        <WatchQueue
          items={items}
          nowPlaying={{ videoId: "fJ9rUzIMcZQ", title: null }}
          readOnly
          addSection={<button type="button">Request a video</button>}
          {...h}
        />,
      ),
    );

    expect(container.querySelector('input[aria-label="Add a video to Up next"]')).toBeNull();
    for (const label of ["Play now", "Move up", "Move down", "Remove from queue"]) {
      expect(buttons(label)).toHaveLength(0);
    }
    expect(container.textContent).toContain("Request a video");
    expect(container.textContent).toContain("Uptown Funk");
  });
});

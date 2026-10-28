// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSharedVoiceStart } from "../src/app/hooks/useSharedVoiceStart";
import type { RoomAiController } from "../src/app/hooks/useRoomAi";
let root: Root;
let element: HTMLDivElement;
let flow: ReturnType<typeof useSharedVoiceStart>;
let scope = "room-1";
const ready = vi.fn();
const configure = vi.fn();
function Harness() {
  flow = useSharedVoiceStart(
    { configure } as unknown as RoomAiController,
    scope,
    ready,
  );
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  scope = "room-1";
  ready.mockReset();
  configure.mockReset();
  element = document.createElement("div");
  root = createRoot(element);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it.each(["cancel", "room change", "unmount"])(
  "does not start listening after %s during a delayed key save",
  async (reason) => {
    let acknowledge!: (error: null) => void;
    configure.mockReturnValue(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = flow.start("sk-fixture", false);
    });
    await act(async () => {
      if (reason === "cancel") flow.cancel();
      if (reason === "room change") {
        scope = "room-2";
        root.render(<Harness />);
      }
      if (reason === "unmount") root.render(null);
    });
    await act(async () => {
      acknowledge(null);
      await pending;
    });
    expect(ready).not.toHaveBeenCalled();
  },
);
it("can retry after cancellation without the old save starting the agent", async () => {
  let old!: (error: null) => void;
  configure
    .mockReturnValueOnce(
      new Promise((resolve) => {
        old = resolve;
      }),
    )
    .mockResolvedValueOnce(null);
  let previous!: Promise<void>;
  await act(async () => {
    previous = flow.start("sk-old", false);
  });
  await act(async () => flow.cancel());
  await act(async () => flow.start("sk-new", true));
  await act(async () => {
    old(null);
    await previous;
  });
  expect(ready).toHaveBeenCalledExactlyOnceWith("sk-new", true);
});

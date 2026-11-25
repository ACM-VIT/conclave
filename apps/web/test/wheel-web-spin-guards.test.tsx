// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addEntries, getEntries, startSpin, type WheelSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import type { WheelPanel as RealWheelPanel } from "../../../packages/apps-sdk/src/apps/wheel/web/components/WheelPanel";
import type { WheelStage as RealWheelStage } from "../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage";

type PanelProps = ComponentProps<typeof RealWheelPanel>;
type StageProps = ComponentProps<typeof RealWheelStage>;

const harness = vi.hoisted(() => ({
  doc: null as unknown as import("yjs").Doc,
  panel: null as PanelProps | null,
  stage: null as StageProps | null,
}));

vi.mock("../../../packages/apps-sdk/src/sdk/hooks/useAppDoc", () => ({
  useAppDoc: () => ({ doc: harness.doc, awareness: null, locked: false }),
}));

vi.mock("../../../packages/apps-sdk/src/sdk/hooks/useApps", () => ({
  useApps: () => ({
    user: { id: "host-1", name: "Host" },
    isAdmin: true,
    isReadOnly: false,
    participants: [],
  }),
}));

vi.mock("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage", () => ({
  WheelStage: (props: StageProps) => {
    harness.stage = props;
    return null;
  },
}));

vi.mock("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelPanel", async (importActual) => {
  const actual = await importActual<typeof import("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelPanel")>();
  return {
    WheelPanel: (props: PanelProps) => {
      harness.panel = props;
      return <actual.WheelPanel {...props} />;
    },
  };
});

const { WheelWebApp } = await import("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelWebApp");

let root: Root;
let container: HTMLDivElement;

const labels = (): string[] => getEntries(harness.doc).map((entry) => entry.label);

const action = (name: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[data-wheel-action="${name}"]`);

const removeButtons = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('ol li button[aria-label^="Remove "]'));

const click = (button: HTMLButtonElement | null) => {
  expect(button).not.toBeNull();
  act(() => {
    button!.click();
  });
};

const DURATION = 8_000;

const startSharedSpin = (entries: unknown[] = getEntries(harness.doc), winnerIndex = 0) => {
  const spin = {
    spinId: "spin-remote",
    entries,
    winnerIndex,
    startedAt: Date.now(),
    durationMs: DURATION,
    turns: 8,
    jitter: 0.5,
    spunById: "someone-else",
    spunByName: "Grace",
  } as WheelSpin;
  act(() => startSpin(harness.doc, spin));
  act(() => harness.stage!.onSpinningChange(false));
};

const endSharedSpin = () => {
  act(() => {
    vi.advanceTimersByTime(DURATION + 50);
  });
};

const panel = (): PanelProps => {
  expect(harness.panel).not.toBeNull();
  return harness.panel!;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(1_800_000_000_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.doc = new Y.Doc();
  harness.panel = null;
  harness.stage = null;
  addEntries(harness.doc, ["Cy", "Ada", "Bo"]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<WheelWebApp />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wheel web app while a shared spin runs, even when the dial reports it has stopped", () => {
  it("disables shuffle, sort and clear and hides every remove button", () => {
    expect(removeButtons()).toHaveLength(3);
    expect([action("shuffle")!.disabled, action("sort")!.disabled, action("clear")!.disabled]).toEqual([false, false, false]);
    startSharedSpin();
    expect([action("shuffle")!.disabled, action("sort")!.disabled, action("clear")!.disabled]).toEqual([true, true, true]);
    expect(removeButtons()).toHaveLength(0);
    click(action("shuffle"));
    click(action("sort"));
    click(action("clear"));
    expect(action("clear-confirm")).toBeNull();
    expect(labels()).toEqual(["Cy", "Ada", "Bo"]);
  });

  it("closes a clear confirmation the spin interrupted, so it cannot clear mid-spin", () => {
    click(action("clear"));
    expect(action("clear-confirm")).not.toBeNull();
    startSharedSpin();
    expect(action("clear-confirm")).toBeNull();
    expect(labels()).toEqual(["Cy", "Ada", "Bo"]);
  });

  it("drops a shuffle, sort, remove or clear that reaches the app after the spin began", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    startSharedSpin();
    const stale = panel();
    act(() => {
      stale.onShuffle();
      stale.onSort();
      stale.onRemoveEntry(getEntries(harness.doc)[0].id);
      stale.onClearEntries();
    });
    expect(labels()).toEqual(["Cy", "Ada", "Bo"]);

    endSharedSpin();
    act(() => panel().onSort());
    expect(labels()).toEqual(["Ada", "Bo", "Cy"]);
    act(() => panel().onShuffle());
    expect(labels()).not.toEqual(["Ada", "Bo", "Cy"]);
    act(() => panel().onRemoveEntry(getEntries(harness.doc)[0].id));
    expect(labels()).toHaveLength(2);
    act(() => panel().onClearEntries());
    expect(labels()).toEqual([]);
  });

  it("draws a build 63 spin with every one of its slices, hidden slot included", () => {
    startSharedSpin([{ id: "a", label: "Ada" }, { id: "b", label: "Bo" }, { id: "z", label: "\u200B" }], 2);
    expect(harness.stage!.entries.map((entry) => entry.label)).toEqual(["Ada", "Bo", ""]);
    endSharedSpin();
    expect(harness.stage!.entries.map((entry) => entry.label)).toEqual(["Ada", "Bo", ""]);
  });
});

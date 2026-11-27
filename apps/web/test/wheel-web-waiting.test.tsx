// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addEntries, getEntries, removeEntryById } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";

const harness = vi.hoisted(() => ({ doc: null as unknown as import("yjs").Doc, canEdit: true }));

vi.mock("../../../packages/apps-sdk/src/sdk/hooks/useAppDoc", () => ({
  useAppDoc: () => ({ doc: harness.doc, awareness: null, locked: false }),
}));

vi.mock("../../../packages/apps-sdk/src/sdk/hooks/useApps", () => ({
  useApps: () => ({ user: { id: "host-1", name: "Host" }, isAdmin: true, isReadOnly: !harness.canEdit, participants: [] }),
}));

vi.mock("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage", () => ({ WheelStage: () => null }));

const { WheelWebApp } = await import("../../../packages/apps-sdk/src/apps/wheel/web/components/WheelWebApp");

let root: Root;
let container: HTMLDivElement;

const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

const capacity = (): string | null => container.querySelector("[data-wheel-capacity]")?.textContent ?? null;
const rowCount = (): number => container.querySelectorAll("ol li").length;
const addBox = (): HTMLInputElement | null => container.querySelector<HTMLInputElement>("input[data-wheel-add]");

const openWheelWith = (waiting: number, canEdit = true) => {
  harness.canEdit = canEdit;
  harness.doc = new Y.Doc();
  addEntries(harness.doc, Array.from({ length: 63 }, (_, index) => `N${index + 1}`));
  const others = Array.from({ length: waiting + 1 }, (_, index) => {
    const other = new Y.Doc();
    sync(harness.doc, other);
    addEntries(other, [`Late ${index + 1}`]);
    return other;
  });
  for (const other of others) sync(other, harness.doc);
  act(() => root.render(<WheelWebApp />));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("wheel names panel when more names were accepted than the wheel holds", () => {
  it("says how many names wait, keeps the add box closed and counts them in Clear", () => {
    openWheelWith(2);
    expect(rowCount()).toBe(64);
    expect(capacity()).toBe("The wheel holds up to 64 names. 2 more are waiting for a place.");
    expect(addBox()!.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[data-wheel-action="clear"]')!.click());
    expect(container.textContent).toContain("Clear all 66 names?");
  });

  it("moves a waiting name onto the list when a place frees up, and stops saying so once none wait", () => {
    openWheelWith(1);
    expect(capacity()).toBe("The wheel holds up to 64 names. 1 more is waiting for a place.");
    act(() => removeEntryById(harness.doc, getEntries(harness.doc)[0].id));
    expect(rowCount()).toBe(64);
    expect(capacity()).toBe("The wheel holds up to 64 names.");
    expect(getEntries(harness.doc).slice(-2).map((entry) => entry.label).sort()).toEqual(["Late 1", "Late 2"]);
    act(() => removeEntryById(harness.doc, getEntries(harness.doc)[0].id));
    expect(capacity()).toBeNull();
    expect(addBox()!.disabled).toBe(false);
  });

  it("tells someone who cannot edit that names are waiting", () => {
    openWheelWith(3, false);
    expect(capacity()).toBe("The wheel holds up to 64 names. 3 more are waiting for a place.");
    expect(addBox()).toBeNull();
  });
});

// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useElementSize, type ElementSize } from "../src/app/hooks/useElementSize";

const sizes = new WeakMap<HTMLElement, { width: number; height: number }>();
const observers = new Set<{ callback: () => void; targets: Set<Element> }>();

class FakeResizeObserver {
  private entry: { callback: () => void; targets: Set<Element> };
  constructor(callback: () => void) {
    this.entry = { callback, targets: new Set() };
    observers.add(this.entry);
  }
  observe(target: Element) {
    this.entry.targets.add(target);
  }
  disconnect() {
    this.entry.targets.clear();
    observers.delete(this.entry);
  }
}

const resize = (el: HTMLElement, width: number, height: number) => {
  sizes.set(el, { width, height });
  for (const entry of observers) if (entry.targets.has(el)) entry.callback();
};

let container: HTMLDivElement;
let root: Root;
let latest: ElementSize | null = null;
let show: (value: boolean) => void = () => {};
let tile: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return sizes.get(this)?.width ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return sizes.get(this)?.height ?? 0;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Owner() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  show = setVisible;
  latest = useElementSize(ref);
  return visible ? (
    <div
      ref={(node) => {
        ref.current = node;
        tile = node;
        if (node && !sizes.has(node)) sizes.set(node, { width: 282, height: 158 });
      }}
    />
  ) : null;
}

it("measures an element that mounts after its owner", () => {
  act(() => root.render(<Owner />));
  expect(latest).toBeNull();

  act(() => show(true));
  expect(latest).toEqual({ width: 282, height: 158 });

  act(() => resize(tile as HTMLDivElement, 200, 120));
  expect(latest).toEqual({ width: 200, height: 120 });
});

it("forgets an element that unmounts and measures the next one", () => {
  act(() => root.render(<Owner />));
  act(() => show(true));
  const first = tile as HTMLDivElement;
  act(() => show(false));
  expect(latest).toBeNull();

  act(() => show(true));
  expect(tile).not.toBe(first);
  expect(latest).toEqual({ width: 282, height: 158 });
  act(() => resize(first, 999, 999));
  expect(latest).toEqual({ width: 282, height: 158 });
});

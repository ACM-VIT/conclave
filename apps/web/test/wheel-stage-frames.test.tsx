// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWheelDoc, getSpin, type WheelEntry, type WheelSpin } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import { WheelStage } from "../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage";

const CONJUNCT = String.fromCharCode(0x915) + String.fromCharCode(0x94d, 0x915).repeat(23);
const NUMBER_SELECTOR = "[data-wheel-number]";

let root: Root;
let container: HTMLDivElement;
let frames: FrameRequestCallback[];
let now: number;

const entriesOf = (labels: string[]) => labels.map((label, index) => ({ id: `entry-${index}`, label }));

type StageOptions = {
  spin?: WheelSpin | null;
  onPointerLabel?: (label: string | null) => void;
  onSettled?: (spin: WheelSpin, fresh: boolean) => void;
};

const renderStage = (labels: string[], options: StageOptions = {}) => {
  act(() => {
    root.render(
      <WheelStage
        entries={entriesOf(labels)}
        spin={options.spin ?? null}
        canSpin
        sounds={null}
        reducedMotion={false}
        highlightIndex={null}
        onRequestSpin={() => {}}
        onSettled={options.onSettled ?? (() => {})}
        onSpinningChange={() => {}}
        onPointerLabel={options.onPointerLabel ?? (() => {})}
      />
    );
  });
};

const spinOver = (entries: WheelEntry[], winnerIndex: number): WheelSpin => ({
  spinId: "spin-1",
  entries,
  winnerIndex,
  startedAt: now,
  durationMs: 8000,
  turns: 8,
  jitter: 0.5,
  spunById: "user-1",
  spunByName: "Host",
});

const runFrames = (count: number) => {
  for (let index = 0; index < count; index += 1) {
    const pending = frames;
    frames = [];
    now += 16;
    act(() => {
      for (const frame of pending) frame(now);
    });
  }
};

const rotationOf = (element: Element | null): number => {
  const match = /rotate\(([-\d.e]+)/.exec(element?.getAttribute("transform") ?? "");
  return match ? Number(match[1]) : Number.NaN;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = [];
  now = 1000;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 600, width: 600, height: 600, toJSON() {} }) as DOMRect
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wheel stage frames", () => {
  it("skips the number lookup on frames where no slice shows a number", () => {
    renderStage(["Ada", "Grace", "Linus", "Alan", "Ken", "Radia"]);
    runFrames(2);
    expect(container.querySelectorAll("svg text").length).toBe(6);
    const lookups = vi.spyOn(Element.prototype, "querySelectorAll");
    runFrames(30);
    expect(lookups.mock.calls.filter(([selector]) => selector === NUMBER_SELECTOR)).toHaveLength(0);
  });

  it("keeps every number upright on every frame of an active spin", () => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const labels = ["Ada", "Grace", "Linus", "Alan", "Ken", CONJUNCT];
    renderStage(labels, { spin: spinOver(entriesOf(labels), 2) });
    runFrames(2);
    expect(container.querySelector(NUMBER_SELECTOR)?.textContent).toBe("6");
    let moved = 0;
    let previous = rotationOf(container.querySelector("svg g"));
    for (let frame = 0; frame < 150; frame += 1) {
      runFrames(1);
      const wheel = rotationOf(container.querySelector("svg g"));
      if (Math.abs(wheel - previous) > 1e-6) moved += 1;
      previous = wheel;
      expect(rotationOf(container.querySelector(NUMBER_SELECTOR)), `frame ${frame}`).toBeCloseTo(-wheel, 6);
    }
    expect(moved).toBeGreaterThan(100);
  });

  it("draws a spin slot it cannot show as its number and reads it out by number when it wins", () => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const pointed: (string | null)[] = [];
    const settled: (string | null | undefined)[] = [];
    const slots = [
      { id: "a", label: "Ada" },
      { id: "b", label: "Bo" },
      { id: "z", label: "" },
    ];
    renderStage(["Ada", "Bo"], {
      spin: spinOver(slots, 2),
      onPointerLabel: (label) => pointed.push(label),
      onSettled: () => settled.push(pointed.filter((label) => label !== null).at(-1)),
    });
    runFrames(2);
    expect(container.querySelectorAll("svg path").length).toBeGreaterThanOrEqual(3);
    expect([...container.querySelectorAll(NUMBER_SELECTOR)].map((node) => node.textContent)).toEqual(["3"]);
    runFrames(600);
    expect(settled).toEqual(["3"]);
  });

  it("draws a stored spin that repeats ids and names a made-up one without two slices sharing a key", () => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = createWheelDoc();
    const stored = spinOver(
      [{ id: "a", label: "Ada" }, { id: "a", label: "Bo" }, { id: "slot-3", label: "Cy" }, null as unknown as WheelEntry],
      1
    );
    doc.getMap("wheel").set("spin", stored);
    const spin = getSpin(doc)!;
    renderStage(["Ada", "Bo"], { spin });
    runFrames(2);
    expect(container.querySelectorAll("svg path").length).toBeGreaterThanOrEqual(4);
    expect([...container.querySelectorAll("svg text")].map((node) => node.textContent)).toEqual(["Ada", "Bo", "Cy", "4"]);
    expect(errors.mock.calls.filter(([message]) => String(message).includes("same key"))).toEqual([]);
  });

  it("numbers a lone name that cannot keep one cluster", () => {
    renderStage([Array.from({ length: 15 }, () => "\u{1F468}").join("\u200D")]);
    runFrames(2);
    expect([...container.querySelectorAll(NUMBER_SELECTOR)].map((node) => node.textContent)).toEqual(["1"]);
  });

  it("turns a numbered slice against the wheel on every frame", () => {
    renderStage(["Ada", "Grace", "Linus", "Alan", "Ken", CONJUNCT]);
    runFrames(2);
    const number = container.querySelector(NUMBER_SELECTOR);
    expect(number?.textContent).toBe("6");
    for (let frame = 0; frame < 20; frame += 1) {
      runFrames(1);
      const wheel = rotationOf(container.querySelector("svg g"));
      expect(rotationOf(number)).toBeCloseTo(-wheel, 6);
    }
  });
});

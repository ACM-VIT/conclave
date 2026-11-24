// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WheelStage } from "../../../packages/apps-sdk/src/apps/wheel/web/components/WheelStage";

const CONJUNCT = String.fromCharCode(0x915) + String.fromCharCode(0x94d, 0x915).repeat(23);
const NUMBER_SELECTOR = "[data-wheel-number]";

let root: Root;
let container: HTMLDivElement;
let frames: FrameRequestCallback[];
let now: number;

const entriesOf = (labels: string[]) => labels.map((label, index) => ({ id: `entry-${index}`, label }));

const renderStage = (labels: string[]) => {
  act(() => {
    root.render(
      <WheelStage
        entries={entriesOf(labels)}
        spin={null}
        canSpin
        sounds={null}
        reducedMotion={false}
        highlightIndex={null}
        onRequestSpin={() => {}}
        onSettled={() => {}}
        onSpinningChange={() => {}}
        onPointerLabel={() => {}}
      />
    );
  });
};

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

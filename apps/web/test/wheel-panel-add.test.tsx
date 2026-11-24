// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WheelPanel } from "../../../packages/apps-sdk/src/apps/wheel/web/components/WheelPanel";

let root: Root;
let container: HTMLDivElement;

const renderPanel = (onAddEntries: (labels: string[]) => number) => {
  act(() => {
    root.render(
      <WheelPanel
        fill
        entries={[{ id: "ada", label: "Ada" }]}
        history={[]}
        canEdit
        locked={false}
        isAdmin
        isSpinning={false}
        soundOn={false}
        removeWinnerOnDone={false}
        missingParticipantCount={0}
        onToggleSound={() => {}}
        onAddEntries={onAddEntries}
        onAddParticipants={() => {}}
        onRemoveEntry={() => {}}
        onShuffle={() => {}}
        onSort={() => {}}
        onClearEntries={() => {}}
        onClearHistory={() => {}}
        onToggleRemoveWinner={() => {}}
      />
    );
  });
};

const typeAndSubmit = (text: string): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>("input[data-wheel-add]")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  return input;
};

const typeThenPaste = (typed: string, pasted: string): { input: HTMLInputElement; event: Event } => {
  const input = container.querySelector<HTMLInputElement>("input[data-wheel-add]")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, typed);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => pasted } });
  act(() => {
    input.dispatchEvent(event);
  });
  return { input, event };
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

describe("wheel names box", () => {
  it("keeps the typed text when the wheel added nothing", () => {
    const add = vi.fn(() => 0);
    renderPanel(add);
    const input = typeAndSubmit("\u200B\u200F");
    expect(add).toHaveBeenCalledWith(["\u200B\u200F"]);
    expect(input.value).toBe("\u200B\u200F");
  });

  it("adds a pasted list line by line and keeps the typed text when the wheel added none of it", () => {
    const add = vi.fn(() => 0);
    renderPanel(add);
    const { input, event } = typeThenPaste("Gr", " Ben \r\n\nCy\n");
    expect(add).toHaveBeenCalledWith(["Ben", "Cy"]);
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("Gr");
  });

  it("clears the box once a pasted list was added", () => {
    const add = vi.fn(() => 2);
    renderPanel(add);
    const { input } = typeThenPaste("Gr", "Ben\nCy");
    expect(add).toHaveBeenCalledWith(["Ben", "Cy"]);
    expect(input.value).toBe("");
  });

  it("leaves a one line paste to the box", () => {
    const add = vi.fn(() => 1);
    renderPanel(add);
    const { event } = typeThenPaste("Gr", "Ben\n");
    expect(add).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("clears the box once the name was added", () => {
    const add = vi.fn(() => 1);
    renderPanel(add);
    const input = typeAndSubmit("Grace");
    expect(add).toHaveBeenCalledWith(["Grace"]);
    expect(input.value).toBe("");
  });
});

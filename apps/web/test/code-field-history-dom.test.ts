// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { applyFieldEdit, trackFieldHistory } from "../src/app/lib/utils";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

const trackedField = (value: string) => {
  const input = document.createElement("input");
  input.value = value;
  document.body.append(input);
  input.focus();
  cleanups.push(trackFieldHistory(input));
  return input;
};

const browserStep = (input: HTMLInputElement, inputType: string, value: string) => {
  input.value = value;
  input.setSelectionRange(0, value.length);
  input.dispatchEvent(new InputEvent("input", { inputType, bubbles: true }));
};

const selectionOf = (input: HTMLInputElement) => [
  input.selectionStart,
  input.selectionEnd,
  input.selectionDirection,
];

describe("the code field after the browser undoes or redoes an edit", () => {
  it("puts back the selection the user had, direction included", () => {
    const input = trackedField("abc-def");
    input.setSelectionRange(2, 5, "backward");
    applyFieldEdit(input, { start: 0, end: 7, text: "new-room" });
    expect(input.value).toBe("new-room");
    browserStep(input, "historyUndo", "abc-def");
    expect(selectionOf(input)).toEqual([2, 5, "backward"]);
    browserStep(input, "historyRedo", "new-room");
    expect(selectionOf(input).slice(0, 2)).toEqual([8, 8]);
  });

  it("walks back through several edits by position", () => {
    const input = trackedField("abc-def");
    input.setSelectionRange(2, 2);
    applyFieldEdit(input, { start: 0, end: 7, text: "new-room" });
    applyFieldEdit(input, { start: 0, end: 8, text: "abc-def" });
    input.setSelectionRange(7, 7);
    applyFieldEdit(input, { start: 0, end: 7, text: "new-room" });
    browserStep(input, "historyUndo", "abc-def");
    expect(selectionOf(input).slice(0, 2)).toEqual([7, 7]);
    browserStep(input, "historyUndo", "new-room");
    expect(selectionOf(input).slice(0, 2)).toEqual([8, 8]);
    browserStep(input, "historyUndo", "abc-def");
    expect(selectionOf(input).slice(0, 2)).toEqual([2, 2]);
  });

  it("leaves the browser's selection alone when its step is not the one recorded", () => {
    const input = trackedField("abc-def");
    input.setSelectionRange(2, 2);
    applyFieldEdit(input, { start: 0, end: 7, text: "new-room" });
    browserStep(input, "historyUndo", "something-else");
    expect(selectionOf(input).slice(0, 2)).toEqual([0, 14]);
  });
});

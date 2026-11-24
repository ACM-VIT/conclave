import { describe, expect, it } from "vitest";
import {
  ROOM_CODE_MAX_LENGTH,
  inputEditRange,
  planFieldEdit,
  sanitizeRoomCodeInput,
  selectionAfterHistory,
  type FieldEdit,
  type FieldEditRecord,
} from "../src/app/lib/utils";

const plan = (value: string, start: number, end: number, text: string) =>
  planFieldEdit(value, start, end, text, sanitizeRoomCodeInput, ROOM_CODE_MAX_LENGTH);

const applied = (value: string, edit: FieldEdit) =>
  value.slice(0, edit.start) + edit.text + value.slice(edit.end);

const seededRandom = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

describe("planning an edit to the join code field", () => {
  it("replaces the whole field with a pasted link's code as one edit", () => {
    expect(plan("my-room", 0, 7, "second-room")).toEqual({ start: 0, end: 7, text: "second-room" });
    expect(plan("", 0, 0, "second-room")).toEqual({ start: 0, end: 0, text: "second-room" });
    expect(plan("room-one", 0, 8, "room-two")).toEqual({ start: 0, end: 8, text: "room-two" });
  });

  it("drops a hyphen that would double up with the one next to it", () => {
    expect(plan("abc-def", 4, 4, "-wxyz")).toEqual({ start: 4, end: 4, text: "wxyz" });
    expect(plan("abc-def", 3, 3, "x-")).toEqual({ start: 3, end: 3, text: "x" });
    expect(plan("abc-def", 4, 4, "-")).toEqual({ start: 4, end: 4, text: "" });
    expect(plan("", 0, 0, "-")).toEqual({ start: 0, end: 0, text: "" });
  });

  it("lowercases and joins typed text where it lands", () => {
    expect(plan("abc-def", 2, 2, "X")).toEqual({ start: 2, end: 2, text: "x" });
    expect(plan("abc", 3, 3, " ")).toEqual({ start: 3, end: 3, text: "-" });
  });

  it("widens a deletion that would leave two hyphens side by side", () => {
    expect(plan("abc-x-def", 4, 5, "")).toEqual({ start: 4, end: 6, text: "" });
    expect(plan("abc-def", 0, 3, "")).toEqual({ start: 0, end: 4, text: "" });
  });

  it("keeps the field within its length cap", () => {
    const nearlyFull = `${"a".repeat(30)}-${"b".repeat(31)}`;
    expect(plan(nearlyFull, 30, 30, "wxyz")).toEqual({ start: 30, end: 30, text: "wx" });
    expect(plan("a".repeat(ROOM_CODE_MAX_LENGTH), 10, 10, "b")).toEqual({ start: 10, end: 10, text: "" });
  });

  it("always plans one edit that covers the selection and leaves a final value", () => {
    const random = seededRandom(318);
    const pickText = (alphabet: string, max: number) => {
      let text = "";
      const length = Math.floor(random() * (max + 1));
      for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(random() * alphabet.length)];
      return text;
    };
    const failures: string[] = [];
    let takeOvers = 0;
    for (let run = 0; run < 20_000; run += 1) {
      const value = sanitizeRoomCodeInput(pickText("ab-", random() < 0.1 ? 70 : 10));
      const start = Math.floor(random() * (value.length + 1));
      const end = start + Math.floor(random() * (value.length - start + 1));
      const text = pickText("aB- 1", 4);
      const edit = plan(value, start, end, text);
      const fits = text.slice(0, ROOM_CODE_MAX_LENGTH - (value.length - (end - start)));
      const naive = value.slice(0, start) + fits + value.slice(end);
      const result = applied(value, edit);
      const native = edit.start === start && edit.end === end && edit.text === text;
      if (!native) takeOvers += 1;
      const ok =
        edit.start <= start &&
        edit.end >= end &&
        result === sanitizeRoomCodeInput(naive) &&
        sanitizeRoomCodeInput(result) === result &&
        native === (fits === text && sanitizeRoomCodeInput(naive) === naive) &&
        JSON.stringify(plan(value, edit.start, edit.end, edit.text)) === JSON.stringify(edit);
      if (!ok) failures.push(JSON.stringify({ value, start, end, text, edit }));
    }
    expect(failures).toEqual([]);
    expect(takeOvers).toBeGreaterThan(2_000);
  });
});

describe("the range a browser edit touches", () => {
  it("is the selection for typed text and any deletion over a selection", () => {
    expect(inputEditRange("insertText", 2, 2, 7)).toEqual([2, 2]);
    expect(inputEditRange("insertText", 2, 5, 7)).toEqual([2, 5]);
    expect(inputEditRange("deleteContentBackward", 2, 5, 7)).toEqual([2, 5]);
    expect(inputEditRange("deleteContentForward", 2, 5, 7)).toEqual([2, 5]);
  });

  it("is one character either side of the caret for Backspace and Delete", () => {
    expect(inputEditRange("deleteContentBackward", 3, 3, 7)).toEqual([2, 3]);
    expect(inputEditRange("deleteContentBackward", 0, 0, 7)).toEqual([0, 0]);
    expect(inputEditRange("deleteContentForward", 3, 3, 7)).toEqual([3, 4]);
    expect(inputEditRange("deleteContentForward", 7, 7, 7)).toEqual([7, 7]);
  });

  it("leaves other edits to the browser", () => {
    expect(inputEditRange("deleteWordBackward", 3, 3, 7)).toBeNull();
    expect(inputEditRange("insertFromPaste", 3, 3, 7)).toBeNull();
    expect(inputEditRange("insertCompositionText", 3, 3, 7)).toBeNull();
    expect(inputEditRange("historyUndo", 3, 3, 7)).toBeNull();
  });
});

describe("the selection after undoing or redoing an edit the field made itself", () => {
  const linkPaste: FieldEditRecord = { before: "abc-def", after: "new-room", selection: [2, 2], caret: 8 };
  const hyphenJoin: FieldEditRecord = { before: "abc-x-def", after: "abc-def", selection: [5, 5], caret: 4 };

  it("puts back the selection the user had before the edit on undo", () => {
    expect(selectionAfterHistory([linkPaste], "historyUndo", "new-room", "abc-def")).toEqual([2, 2]);
    expect(selectionAfterHistory([hyphenJoin], "historyUndo", "abc-def", "abc-x-def")).toEqual([5, 5]);
  });

  it("puts the caret after the edit on redo", () => {
    expect(selectionAfterHistory([linkPaste], "historyRedo", "abc-def", "new-room")).toEqual([8, 8]);
  });

  it("uses the latest matching edit", () => {
    const again: FieldEditRecord = { ...linkPaste, selection: [7, 7] };
    expect(selectionAfterHistory([linkPaste, again], "historyUndo", "new-room", "abc-def")).toEqual([7, 7]);
  });

  it("leaves the browser's selection for edits the browser made", () => {
    expect(selectionAfterHistory([linkPaste], "historyUndo", "new-roomx", "new-room")).toBeNull();
    expect(selectionAfterHistory([linkPaste], "insertText", "new-room", "abc-def")).toBeNull();
    expect(selectionAfterHistory([], "historyUndo", "new-room", "abc-def")).toBeNull();
  });
});

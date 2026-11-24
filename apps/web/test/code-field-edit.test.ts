import { describe, expect, it } from "vitest";
import {
  ROOM_CODE_MAX_LENGTH,
  inputEditRange,
  FieldHistory,
  planFieldEdit,
  sanitizeRoomCodeInput,
  type FieldEdit,
  type FieldState,
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

const at = (value: string, start: number, end = start): FieldState => ({ value, selection: [start, end] });

class ReferenceHistory {
  private past: { before: FieldState; after: FieldState }[] = [];
  private future: { before: FieldState; after: FieldState }[] = [];
  private open = false;

  record(before: FieldState, after: FieldState, typing: boolean) {
    this.future = [];
    const last = this.past[this.past.length - 1];
    const joins = typing && this.open && last && JSON.stringify(last.after) === JSON.stringify(before);
    if (joins) last.after = after;
    else this.past.push({ before, after });
    this.open = typing;
  }

  undo() {
    const step = this.past.pop();
    if (!step) return null;
    this.future.push(step);
    this.open = false;
    return step.before;
  }

  redo() {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push(step);
    this.open = false;
    return step.after;
  }
}

describe("the code field's own undo history", () => {
  it("walks back through edits by position, not by matching values", () => {
    const history = new FieldHistory();
    history.record(at("abc-def", 2), at("new-room", 8), false);
    history.record(at("new-room", 8), at("abc-def", 7), false);
    history.record(at("abc-def", 7), at("new-room", 8), false);
    expect(history.undo()).toEqual(at("abc-def", 7));
    expect(history.undo()).toEqual(at("new-room", 8));
    expect(history.undo()).toEqual(at("abc-def", 2));
    expect(history.undo()).toBeNull();
    expect(history.redo()).toEqual(at("new-room", 8));
    expect(history.redo()).toEqual(at("abc-def", 7));
    expect(history.redo()).toEqual(at("new-room", 8));
    expect(history.redo()).toBeNull();
  });

  it("merges a run of typing into one step and starts a new one after anything else", () => {
    const history = new FieldHistory();
    history.record(at("", 0), at("a", 1), true);
    history.record(at("a", 1), at("ab", 2), true);
    history.record(at("ab", 2), at("abx", 3), false);
    history.record(at("abx", 3), at("abxc", 4), true);
    history.record(at("abxc", 1), at("aybxc", 2), true);
    expect(history.undo()).toEqual(at("abxc", 1));
    expect(history.undo()).toEqual(at("abx", 3));
    expect(history.undo()).toEqual(at("ab", 2));
    expect(history.undo()).toEqual(at("", 0));
  });

  it("drops the redo branch when a new edit follows an undo", () => {
    const history = new FieldHistory();
    history.record(at("", 0), at("abc", 3), true);
    history.record(at("abc", 3), at("room", 4), false);
    history.undo();
    history.record(at("abc", 3), at("abcd", 4), true);
    expect(history.redo()).toBeNull();
    expect(history.undo()).toEqual(at("abc", 3));
    expect(history.undo()).toEqual(at("", 0));
  });

  it("matches a reference model over random paste, type, delete, caret, undo and redo steps", () => {
    const random = seededRandom(4675657343 % 2147483647);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const failures: string[] = [];
    let undos = 0;
    for (let run = 0; run < 300; run += 1) {
      const history = new FieldHistory();
      const reference = new ReferenceHistory();
      let field = at("", 0);
      const edit = (start: number, end: number, text: string, replace: boolean) => {
        const [from, to] = replace ? [0, field.value.length] : [start, end];
        const planned = plan(field.value, from, to, text);
        if (planned.start === planned.end && !planned.text) return;
        const native = !replace && planned.start === from && planned.end === to && planned.text === text;
        const caret = planned.start + planned.text.length;
        const next = at(applied(field.value, planned), caret);
        const typing = native && text.length === 1;
        history.record(field, next, typing);
        reference.record(field, next, typing);
        field = next;
      };
      for (let step = 0; step < 40; step += 1) {
        const [start, end] = field.selection;
        const op = pick(["type", "type", "type", "paste", "link", "delete", "caret", "select", "undo", "undo", "redo"]);
        if (op === "type") edit(start, end, pick(["a", "b", "-", "X", " "]), false);
        if (op === "paste") edit(start, end, pick(["new-room", "abc-def", "-wxyz", "x-"]), false);
        if (op === "link") edit(start, end, pick(["new-room", "abc-def", "room-two"]), true);
        if (op === "delete") {
          const from = start === end ? Math.max(0, start - 1) : start;
          edit(from, end, "", false);
        }
        if (op === "caret") {
          const caret = Math.floor(random() * (field.value.length + 1));
          field = at(field.value, caret);
        }
        if (op === "select") {
          const a = Math.floor(random() * (field.value.length + 1));
          const b = a + Math.floor(random() * (field.value.length - a + 1));
          field = at(field.value, a, b);
        }
        if (op === "undo" || op === "redo") {
          const got = op === "undo" ? history.undo() : history.redo();
          const want = op === "undo" ? reference.undo() : reference.redo();
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            failures.push(JSON.stringify({ run, step, op, got, want }));
            break;
          }
          if (got) {
            field = got;
            if (op === "undo") undos += 1;
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(undos).toBeGreaterThan(1000);
  });
});

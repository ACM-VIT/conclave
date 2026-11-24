import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  MAX_WHEEL_ENTRIES,
  addEntries,
  createWheelDoc,
  getEntries,
  getHistory,
  getSpin,
  type WheelSpin,
} from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";

const validSpin = (): WheelSpin => ({
  spinId: "spin-1",
  entries: [
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
  ],
  winnerIndex: 0,
  startedAt: Date.now(),
  durationMs: 8_000,
  turns: 8,
  jitter: 0.5,
  spunById: "user-1",
  spunByName: "Host",
});

describe("wheel document validation", () => {
  it("rejects oversized spin snapshots", () => {
    const doc = createWheelDoc();
    doc.getMap("wheel").set("spin", {
      ...validSpin(),
      entries: Array.from({ length: MAX_WHEEL_ENTRIES + 1 }, (_, index) => ({
        id: `entry-${index}`,
        label: `Entry ${index}`,
      })),
    });

    expect(getSpin(doc)).toBeNull();
  });

  it.each([
    { durationMs: Number.POSITIVE_INFINITY },
    { durationMs: 60_000 },
    { turns: Number.POSITIVE_INFINITY },
    { turns: 100 },
    { jitter: -1 },
    { jitter: 2 },
  ])("rejects unsafe animation parameters: %o", (override) => {
    const doc = createWheelDoc();
    doc.getMap("wheel").set("spin", { ...validSpin(), ...override });

    expect(getSpin(doc)).toBeNull();
  });

  it("drops entries with oversized labels", () => {
    const doc = createWheelDoc();
    const wheelEntries = new Y.Array<unknown>();
    doc.getMap("wheel").set("entries", wheelEntries);
    wheelEntries.push([
      { id: "valid", label: "Valid" },
      { id: "long", label: "x".repeat(200) },
    ]);

    expect(getEntries(doc)).toEqual([{ id: "valid", label: "Valid" }]);
  });

  it("reads remote labels the way it writes them, without stray whitespace", () => {
    const doc = createWheelDoc();
    const wheelEntries = new Y.Array<unknown>();
    doc.getMap("wheel").set("entries", wheelEntries);
    wheelEntries.push([
      { id: "spaced", label: "      Bob" },
      { id: "inner", label: "Ann \n  Lee  " },
    ]);
    doc.getMap("wheel").set("spin", {
      ...validSpin(),
      entries: [
        { id: "one", label: "   One" },
        { id: "two", label: "Two" },
      ],
    });

    expect(getEntries(doc)).toEqual([
      { id: "spaced", label: "Bob" },
      { id: "inner", label: "Ann Lee" },
    ]);
    expect(getSpin(doc)?.entries).toEqual([
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ]);
    expect(getSpin(doc)).toBe(getSpin(doc));
  });
});

describe("wheel label visibility", () => {
  const INVISIBLE = [
    "\u200B",
    "\u200D",
    "\u200F",
    "\u200E",
    "\u200B\u200F",
    "\u0301",
    "\u0301\u0308",
    "\u00A0",
    "\u2003",
    "\u3000",
    " \t\n ",
    "\uFE0F",
    "\u3164",
    "\u2800",
    "\u034F",
    "\u2060",
    "\u00AD",
    "\u0007",
    "\u200B \u200F \u2060",
  ];
  const VISIBLE: [string, string][] = [
    ["A\u200B", "A\u200B"],
    ["\u200F\u0645\u062D\u0645\u062F", "\u200F\u0645\u062D\u0645\u062F"],
    ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["\u2764\uFE0F", "\u2764\uFE0F"],
    ["Rene\u0301e", "Rene\u0301e"],
    ["\u0915\u094D\u0937", "\u0915\u094D\u0937"],
    ["\u0600\u0661", "\u0600\u0661"],
    ["Bob\u0007", "Bob"],
    ["  Ann \t Lee ", "Ann Lee"],
  ];

  it("never accepts a typed label with nothing visible in it", () => {
    const doc = createWheelDoc();
    expect(addEntries(doc, INVISIBLE)).toBe(0);
    expect(getEntries(doc)).toEqual([]);
  });

  it("keeps odd labels that do show something", () => {
    const doc = createWheelDoc();
    expect(addEntries(doc, VISIBLE.map(([typed]) => typed))).toBe(VISIBLE.length);
    expect(getEntries(doc).map((entry) => entry.label)).toEqual(VISIBLE.map(([, shown]) => shown));
  });

  it("drops invisible labels another client wrote, from entries, spins and history", () => {
    const doc = createWheelDoc();
    const wheel = doc.getMap("wheel");
    const entries = new Y.Array<unknown>();
    wheel.set("entries", entries);
    entries.push([{ id: "ada", label: "Ada" }, ...INVISIBLE.map((label, index) => ({ id: `blank-${index}`, label }))]);
    expect(getEntries(doc)).toEqual([{ id: "ada", label: "Ada" }]);

    wheel.set("spin", {
      ...validSpin(),
      entries: [
        { id: "one", label: "One" },
        { id: "blank", label: "\u200B\u200F" },
      ],
    });
    expect(getSpin(doc)).toBeNull();

    const history = new Y.Array<unknown>();
    wheel.set("history", history);
    history.push([
      { spinId: "s1", label: "\u200B\u200F", at: 1, byName: "Host" },
      { spinId: "s2", label: "Ada", at: 2, byName: "Host" },
    ]);
    expect(getHistory(doc).map((result) => result.label)).toEqual(["Ada"]);
  });
});

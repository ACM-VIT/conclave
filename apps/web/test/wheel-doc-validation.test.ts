import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  MAX_WHEEL_ENTRIES,
  addEntries,
  clearEntries,
  createWheelDoc,
  getEntries,
  getHistory,
  getSpin,
  normalizeLabel,
  recordResult,
  removeEntryById,
  replaceEntries,
  startSpin,
  type WheelEntry,
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

describe("wheel accepted list", () => {
  const HIDDEN = ["\u200B", "\u200B\u200F", "\u2060", " ", "\u0301"];
  const rawArray = (doc: Y.Doc, key: string): unknown[] => {
    const value = doc.getMap("wheel").get(key);
    return value instanceof Y.Array ? value.toArray() : [];
  };

  it("counts room from the names the wheel shows and prunes hidden ones in the same write", () => {
    const doc = createWheelDoc();
    const entries = new Y.Array<unknown>();
    doc.getMap("wheel").set("entries", entries);
    entries.push([
      ...Array.from({ length: 63 }, (_, index) => ({ id: `name-${index}`, label: `Name ${index + 1}` })),
      { id: "hidden", label: "\u200B" },
    ]);
    expect(getEntries(doc)).toHaveLength(63);
    expect(addEntries(doc, ["New"])).toBe(1);
    expect(getEntries(doc).map((entry) => entry.label).slice(-1)).toEqual(["New"]);
    expect(rawArray(doc, "entries")).toHaveLength(MAX_WHEEL_ENTRIES);
  });

  it("keeps counts, positions, spins and history on one accepted list for any stored mix", () => {
    let seed = 20261124;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const visibleName = () => ["Ada", "Bo", " Cy ", "D\u0007e", "\u{1F600}", "\u0915\u094D\u0937"][random(6)] + random(1000);
    const anyName = () => (random(3) === 0 ? HIDDEN[random(HIDDEN.length)] : visibleName());
    const record = (index: number): unknown => {
      switch (random(6)) {
        case 0:
          return { id: `hidden-${index}`, label: HIDDEN[random(HIDDEN.length)] };
        case 1:
          return { id: `entry-${random(Math.max(1, index))}`, label: visibleName() };
        case 2:
          return { id: `long-${index}`, label: "x".repeat(60) };
        case 3:
          return [null, 7, ["x"], { id: 3, label: "Bad" }][random(4)];
        default:
          return { id: `entry-${index}`, label: visibleName() };
      }
    };
    const spinOf = (entries: WheelEntry[], spinId: string): WheelSpin => ({
      ...validSpin(),
      spinId,
      entries,
      winnerIndex: random(entries.length),
    });

    for (let run = 0; run < 300; run += 1) {
      const doc = createWheelDoc();
      const wheel = doc.getMap("wheel");
      const entries = new Y.Array<unknown>();
      wheel.set("entries", entries);
      entries.push(Array.from({ length: random(90) }, (_, index) => record(index)));
      const history = new Y.Array<unknown>();
      wheel.set("history", history);
      history.push(
        Array.from({ length: random(40) }, (_, index) => ({
          spinId: `old-${random(20)}`,
          label: random(3) === 0 ? HIDDEN[random(HIDDEN.length)] : `Old ${index}`,
          at: index,
          byName: "Host",
        }))
      );

      for (let step = 0; step < 12; step += 1) {
        const before = getEntries(doc);
        const where = `run ${run} step ${step}`;
        switch (random(6)) {
          case 0: {
            const labels = Array.from({ length: random(6) }, anyName);
            const visible = labels.map(normalizeLabel).filter((label) => label.length > 0);
            const room = MAX_WHEEL_ENTRIES - before.length;
            expect(addEntries(doc, labels), where).toBe(Math.min(visible.length, Math.max(0, room)));
            const after = getEntries(doc);
            expect(after.slice(0, before.length), where).toEqual(before);
            expect(after.slice(before.length).map((entry) => entry.label), where).toEqual(visible.slice(0, Math.max(0, room)));
            if (visible.length > 0) expect(rawArray(doc, "entries"), where).toHaveLength(after.length);
            break;
          }
          case 1: {
            const target = before.length > 0 && random(4) > 0 ? before[random(before.length)].id : "missing";
            removeEntryById(doc, target);
            expect(getEntries(doc), where).toEqual(before.filter((entry) => entry.id !== target));
            expect(rawArray(doc, "entries"), where).toHaveLength(getEntries(doc).length);
            break;
          }
          case 2: {
            const shuffled = [...before].sort(() => random(3) - 1);
            replaceEntries(doc, shuffled);
            expect(getEntries(doc), where).toEqual(shuffled);
            expect(rawArray(doc, "entries"), where).toHaveLength(shuffled.length);
            break;
          }
          case 3: {
            if (before.length === 0) break;
            const spin = spinOf(before, `spin-${run}-${step}`);
            startSpin(doc, spin);
            const stored = getSpin(doc);
            expect(stored?.entries, where).toEqual(before);
            const winner = stored!.entries[stored!.winnerIndex];
            recordResult(doc, { spinId: spin.spinId, label: winner.label, at: step, byName: "Host" });
            const results = getHistory(doc);
            expect(results[0], where).toMatchObject({ spinId: spin.spinId, label: winner.label });
            expect(results.length, where).toBeLessThanOrEqual(25);
            expect(new Set(results.map((result) => result.spinId)).size, where).toBe(results.length);
            expect(rawArray(doc, "history"), where).toHaveLength(results.length);
            break;
          }
          case 4: {
            if (random(4) > 0) break;
            clearEntries(doc);
            expect(getEntries(doc), where).toEqual([]);
            break;
          }
          default:
            break;
        }
        const shown = getEntries(doc);
        expect(shown.length, where).toBeLessThanOrEqual(MAX_WHEEL_ENTRIES);
        expect(new Set(shown.map((entry) => entry.id)).size, where).toBe(shown.length);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  MAX_WHEEL_ENTRIES,
  addEntries,
  clearEntries,
  createWheelDoc,
  getEntries,
  removeEntryById,
  replaceEntries,
} from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";

const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

const settle = (docs: Y.Doc[]) => {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const from of docs) for (const to of docs) if (from !== to) sync(from, to);
  }
};

const replicaOf = (doc: Y.Doc): Y.Doc => {
  const replica = createWheelDoc();
  sync(doc, replica);
  return replica;
};

const rows = (doc: Y.Doc): Y.Array<unknown> => doc.getMap("wheel").get("entries") as Y.Array<unknown>;

const stored = (doc: Y.Doc): string[] => (rows(doc).toArray() as { label: string }[]).map((row) => row.label);

const shown = (doc: Y.Doc): string[] => getEntries(doc).map((entry) => entry.label);

const named = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

const idOf = (doc: Y.Doc, label: string): string => getEntries(doc).find((entry) => entry.label === label)!.id;

describe("wheel cap with several editors", () => {
  it("removes exactly the one name asked for after two editors each added the last name", () => {
    const base = createWheelDoc();
    addEntries(base, named("N", 63));
    const ada = replicaOf(base);
    const ben = replicaOf(base);
    expect(addEntries(ada, ["Ada"])).toBe(1);
    expect(addEntries(ben, ["Ben"])).toBe(1);
    settle([ada, ben]);
    expect(shown(ada)).toHaveLength(MAX_WHEEL_ENTRIES);
    expect(shown(ben)).toEqual(shown(ada));

    removeEntryById(ada, idOf(ada, "N1"));
    settle([ada, ben]);

    for (const doc of [ada, ben, replicaOf(ada)]) {
      expect(shown(doc)).toHaveLength(MAX_WHEEL_ENTRIES);
      expect(shown(doc)).not.toContain("N1");
      expect(shown(doc).slice(-2).sort()).toEqual(["Ada", "Ben"]);
    }
  });

  it("keeps every name two pastes added past the cap and shows each one as a place frees up", () => {
    const base = createWheelDoc();
    addEntries(base, named("N", 30));
    const ada = replicaOf(base);
    const ben = replicaOf(base);
    expect(addEntries(ada, named("A", 34))).toBe(34);
    expect(addEntries(ben, named("B", 34))).toBe(34);
    settle([ada, ben]);
    const everyone = [...stored(ada)].sort();
    expect(everyone).toEqual([...named("N", 30), ...named("A", 34), ...named("B", 34)].sort());
    expect(shown(ada)).toEqual(stored(ada).slice(0, MAX_WHEEL_ENTRIES));

    const removed: string[] = [];
    for (let round = 0; round < 40; round += 1) {
      const editor = round % 2 === 0 ? ada : ben;
      const label = shown(editor)[(round * 7) % shown(editor).length];
      removeEntryById(editor, idOf(editor, label));
      removed.push(label);
      settle([ada, ben]);
      const left = everyone.filter((name) => !removed.includes(name));
      expect([...stored(ada)].sort(), `round ${round}`).toEqual(left);
      expect(shown(ada), `round ${round}`).toEqual(stored(ada).slice(0, MAX_WHEEL_ENTRIES));
      expect(shown(ben), `round ${round}`).toEqual(shown(ada));
    }
    expect(stored(ada)).toHaveLength(58);
    expect(shown(ada)).toHaveLength(58);
  });

  it("takes no new name while accepted names still wait for a place", () => {
    const base = createWheelDoc();
    addEntries(base, named("N", 63));
    const ada = replicaOf(base);
    const ben = replicaOf(base);
    addEntries(ada, ["Ada"]);
    addEntries(ben, ["Ben"]);
    settle([ada, ben]);
    expect(addEntries(ada, ["Late"])).toBe(0);
    removeEntryById(ada, idOf(ada, "N1"));
    expect(addEntries(ada, ["Late"])).toBe(0);
    removeEntryById(ada, idOf(ada, "N2"));
    expect(addEntries(ada, ["Late"])).toBe(1);
    expect(shown(ada).slice(-3).sort()).toEqual(["Ada", "Ben", "Late"]);
  });

  it("keeps the names that wait when someone sorts or shuffles", () => {
    for (const change of ["sort", "shuffle"] as const) {
      const base = createWheelDoc();
      addEntries(base, named("N", 62));
      const ada = replicaOf(base);
      const ben = replicaOf(base);
      addEntries(ada, ["Ada", "Ann"]);
      addEntries(ben, ["Ben", "Bea"]);
      settle([ada, ben]);
      const everyone = [...stored(ada)].sort();
      expect(everyone).toHaveLength(66);

      const current = getEntries(ada);
      replaceEntries(ada, change === "sort" ? [...current].sort((a, b) => a.label.localeCompare(b.label)) : [...current].reverse());
      settle([ada, ben]);

      expect([...stored(ben)].sort(), change).toEqual(everyone);
      expect(shown(ben), change).toHaveLength(MAX_WHEEL_ENTRIES);
      expect(shown(ben), change).toEqual(shown(ada));
    }
  });

  it("still drops rows nobody can ever see, and never counts them", () => {
    const doc = createWheelDoc();
    addEntries(doc, named("N", 64));
    const first = getEntries(doc)[0];
    rows(doc).push([
      { id: "hidden", label: "​" },
      { id: first.id, label: "Twin" },
      null,
      { id: "wait-1", label: "Waiting 1" },
      { id: "wait-2", label: "Waiting 2" },
    ]);
    expect(shown(doc)).toEqual(named("N", 64));
    expect(addEntries(doc, ["Late"])).toBe(0);

    removeEntryById(doc, first.id);

    expect(stored(doc)).toEqual([...named("N", 64).slice(1), "Waiting 1", "Waiting 2"]);
    expect(shown(doc)).toEqual([...named("N", 64).slice(1), "Waiting 1"]);
  });

  it("clears the names that wait along with the rest", () => {
    const base = createWheelDoc();
    addEntries(base, named("N", 63));
    const ada = replicaOf(base);
    const ben = replicaOf(base);
    addEntries(ada, ["Ada"]);
    addEntries(ben, ["Ben"]);
    settle([ada, ben]);
    clearEntries(ada);
    settle([ada, ben]);
    expect(stored(ben)).toEqual([]);
    expect(addEntries(ben, ["Next"])).toBe(1);
  });

  it("never loses an accepted name and never removes more than the one asked for, for any order of edits by three editors", { timeout: 30_000 }, () => {
    let seed = 20261127;
    const random = (limit: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
    for (let run = 0; run < 40; run += 1) {
      const base = createWheelDoc();
      const on = new Set<string>(named(`r${run}-seed-`, 40 + random(24)));
      addEntries(base, [...on]);
      const editors = [replicaOf(base), replicaOf(base), replicaOf(base)];
      let made = 0;
      for (let step = 0; step < 80; step += 1) {
        const where = `run ${run} step ${step}`;
        const doc = editors[random(editors.length)];
        switch (random(6)) {
          case 0:
          case 1: {
            const labels = Array.from({ length: 1 + random(5) }, () => `r${run}-n${(made += 1)}`);
            const before = stored(doc);
            const room = Math.max(0, MAX_WHEEL_ENTRIES - before.length);
            const count = addEntries(doc, labels);
            expect(count, where).toBe(Math.min(labels.length, room));
            for (const label of labels.slice(0, count)) on.add(label);
            expect(stored(doc), where).toEqual([...before, ...labels.slice(0, count)]);
            break;
          }
          case 2: {
            const visible = getEntries(doc);
            if (visible.length === 0) break;
            const target = visible[random(visible.length)];
            const before = stored(doc);
            removeEntryById(doc, target.id);
            on.delete(target.label);
            expect(stored(doc), where).toEqual(before.filter((label) => label !== target.label));
            break;
          }
          case 3: {
            settle(editors);
            const before = [...stored(doc)].sort();
            const current = getEntries(doc);
            replaceEntries(doc, random(2) === 0 ? [...current].reverse() : [...current].sort((a, b) => a.label.localeCompare(b.label)));
            expect([...stored(doc)].sort(), where).toEqual(before);
            settle(editors);
            break;
          }
          default: {
            const other = editors[random(editors.length)];
            if (other !== doc) sync(doc, other);
            break;
          }
        }
        expect(shown(doc), where).toEqual(stored(doc).slice(0, MAX_WHEEL_ENTRIES));
      }
      settle(editors);
      for (const doc of [...editors, replicaOf(editors[0])]) {
        expect([...stored(doc)].sort(), `run ${run}`).toEqual([...on].sort());
        expect(stored(doc), `run ${run}`).toEqual(stored(editors[0]));
        expect(shown(doc), `run ${run}`).toEqual(stored(doc).slice(0, MAX_WHEEL_ENTRIES));
      }
    }
  });
});

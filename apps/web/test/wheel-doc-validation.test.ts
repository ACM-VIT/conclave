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
  slotLabel,
  startSpin,
  type WheelEntry,
  type WheelSpin,
} from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import {
  NATIVE_EMBED_ORIGINS,
  decodeEmbedMessage,
  decodeHostMessage,
  encodeEnvelope,
  isValidIdentifier,
} from "../../../packages/apps-sdk/src/native-embed/protocol";

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const SURROGATE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i;
const SCOPE = { callSessionId: "call-7-3f2a9c1e", appSessionId: "app-5b1d7a2e", appId: "wheel" };
const HALF_EMOJI = "A".repeat(47) + "\uD83C";

const wheelStatus = (label: string) => ({
  kind: "wheel",
  entries: [{ id: "e0", label }],
  results: [],
  removeWinner: false,
  sounds: true,
  spinning: false,
  winnerSpinId: "",
  winnerLabel: "",
});

const sentEnvelope = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, type, callSessionId: SCOPE.callSessionId, appSessionId: SCOPE.appSessionId, requestId: "e-1", payload });

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

describe("wheel names never split a character", () => {
  const CLUSTERS = [
    "\u{1F389}",
    "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    "\u{1F1EE}\u{1F1F3}",
    "e\u0301",
    "\u{1F44D}\u{1F3FD}",
    "\u0915\u094D\u0937",
    "\u1100\u1161\u11A8",
  ];

  it("cuts 47 letters and an emoji before the emoji", () => {
    const typed = "A".repeat(47) + "\u{1F389}";
    expect(normalizeLabel(typed)).toBe("A".repeat(47));
    const doc = createWheelDoc();
    expect(addEntries(doc, [typed])).toBe(1);
    expect(getEntries(doc)[0].label).toBe("A".repeat(47));
  });

  it("cuts at every point through emoji, joined emoji, flags and marks without keeping part of one", () => {
    for (const cluster of CLUSTERS) {
      for (let lead = 0; lead <= 48; lead += 1) {
        const label = "A".repeat(lead) + cluster + "Z".repeat(60);
        const fits = lead + cluster.length <= 48;
        const expected = fits ? "A".repeat(lead) + cluster + "Z".repeat(48 - lead - cluster.length) : "A".repeat(lead);
        expect(normalizeLabel(label), `${JSON.stringify(cluster)} after ${lead}`).toBe(expected);
      }
    }
  });

  it("keeps the first code points of one cluster longer than a whole name", () => {
    expect(normalizeLabel("Z" + "\u0301".repeat(60))).toBe("Z" + "\u0301".repeat(47));
  });

  it("reads a document that already holds a lone surrogate as well formed text", () => {
    const doc = createWheelDoc();
    const wheel = doc.getMap("wheel");
    const entries = new Y.Array<unknown>();
    wheel.set("entries", entries);
    entries.push([
      { id: "e0", label: HALF_EMOJI },
      { id: "e1", label: "\uDF89Bo" },
    ]);
    const history = new Y.Array<unknown>();
    wheel.set("history", history);
    history.push([{ spinId: "s1", label: HALF_EMOJI, at: 1, byName: "Host" }]);
    wheel.set("spin", { ...validSpin(), entries: [{ id: "e0", label: HALF_EMOJI }, { id: "two", label: "Two" }] });

    expect(getEntries(doc).map((entry) => entry.label)).toEqual(["A".repeat(47), "Bo"]);
    expect(getHistory(doc).map((result) => result.label)).toEqual(["A".repeat(47)]);
    expect(getSpin(doc)?.entries.map((entry) => entry.label)).toEqual(["A".repeat(47), "Two"]);
  });

  it("lets no lone surrogate cross the Yjs wire, so only the writer's own copy can hold one", () => {
    const writer = createWheelDoc();
    const entries = new Y.Array<unknown>();
    writer.getMap("wheel").set("entries", entries);
    entries.push([{ id: "e0", label: HALF_EMOJI }]);
    const reader = new Y.Doc();
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer));
    const stored = (reader.getMap("wheel").get("entries") as Y.Array<{ label: string }>).get(0).label;
    expect(stored).toBe("A".repeat(47) + "\uFFFD");
  });

  it("never sends a lone surrogate to the native app", () => {
    const raw = encodeEnvelope("status", SCOPE, "e-1", {
      app: { ...wheelStatus("\uDF89Bo"), winnerLabel: HALF_EMOJI },
    });
    expect(raw).not.toMatch(SURROGATE_ESCAPE);
    expect(LONE_SURROGATE.test(raw)).toBe(false);
    const parsed = JSON.parse(raw) as { payload: { app: { winnerLabel: string; entries: { label: string }[] } } };
    expect(parsed.payload.app.winnerLabel).toBe("A".repeat(47));
    expect(parsed.payload.app.entries[0].label).toBe("Bo");
  });

  it("decodes a lone surrogate from the embed the way iOS does and strips one from the host", () => {
    const fromEmbed = sentEnvelope("status", { app: wheelStatus(HALF_EMOJI) });
    expect(fromEmbed).toMatch(SURROGATE_ESCAPE);
    expect(
      decodeEmbedMessage(fromEmbed, SCOPE, NATIVE_EMBED_ORIGINS.ios, NATIVE_EMBED_ORIGINS.ios, true)
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(
      decodeEmbedMessage(sentEnvelope("status", { app: wheelStatus("A".repeat(47)) }), SCOPE, NATIVE_EMBED_ORIGINS.ios, NATIVE_EMBED_ORIGINS.ios, true)
    ).toMatchObject({ ok: true });
    const fromHost = decodeHostMessage(sentEnvelope("status", { readOnly: false, userName: "Gr\uD83Cace" }), SCOPE);
    expect(fromHost.ok && fromHost.envelope.payload.userName).toBe("Grace");
  });
});

describe("wheel spin replay", () => {
  const build63Spin = (entries: unknown[], winnerIndex: number) => ({ ...validSpin(), spinId: "s-63", entries, winnerIndex });

  it("replays a build 63 spin with exactly its slices and numbers the slot it cannot show", () => {
    const doc = createWheelDoc();
    doc.getMap("wheel").set(
      "spin",
      build63Spin([{ id: "a", label: "Ada" }, { id: "b", label: "Bo" }, { id: "z", label: "\u200B" }], 2)
    );
    const spin = getSpin(doc)!;
    expect(spin.entries.map((entry) => entry.label)).toEqual(["Ada", "Bo", ""]);
    expect(spin.winnerIndex).toBe(2);
    expect(slotLabel(spin, 2)).toBe("3");
    expect(slotLabel(spin, 0)).toBe("Ada");
  });

  it("keeps every slot of a spin whatever an entry holds, so every client lands on the same slice", () => {
    const doc = createWheelDoc();
    const slots: unknown[] = [
      { id: "a", label: "  Ada  " },
      { id: "a b", label: "Cy" },
      { id: "x", label: "x".repeat(60) },
      { id: "t", label: "A".repeat(47) + "\uD83C" },
      null,
      { id: "d", label: "Dee" },
    ];
    doc.getMap("wheel").set("spin", build63Spin(slots, 1));
    const spin = getSpin(doc)!;
    expect(spin.entries).toHaveLength(6);
    expect(spin.entries.map((entry) => entry.label)).toEqual(["Ada", "", "", "A".repeat(47), "", "Dee"]);
    expect(new Set(spin.entries.map((entry) => entry.id)).size).toBe(6);
    expect(slotLabel(spin, spin.winnerIndex)).toBe("2");
    expect(getSpin(doc)).toBe(spin);
  });

  it("never writes a result for a slot it cannot show", () => {
    const doc = createWheelDoc();
    doc.getMap("wheel").set("spin", build63Spin([{ id: "a", label: "Ada" }, { id: "z", label: "\u200B" }], 1));
    const spin = getSpin(doc)!;
    recordResult(doc, { spinId: spin.spinId, label: spin.entries[1].label, at: 1, byName: "Host" });
    expect(getHistory(doc)).toEqual([]);
  });
});

describe("wheel accept rule", () => {
  const storeHistory = (doc: Y.Doc, records: unknown[]) => {
    const history = new Y.Array<unknown>();
    doc.getMap("wheel").set("history", history);
    history.push(records);
    return history;
  };

  it("reads a result through the same rule as a name: normalise, then require something visible", () => {
    const doc = createWheelDoc();
    const history = storeHistory(doc, [{ spinId: "s1", label: "\u200B".repeat(48) + "Ada", at: 1, byName: "Host" }]);
    expect(getHistory(doc)).toEqual([]);
    recordResult(doc, { spinId: "s2", label: "\u200B".repeat(48) + "Ada", at: 2, byName: "Host" });
    expect(getHistory(doc)).toEqual([]);
    recordResult(doc, { spinId: "s3", label: "  Ada   Lee ", at: 3, byName: "Host" });
    expect(getHistory(doc).map((result) => result.label)).toEqual(["Ada Lee"]);
    expect((history.toArray() as { label: string }[]).map((result) => result.label)).toEqual(["Ada Lee"]);
  });

  it("keeps only names and results whose ids the native app accepts", () => {
    const doc = createWheelDoc();
    const entries = new Y.Array<unknown>();
    doc.getMap("wheel").set("entries", entries);
    const ids: unknown[] = ["ok-1", "a b", "", "\u00E9", "x".repeat(65), 7, "ok:2"];
    entries.push(ids.map((id, index) => ({ id, label: `Name ${index}` })));
    storeHistory(doc, ids.map((spinId, index) => ({ spinId, label: `Won ${index}`, at: index, byName: "Host" })));
    expect(getEntries(doc).map((entry) => entry.id)).toEqual(["ok-1", "ok:2"]);
    expect(getHistory(doc).map((result) => result.spinId)).toEqual(["ok-1", "ok:2"]);
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
    expect(getSpin(doc)?.entries.map((entry) => entry.label)).toEqual(["One", ""]);

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
      switch (random(8)) {
        case 6:
          return { id: ["a b", "", "\u00E9", 9][random(4)], label: visibleName() };
        case 7:
          return { id: `torn-${index}`, label: ["\uD83C", "Bo\uDF89", HALF_EMOJI][random(3)] };
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
          spinId: random(8) === 0 ? "bad id" : `old-${random(20)}`,
          label: [HIDDEN[random(HIDDEN.length)], `Old ${index}`, `Old ${index}\uD83C`, "\u200B".repeat(48) + "Old"][random(4)],
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
        const read = [
          ...shown.map((entry) => ({ id: entry.id, label: entry.label })),
          ...getHistory(doc).map((result) => ({ id: result.spinId, label: result.label })),
        ];
        for (const item of read) {
          expect(isValidIdentifier(item.id), `${where} ${item.id}`).toBe(true);
          expect(item.label, where).toBe(normalizeLabel(item.label));
          expect(item.label.length > 0 && !LONE_SURROGATE.test(item.label), where).toBe(true);
        }
      }
    }
  });
});

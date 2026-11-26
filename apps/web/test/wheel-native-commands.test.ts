import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { clearEntries as legacyClearEntries, removeEntryById as legacyRemoveEntry } from "./fixtures/wheel-staging-entries";
import {
  addEntries,
  normalizeLabel,
  removeEntryById,
  clearEntries,
  createWheelDoc,
  getEntries,
  getHistory,
} from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import {
  NATIVE_EMBED_ORIGINS,
  decodeEmbedMessage,
  encodeEnvelope,
  isValidAppStatus,
} from "../../../packages/apps-sdk/src/native-embed/protocol";
import {
  addNames,
  labelsFrom,
  runWheelCommand,
  wheelStatus,
  type WheelCommandContext,
} from "../../../packages/apps-sdk/src/native-embed/wheel/commands";

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const SCOPE = { callSessionId: "call-7-3f2a9c1e", appSessionId: "app-5b1d7a2e", appId: "wheel" };

const statusOf = (doc: Y.Doc, winner: { spinId: string; label: string } | null = null) =>
  wheelStatus({
    entries: getEntries(doc),
    history: getHistory(doc),
    removeWinner: false,
    sounds: true,
    spinning: false,
    winner,
  });

const decodesOnNative = (status: ReturnType<typeof wheelStatus>) =>
  decodeEmbedMessage(
    encodeEnvelope("status", SCOPE, "e-1", { app: status }),
    SCOPE,
    NATIVE_EMBED_ORIGINS.ios,
    NATIVE_EMBED_ORIGINS.ios,
    true
  );

describe("native wheel commands", () => {
  it("normalises the names a native app sends before counting them", () => {
    const hidden = Array.from({ length: 64 }, () => "\u200B");
    expect(labelsFrom({ labels: [...hidden, "  Ada  ", 7, "A".repeat(47) + "\u{1F389}"] })).toEqual([
      { index: 64, label: "Ada" },
      { index: 66, label: "A".repeat(47) },
    ]);
    expect(labelsFrom({ labels: "Ada" })).toEqual([]);
    expect(labelsFrom({ labels: Array.from({ length: 70 }, (_, index) => `N${index}`) })).toHaveLength(64);
  });

  it("answers by what the wheel added", () => {
    const doc = createWheelDoc();
    expect(addNames(doc, { labels: ["\u200B", " "] })).toEqual({ ok: false, error: "noNames", added: [] });
    expect(getEntries(doc)).toEqual([]);
    expect(addNames(doc, { labels: ["Ada"] })).toEqual({ ok: true, added: [0] });
    addEntries(doc, Array.from({ length: 63 }, (_, index) => `N${index}`));
    expect(addNames(doc, { labels: ["Late"] })).toEqual({ ok: false, error: "full", added: [] });
    expect(getEntries(doc)).toHaveLength(64);
  });

  it("lists exactly which sent names it added, by their place in the request", () => {
    const doc = createWheelDoc();
    addEntries(doc, Array.from({ length: 62 }, (_, index) => `N${index}`));
    expect(addNames(doc, { labels: [7, "  ", "Ada", "\u200B", "Bo", "Cy"] })).toEqual({ ok: true, added: [2, 4] });
    expect(getEntries(doc).slice(-2).map((entry) => entry.label)).toEqual(["Ada", "Bo"]);
  });

  it("refuses to reorder or remove names while a spin is on, so dial and list numbers always match", () => {
    const doc = createWheelDoc();
    addEntries(doc, ["Cy", "Ada", "Bo"]);
    const before = getEntries(doc);
    const context = (spinning: boolean): WheelCommandContext => ({
      requestId: `h-${spinning}`,
      addKey: (requestId) => `app-1/${requestId}`,
      spinning,
      requestSpin: () => ({ ok: true }),
      setSounds: () => ({ ok: true }),
    });
    for (const [type, payload] of [
      ["sort", {}],
      ["shuffle", {}],
      ["removeEntry", { entryId: before[0].id }],
      ["clearEntries", {}],
    ] as const) {
      expect(runWheelCommand(doc, type, payload, context(true)), type).toEqual({ ok: false, error: "spinning" });
      expect(getEntries(doc), type).toEqual(before);
    }
    expect(runWheelCommand(doc, "addEntries", { labels: ["Dee"] }, context(true))).toEqual({ ok: true, added: [0] });
    expect(runWheelCommand(doc, "sort", {}, context(false))).toEqual({ ok: true });
    expect(getEntries(doc).map((entry) => entry.label)).toEqual(["Ada", "Bo", "Cy", "Dee"]);
  });

  it("sends native exactly the names and results the web shows, for any stored mix", () => {
    let seed = 20261124;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const ids = ["ok-1", "ok-2", "ok:3", "a b", "", "\u00E9", "x".repeat(65)];
    const labels = ["Ada", " Bo ", "\u200B", "\u200B".repeat(48) + "Cy", "A".repeat(47) + "\uD83C", "x".repeat(60), "\uDF89De"];
    const names = ["Host", "\u{1F389}".repeat(40), "N".repeat(63) + "\u{1F389}", "Gr\uD83Cace"];
    for (let run = 0; run < 400; run += 1) {
      const doc = createWheelDoc();
      const entries = new Y.Array<unknown>();
      doc.getMap("wheel").set("entries", entries);
      entries.push(
        Array.from({ length: random(80) }, (_, index) =>
          random(9) === 0 ? null : { id: random(3) === 0 ? ids[random(ids.length)] : `e-${index}`, label: labels[random(labels.length)] }
        )
      );
      const history = new Y.Array<unknown>();
      doc.getMap("wheel").set("history", history);
      history.push(
        Array.from({ length: random(30) }, (_, index) => ({
          spinId: random(3) === 0 ? ids[random(ids.length)] : `s-${index}`,
          label: labels[random(labels.length)],
          at: index,
          byName: names[random(names.length)],
        }))
      );
      const where = `run ${run}`;
      const status = statusOf(doc, random(2) === 0 ? { spinId: "s-1", label: "A".repeat(47) } : null);
      expect(isValidAppStatus(status), where).toBe(true);
      expect(status.entries, where).toEqual(getEntries(doc).map((entry) => ({ id: entry.id, label: entry.label })));
      expect(status.results.map((result) => [result.id, result.label]), where).toEqual(
        getHistory(doc).map((result) => [result.spinId, result.label])
      );
      for (const result of status.results) {
        expect(result.byName.length <= 64 && !LONE_SURROGATE.test(result.byName), where).toBe(true);
      }
      expect(decodesOnNative(status), where).toMatchObject({ ok: true });
    }
  });
});

describe("native wheel add records", () => {
  const contextFor = (appSessionId: string, requestId: string): WheelCommandContext => ({
    requestId,
    addKey: (id) => `${appSessionId}/${id}`,
    spinning: false,
    requestSpin: () => ({ ok: true }),
    setSounds: () => ({ ok: true }),
  });
  const add = (doc: Y.Doc, appSessionId: string, requestId: string, labels: string[]) =>
    runWheelCommand(doc, "addEntries", { labels }, contextFor(appSessionId, requestId));
  const outcome = (doc: Y.Doc, appSessionId: string, requestId: string) =>
    runWheelCommand(doc, "addOutcome", { requestId }, contextFor(appSessionId, "q-1"));
  const labels = (doc: Y.Doc) => getEntries(doc).map((entry) => entry.label);
  const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds both adds after two peers add before seeing each other", () => {
    const base = createWheelDoc();
    addEntries(base, ["Host"]);
    const ada = createWheelDoc();
    const ben = createWheelDoc();
    sync(base, ada);
    sync(base, ben);
    expect(add(ada, "app-ada1", "h-1", ["Ada"])).toEqual({ ok: true, added: [0] });
    expect(add(ben, "app-ben1", "h-1", ["Ben"])).toEqual({ ok: true, added: [0] });
    sync(ada, ben);
    sync(ben, ada);
    for (const doc of [ada, ben]) {
      expect(outcome(doc, "app-ada1", "h-1")).toEqual({ ok: true, added: [0] });
      expect(outcome(doc, "app-ben1", "h-1")).toEqual({ ok: true, added: [0] });
      expect(add(doc, "app-ada1", "h-1", ["Ada"])).toEqual({ ok: true, added: [0] });
    }
    expect(labels(ada).sort()).toEqual(["Ada", "Ben", "Host"]);
    expect(labels(ben).sort()).toEqual(["Ada", "Ben", "Host"]);
  });

  it.each(["remove", "clear"] as const)("keeps the exact accepted slots when a staging client uses %s before native reloads", (change) => {
    const origin = createWheelDoc();
    const updates: Uint8Array[] = [];
    origin.on("update", (update: Uint8Array) => updates.push(update));
    expect(add(origin, "app-ada1", "h-1", ["Ada", "", "Bo"])).toEqual({ ok: true, added: [0, 2] });
    expect(updates).toHaveLength(1);
    const legacy = createWheelDoc();
    Y.applyUpdate(legacy, updates[0]);

    if (change === "remove") legacyRemoveEntry(legacy, getEntries(origin)[0].id);
    else legacyClearEntries(legacy);

    const reloaded = createWheelDoc();
    sync(legacy, reloaded);
    const survivors = change === "remove" ? ["Bo"] : [];
    expect(labels(reloaded)).toEqual(survivors);
    expect(outcome(reloaded, "app-ada1", "h-1")).toEqual({ ok: true, added: [0, 2] });
    expect(add(reloaded, "app-ada1", "h-1", ["Ada", "", "Bo"])).toEqual({ ok: true, added: [0, 2] });
    expect(labels(reloaded)).toEqual(survivors);
  });

  it("replays a saved refusal on a fresh replica even after room opens up", () => {
    const doc = createWheelDoc();
    addEntries(doc, Array.from({ length: 64 }, (_, index) => `Old ${index}`));
    const refusal = { ok: false, error: "full", added: [] };
    expect(add(doc, "app-ada1", "h-1", ["Ada"])).toEqual(refusal);
    clearEntries(doc);

    const reloaded = createWheelDoc();
    sync(doc, reloaded);
    expect(outcome(reloaded, "app-ada1", "h-1")).toEqual(refusal);
    expect(add(reloaded, "app-ada1", "h-1", ["Ada"])).toEqual(refusal);
    expect(labels(reloaded)).toEqual([]);
    expect(add(reloaded, "app-ada1", "h-2", ["Ada"])).toEqual({ ok: true, added: [0] });
    expect(labels(reloaded)).toEqual(["Ada"]);
  });

  it("still knows an add ran after 300 other adds and removals while its client was away", () => {
    const doc = createWheelDoc();
    add(doc, "app-away1", "h-1", ["Ada"]);
    for (let index = 0; index < 300; index += 1) {
      add(doc, "app-busy1", `h-${index + 1}`, [`N${index}`]);
      removeEntryById(doc, getEntries(doc).find((entry) => entry.label === `N${index}`)!.id);
    }
    expect(add(doc, "app-away1", "h-1", ["Ada"])).toEqual({ ok: true, added: [0] });
    expect(labels(doc)).toEqual(["Ada"]);
  });

  it("does not add a name again after someone removed it, sorted or cleared the wheel", () => {
    for (const change of ["remove", "sort", "clear"] as const) {
      const doc = createWheelDoc();
      add(doc, "app-ada1", "h-1", ["Zed", "", "Ada"]);
      if (change === "remove") removeEntryById(doc, getEntries(doc)[0].id);
      if (change === "sort") runWheelCommand(doc, "sort", {}, contextFor("app-other", "h-9"));
      if (change === "clear") clearEntries(doc);
      expect(outcome(doc, "app-ada1", "h-1"), change).toEqual({ ok: true, added: [0, 2] });
      add(doc, "app-ada1", "h-1", ["Zed", "", "Ada"]);
      expect(labels(doc), change).toEqual({ remove: ["Ada"], sort: ["Ada", "Zed"], clear: [] }[change]);
    }
  });

  it("distinguishes a missing add from one removed before a long outage", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const doc = createWheelDoc();
    add(doc, "app-ada1", "h-1", ["Ada"]);
    removeEntryById(doc, getEntries(doc)[0].id);
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    const reloaded = createWheelDoc();
    sync(doc, reloaded);
    expect(outcome(reloaded, "app-ada1", "h-7")).toEqual({ ok: false, error: "notApplied" });
    expect(outcome(reloaded, "app-ada1", "h-1")).toEqual({ ok: true, added: [0] });
    expect(labels(reloaded)).toEqual([]);
  });

  it("refuses a paste longer than the line limit before adding anything, so no slot is ever unrecordable", () => {
    const doc = createWheelDoc();
    const flood = [...Array.from({ length: 4_096 }, () => "\u200B"), "Ada"];
    expect(add(doc, "app-ada1", "h-1", flood)).toEqual({ ok: false, error: "tooManyLines", added: [] });
    expect(labels(doc)).toEqual([]);
    const edge = [...Array.from({ length: 255 }, () => "\u200B"), "Ada"];
    expect(add(doc, "app-ada1", "h-2", edge)).toEqual({ ok: true, added: [255] });
    expect(outcome(doc, "app-ada1", "h-2")).toEqual({ ok: true, added: [255] });
    expect(add(doc, "app-ada1", "h-2", edge)).toEqual({ ok: true, added: [255] });
    expect(labels(doc)).toEqual(["Ada"]);
  });

  it("points every added index at a name that is on the wheel, and never adds a replayed paste twice", () => {
    let seed = 20261125;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const pool = ["Ada", " Bo ", "e\u0301", "\u200B", "\u0301", "   ", "\u200B\u200F", "\u2060", "\u0915\u094D\u0937", "Cy\u200B", "\t", "x".repeat(60)];
    let checked = 0;
    for (let run = 0; run < 250; run += 1) {
      const doc = createWheelDoc();
      addEntries(doc, Array.from({ length: random(70) }, (_, index) => `Old ${index}`));
      const lines = Array.from({ length: 1 + random(300) }, () => pool[random(pool.length)]);
      const before = getEntries(doc).length;
      const result = add(doc, "app-r1", `h-${run}`, lines);
      const created = getEntries(doc).slice(before);
      if (lines.length > 256) {
        expect(result, `run ${run}`).toEqual({ ok: false, error: "tooManyLines", added: [] });
        expect(getEntries(doc).length, `run ${run}`).toBe(before);
        continue;
      }
      checked += 1;
      const added = result.ok ? (result.added ?? []) : [];
      expect(created.map((entry) => entry.label), `run ${run}`).toEqual(added.map((slot) => normalizeLabel(lines[slot])));
      expect(created.every((entry) => entry.label.length > 0), `run ${run}`).toBe(true);
      const replay = add(doc, "app-r1", `h-${run}`, lines);
      expect(getEntries(doc).length, `run ${run}`).toBe(before + created.length);
      expect(replay, `run ${run}`).toEqual(result);
    }
    expect(checked).toBeGreaterThan(100);
  });
});


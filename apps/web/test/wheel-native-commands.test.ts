import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addEntries,
  normalizeLabel,
  readAddRecord,
  removeEntryById,
  clearEntries,
  createWheelDoc,
  getEntries,
  getHistory,
} from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import {
  NATIVE_EMBED_ORIGINS,
  WHEEL_ADD_RECOVERY,
  WHEEL_RECEIPT_LIMITS,
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

const OPEN = { synced: true, canEdit: true, repeat: false };

const contextWith = (overrides: Partial<WheelCommandContext> = {}): WheelCommandContext => ({
  ...OPEN,
  spinning: false,
  requestSpin: () => ({ ok: true }),
  setSounds: () => ({ ok: true }),
  ...overrides,
});

const statusOf = (doc: Y.Doc, winner: { spinId: string; label: string } | null = null) =>
  wheelStatus({
    entries: getEntries(doc),
    waitingCount: 0,
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
    expect(addNames(doc, { labels: ["\u200B", " "] }, OPEN)).toEqual({ ok: false, error: "noNames", added: [] });
    expect(getEntries(doc)).toEqual([]);
    expect(addNames(doc, { labels: ["Ada"] }, OPEN)).toEqual({ ok: true, added: [0] });
    addEntries(doc, Array.from({ length: 63 }, (_, index) => `N${index}`));
    expect(addNames(doc, { labels: ["Late"] }, OPEN)).toEqual({ ok: false, error: "full", added: [] });
    expect(getEntries(doc)).toHaveLength(64);
  });

  it("lists exactly which sent names it added, by their place in the request", () => {
    const doc = createWheelDoc();
    addEntries(doc, Array.from({ length: 62 }, (_, index) => `N${index}`));
    expect(addNames(doc, { labels: [7, "  ", "Ada", "\u200B", "Bo", "Cy"] }, OPEN)).toEqual({ ok: true, added: [2, 4] });
    expect(getEntries(doc).slice(-2).map((entry) => entry.label)).toEqual(["Ada", "Bo"]);
  });

  it("refuses to reorder or remove names while a spin is on, so dial and list numbers always match", () => {
    const doc = createWheelDoc();
    addEntries(doc, ["Cy", "Ada", "Bo"]);
    const before = getEntries(doc);
    const context = (spinning: boolean): WheelCommandContext => contextWith({ spinning });
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
      const entries = doc.getArray<unknown>("wheel.entries");
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

const FLOOD = Array.from({ length: 257 }, (_, index) => `N${index}`);
const FLOOD_TOKENS = FLOOD.map((_, index) => `flood-${index}`);

describe("native wheel add receipts", () => {
  const RECEIPTS = "wheel.addReceipts";
  type Receipt = { at: number; floor: number; tokens: string[] };
  const tokensFor = (lines: readonly unknown[]): string[] => lines.map(() => crypto.randomUUID());
  let clock = 1_800_000_000_000;
  const sentTimes = new Map<unknown, number>();
  const sentAtOf = (tokens: unknown): number => {
    const key: unknown = Array.isArray(tokens) ? tokens[0] : tokens;
    const known = sentTimes.get(key);
    if (known !== undefined) return known;
    clock += 1_000;
    sentTimes.set(key, clock);
    return clock;
  };
  const add = (doc: Y.Doc, lines: unknown[], tokens: unknown = tokensFor(lines), overrides: Partial<WheelCommandContext> = {}) =>
    runWheelCommand(doc, "addEntries", { labels: lines, tokens, sentAt: sentAtOf(tokens) }, contextWith(overrides));
  const outcome = (doc: Y.Doc, tokens: unknown, overrides: Partial<WheelCommandContext> = {}) =>
    runWheelCommand(doc, "addOutcome", { tokens, sentAt: sentAtOf(tokens) }, contextWith(overrides));
  const labels = (doc: Y.Doc) => getEntries(doc).map((entry) => entry.label);
  const receipts = (doc: Y.Doc) => doc.getArray<unknown>(RECEIPTS);
  const stored = (doc: Y.Doc): Receipt[] => receipts(doc).toArray() as Receipt[];
  const receiptOf = (tokens: string[]): Receipt => ({ at: sentAtOf(tokens), floor: 0, tokens });
  const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
  const replicaOf = (doc: Y.Doc): Y.Doc => {
    const replica = createWheelDoc();
    sync(doc, replica);
    return replica;
  };
  const sizeOf = (doc: Y.Doc): number => Y.encodeStateAsUpdate(doc).length;
  const receiptBytes = (doc: Y.Doc): number =>
    stored(doc).reduce((bytes, receipt) => bytes + receipt.tokens.reduce((sum, token) => sum + token.length + 2, 32), 0);
  const NOTHING_ADDED = { ok: false, error: "notApplied", added: [] };
  const CANNOT_TELL = { ok: false, error: "outcomeUnknown" };

  it("finds both adds after two peers add to an empty wheel before seeing each other", () => {
    const base = createWheelDoc();
    const ada = replicaOf(base);
    const ben = replicaOf(base);
    const adaTokens = tokensFor(["Ada"]);
    const benTokens = tokensFor(["Ben"]);
    expect(add(ada, ["Ada"], adaTokens)).toEqual({ ok: true, added: [0] });
    expect(add(ben, ["Ben"], benTokens)).toEqual({ ok: true, added: [0] });
    sync(ada, ben);
    sync(ben, ada);
    for (const doc of [ada, ben, replicaOf(ada)]) {
      expect(outcome(doc, adaTokens)).toEqual({ ok: true, added: [0] });
      expect(outcome(doc, benTokens)).toEqual({ ok: true, added: [0] });
      expect(add(doc, ["Ada"], adaTokens)).toEqual({ ok: true, added: [0] });
      expect(labels(doc).sort()).toEqual(["Ada", "Ben"]);
    }
  });

  it.each(["remove", "clear"] as const)("still answers added after another editor uses %s, on a replica that never ran the add", (change) => {
    const origin = createWheelDoc();
    const updates: Uint8Array[] = [];
    origin.on("update", (update: Uint8Array) => updates.push(update));
    const tokens = tokensFor(["Ada", "", "Bo"]);
    expect(add(origin, ["Ada", "", "Bo"], tokens)).toEqual({ ok: true, added: [0, 2] });
    expect(updates).toHaveLength(1);
    const editor = createWheelDoc();
    Y.applyUpdate(editor, updates[0]);

    if (change === "remove") removeEntryById(editor, getEntries(origin)[0].id);
    else clearEntries(editor);

    const reloaded = replicaOf(editor);
    const survivors = change === "remove" ? ["Bo"] : [];
    expect(labels(reloaded)).toEqual(survivors);
    expect(outcome(reloaded, tokens)).toEqual({ ok: true, added: [0, 2] });
    expect(add(reloaded, ["Ada", "", "Bo"], tokens)).toEqual({ ok: true, added: [0, 2] });
    expect(labels(reloaded)).toEqual(survivors);
  });

  it("does not add a name again after someone removed it, sorted or cleared the wheel", () => {
    for (const change of ["remove", "sort", "clear"] as const) {
      const doc = createWheelDoc();
      const tokens = tokensFor(["Zed", "", "Ada"]);
      add(doc, ["Zed", "", "Ada"], tokens);
      if (change === "remove") removeEntryById(doc, getEntries(doc)[0].id);
      if (change === "sort") runWheelCommand(doc, "sort", {}, contextWith());
      if (change === "clear") clearEntries(doc);
      expect(outcome(doc, tokens), change).toEqual({ ok: true, added: [0, 2] });
      expect(add(doc, ["Zed", "", "Ada"], tokens), change).toEqual({ ok: true, added: [0, 2] });
      expect(labels(doc), change).toEqual({ remove: ["Ada"], sort: ["Ada", "Zed"], clear: [] }[change]);
    }
  });

  it("writes nothing and tells no peer when it refuses an add", () => {
    const full = createWheelDoc();
    addEntries(full, Array.from({ length: 64 }, (_, index) => `Old ${index}`));
    const empty = createWheelDoc();
    const flood = Array.from({ length: 257 }, (_, index) => `N${index}`);
    const cases: [string, Y.Doc, unknown[], unknown, Partial<WheelCommandContext>][] = [
      ["full", full, ["Ada"], tokensFor(["Ada"]), {}],
      ["noNames", empty, ["​", "  "], tokensFor([0, 1]), {}],
      ["tooManyLines", empty, flood, tokensFor(flood), {}],
      ["readOnly", empty, ["Ada"], tokensFor(["Ada"]), { canEdit: false }],
      ["notSynced", empty, ["Ada"], tokensFor(["Ada"]), { synced: false }],
      ["badRequest", empty, ["Ada", "Bo"], tokensFor(["Ada"]), {}],
      ["badRequest", empty, ["Ada", "Bo"], ["same", "same"], {}],
      ["badRequest", empty, ["Ada"], ["not a token"], {}],
      ["badRequest", empty, ["Ada"], "token", {}],
    ];
    for (const [error, doc, lines, tokens, overrides] of cases) {
      const before = Y.encodeStateAsUpdate(doc);
      let updates = 0;
      const count = () => {
        updates += 1;
      };
      doc.on("update", count);
      expect(add(doc, lines, tokens, overrides), error).toEqual({ ok: false, error, added: [] });
      doc.off("update", count);
      expect(updates, error).toBe(0);
      expect(Y.encodeStateAsUpdate(doc), error).toEqual(before);
      expect(receipts(doc).length, error).toBe(0);
      if (Array.isArray(tokens) && tokens.length <= 256 && !tokens.includes("not a token")) {
        expect(outcome(replicaOf(doc), [...new Set(tokens)]), error).toEqual(NOTHING_ADDED);
      }
    }
  });

  it("adds the names once the refusal's cause is gone, because no refusal is ever stored", () => {
    const doc = createWheelDoc();
    addEntries(doc, Array.from({ length: 64 }, (_, index) => `Old ${index}`));
    const tokens = tokensFor(["Ada"]);
    expect(add(doc, ["Ada"], tokens)).toEqual({ ok: false, error: "full", added: [] });
    clearEntries(doc);
    expect(outcome(doc, tokens)).toEqual(NOTHING_ADDED);
    expect(add(doc, ["Ada"], tokensFor(["Ada"]))).toEqual({ ok: true, added: [0] });
    expect(labels(doc)).toEqual(["Ada"]);
  });

  it("keeps no receipt for an add that carries no tokens, such as Add Everyone Here", () => {
    const doc = createWheelDoc();
    expect(runWheelCommand(doc, "addEntries", { labels: ["Ada", "Bo"] }, contextWith())).toEqual({ ok: true, added: [0, 1] });
    expect(labels(doc)).toEqual(["Ada", "Bo"]);
    expect(receipts(doc).length).toBe(0);
    expect(readAddRecord(doc, 1)).toEqual({ added: new Set(), reachesBack: true });
  });

  it("never runs a repeated request a second time", () => {
    const doc = createWheelDoc();
    const tokens = tokensFor(["Ada", "Bo"]);
    expect(add(doc, ["Ada", "Bo"], tokens)).toEqual({ ok: true, added: [0, 1] });
    expect(add(doc, ["Ada", "Bo"], tokens, { repeat: true })).toEqual({ ok: true, added: [0, 1] });
    expect(add(doc, ["Ada", "Bo"], tokens, { synced: false, canEdit: false })).toEqual({ ok: true, added: [0, 1] });
    const refused = tokensFor(["Cy"]);
    expect(add(doc, ["Cy"], refused, { synced: false })).toEqual({ ok: false, error: "notSynced", added: [] });
    expect(add(doc, ["Cy"], refused, { repeat: true })).toEqual(NOTHING_ADDED);
    expect(runWheelCommand(doc, "addEntries", { labels: ["Dee"] }, contextWith({ repeat: true }))).toEqual({ ok: false, error: "duplicateRequest" });
    expect(labels(doc)).toEqual(["Ada", "Bo"]);
  });

  it("answers from a receipt it holds while not synced, and says it cannot tell when it holds none", () => {
    const doc = createWheelDoc();
    const tokens = tokensFor(["Ada", "​"]);
    expect(add(doc, ["Ada", "​"], tokens)).toEqual({ ok: true, added: [0] });
    expect(outcome(doc, tokens, { synced: false, canEdit: false })).toEqual({ ok: true, added: [0] });
    expect(outcome(doc, tokensFor(["Bo"]), { synced: false })).toEqual({ ok: false, error: "notSynced" });
    expect(outcome(doc, tokensFor(["Bo"]))).toEqual(NOTHING_ADDED);
    for (const tokens of [undefined, [], ["a b"], ["twin", "twin"], Array.from({ length: 257 }, (_, index) => `t-${index}`)]) {
      expect(outcome(doc, tokens)).toEqual({ ok: false, error: "badRequest" });
    }
  });

  it("refuses an add or a question that does not say when the names were sent", () => {
    const doc = createWheelDoc();
    for (const sentAt of [undefined, null, 0, -1, "1800000000000", Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const tokens = tokensFor(["Ada"]);
      expect(runWheelCommand(doc, "addEntries", { labels: ["Ada"], tokens, sentAt }, contextWith()), String(sentAt)).toEqual({
        ok: false,
        error: "badRequest",
        added: [],
      });
      expect(runWheelCommand(doc, "addOutcome", { tokens, sentAt }, contextWith()), String(sentAt)).toEqual({ ok: false, error: "badRequest" });
    }
    expect(labels(doc)).toEqual([]);
    expect(receipts(doc).length).toBe(0);
  });

  it("refuses a paste longer than the line limit before adding anything", () => {
    const doc = createWheelDoc();
    const flood = [...Array.from({ length: 4_096 }, () => "​"), "Ada"];
    expect(add(doc, flood)).toEqual({ ok: false, error: "tooManyLines", added: [] });
    expect(labels(doc)).toEqual([]);
    const edge = [...Array.from({ length: 255 }, () => "​"), "Ada"];
    const tokens = tokensFor(edge);
    expect(add(doc, edge, tokens)).toEqual({ ok: true, added: [255] });
    expect(outcome(doc, tokens)).toEqual({ ok: true, added: [255] });
    expect(add(doc, edge, tokens)).toEqual({ ok: true, added: [255] });
    expect(labels(doc)).toEqual(["Ada"]);
  });

  describe("another editor writing the receipts", () => {
    const nearlyFull = () => {
      const victim = createWheelDoc();
      addEntries(victim, Array.from({ length: 63 }, (_, index) => `Old ${index}`));
      return victim;
    };

    it("cannot make an add skip by writing receipts before it, whatever keys it guesses", () => {
      const victim = createWheelDoc();
      const attacker = replicaOf(victim);
      const guesses = Array.from({ length: 64 }, (_, index) => `h-${index + 1}`);
      receipts(attacker).push([
        guesses,
        ["full"],
        receiptOf(guesses),
        receiptOf(guesses.map((guess) => `app-5b1d7a2e:${guess}`)),
        { at: 9e15, floor: 9e15, tokens: ["from-the-future"] },
      ]);
      sync(attacker, victim);
      const oldFormat = replicaOf(victim);
      for (const guess of guesses) oldFormat.getMap(RECEIPTS).set(`app-5b1d7a2e/${guess}`, "full");
      sync(oldFormat, victim);
      const tokens = tokensFor(["Ada", "Bo"]);
      expect(add(victim, ["Ada", "Bo"], tokens)).toEqual({ ok: true, added: [0, 1] });
      expect(labels(victim)).toEqual(["Ada", "Bo"]);
      expect(outcome(replicaOf(victim), tokens)).toEqual({ ok: true, added: [0, 1] });
    });

    it("cannot report a name added that the wheel never took, because it never learns that name's token", () => {
      const victim = nearlyFull();
      const tokens = tokensFor(["Ada", "Bo", "​"]);
      expect(add(victim, ["Ada", "Bo", "​"], tokens)).toEqual({ ok: true, added: [0] });
      const attacker = replicaOf(victim);
      const seen = stored(attacker).flatMap((receipt) => receipt.tokens);
      expect(seen).toEqual([tokens[0]]);
      receipts(attacker).delete(0, receipts(attacker).length);
      receipts(attacker).push([
        { at: sentAtOf(tokens), floor: 0, tokens: [...seen, "h-2", "slot-1", `${tokens[0]}1`] },
        receiptOf(seen.map((token) => token.toUpperCase())),
      ]);
      sync(attacker, victim);
      const reloaded = replicaOf(victim);
      expect(outcome(reloaded, tokens)).toEqual({ ok: true, added: [0] });
      expect(labels(reloaded).slice(-1)).toEqual(["Ada"]);
    });

    it("can only erase a receipt, which hands the names back instead of dropping them", () => {
      const victim = createWheelDoc();
      const tokens = tokensFor(["Ada"]);
      expect(add(victim, ["Ada"], tokens)).toEqual({ ok: true, added: [0] });
      const attacker = replicaOf(victim);
      receipts(attacker).delete(0, receipts(attacker).length);
      receipts(attacker).push([
        ["full"],
        "full",
        { at: 1, floor: 0, tokens: [] },
        { at: 1, floor: 0, tokens: [7] },
        { at: "1", floor: 0, tokens: ["t-1"] },
        { at: 1, tokens: ["t-1"] },
        { at: 1, floor: 0, tokens: Array.from({ length: 65 }, (_, index) => `t-${index}`) },
      ]);
      sync(attacker, victim);
      expect(outcome(replicaOf(victim), tokens)).toEqual(NOTHING_ADDED);
      expect(labels(victim)).toEqual(["Ada"]);
    });
  });

  describe("bounds", () => {
    it("keeps the newest receipts within the count limit on every write and reads no older one", () => {
      const doc = createWheelDoc();
      const first = tokensFor(["Ada"]);
      add(doc, ["Ada"], first);
      const stale = Array.from({ length: 400 }, (_, index) => receiptOf([`stale-${index}`]));
      receipts(doc).push(stale);
      expect(receipts(doc).length).toBe(401);
      expect(readAddRecord(doc, clock).added.size).toBe(WHEEL_RECEIPT_LIMITS.count);
      expect(outcome(doc, first)).toEqual(CANNOT_TELL);
      expect(outcome(doc, ["stale-279"])).toEqual(CANNOT_TELL);
      expect(outcome(doc, ["stale-399"])).toEqual({ ok: true, added: [0] });
      expect(outcome(doc, tokensFor(["Never sent"]))).toEqual(NOTHING_ADDED);
      clearEntries(doc);
      const latest = tokensFor(["Bo"]);
      expect(add(doc, ["Bo"], latest)).toEqual({ ok: true, added: [0] });
      expect(receipts(doc).length).toBe(WHEEL_RECEIPT_LIMITS.count);
      expect(stored(doc).at(-1)).toEqual({ at: sentAtOf(latest), floor: sentAtOf(["stale-280"]), tokens: latest });
      expect(outcome(doc, first)).toEqual(CANNOT_TELL);
      expect(outcome(doc, ["stale-280"])).toEqual(CANNOT_TELL);
      expect(outcome(doc, ["stale-281"])).toEqual({ ok: true, added: [0] });
      expect(outcome(replicaOf(doc), ["stale-280"])).toEqual(CANNOT_TELL);
      expect(outcome(doc, tokensFor(["Never sent"]))).toEqual(NOTHING_ADDED);
    });

    it("keeps the receipts within the byte limit when every add is a full wheel of the longest tokens", () => {
      const doc = createWheelDoc();
      const names = Array.from({ length: 64 }, (_, index) => `N${index}`);
      let latest: string[] = [];
      for (let round = 0; round < 12; round += 1) {
        latest = names.map((_, index) => `${round}-${index}-`.padEnd(64, "x"));
        expect(add(doc, names, latest)).toEqual({ ok: true, added: names.map((_, index) => index) });
        clearEntries(doc);
        expect(receiptBytes(doc)).toBeLessThanOrEqual(WHEEL_RECEIPT_LIMITS.bytes);
      }
      expect(receipts(doc).length).toBe(7);
      expect(outcome(doc, latest).ok).toBe(true);
    });

    it("still knows an add ran after two adds a second for the whole window in which native may ask", () => {
      const doc = createWheelDoc();
      const away = tokensFor(["Ada"]);
      add(doc, ["Ada"], away);
      const others = (WHEEL_ADD_RECOVERY.windowMs / 1_000) * 2 - 1;
      for (let index = 0; index < others; index += 1) {
        add(doc, [`N${index}`]);
        removeEntryById(doc, getEntries(doc).find((entry) => entry.label === `N${index}`)!.id);
      }
      expect(add(doc, ["Ada"], away)).toEqual({ ok: true, added: [0] });
      expect(labels(doc)).toEqual(["Ada"]);
    });

    it("stays small through 5,000 add and clear rounds, for the room and for someone joining late", { timeout: 30_000 }, () => {
      const native = createWheelDoc();
      const room = createWheelDoc();
      native.on("update", (update: Uint8Array) => Y.applyUpdate(room, update));
      const plain = createWheelDoc();
      let last: string[] = [];
      for (let round = 0; round < 5_000; round += 1) {
        last = tokensFor(["Ada"]);
        expect(add(native, ["Ada"], last).ok).toBe(true);
        clearEntries(native);
        addEntries(plain, ["Ada"]);
        clearEntries(plain);
        if (receipts(native).length > WHEEL_RECEIPT_LIMITS.count) throw new Error(`round ${round} kept ${receipts(native).length} receipts`);
      }
      expect(receipts(room).length).toBe(WHEEL_RECEIPT_LIMITS.count);
      expect(receiptBytes(room)).toBeLessThanOrEqual(WHEEL_RECEIPT_LIMITS.bytes);
      const late = replicaOf(room);
      expect(outcome(late, last)).toEqual({ ok: true, added: [0] });
      expect(sizeOf(late)).toBe(sizeOf(room));
      expect(sizeOf(room)).toBeLessThan(128 * 1_024);
      expect(sizeOf(room) - sizeOf(plain)).toBeLessThan(5_000 * 20 + 8 * 1_024);
    });

    it("does not grow at all through 14,000 refused adds", { timeout: 30_000 }, () => {
      const native = createWheelDoc();
      addEntries(native, Array.from({ length: 64 }, (_, index) => `Old ${index}`));
      const before = Y.encodeStateAsUpdate(native);
      let updates = 0;
      native.on("update", () => {
        updates += 1;
      });
      for (let round = 0; round < 14_000; round += 1) {
        const error = (["full", "noNames", "tooManyLines"] as const)[round % 3];
        const lines = error === "full" ? ["Ada"] : error === "noNames" ? [" "] : FLOOD;
        const result = add(native, lines, error === "tooManyLines" ? FLOOD_TOKENS : tokensFor(lines));
        if (result.ok || result.error !== error) throw new Error(`round ${round} answered ${JSON.stringify(result)}`);
      }
      expect(updates).toBe(0);
      expect(Y.encodeStateAsUpdate(native)).toEqual(before);
    });
  });

  it("points every added index at a name that is on the wheel, and never adds a replayed paste twice", () => {
    let seed = 20261125;
    const random = (limit: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const pool = ["Ada", " Bo ", "é", "​", "́", "   ", "​‏", "⁠", "क्ष", "Cy​", "\t", "x".repeat(60)];
    let checked = 0;
    for (let run = 0; run < 250; run += 1) {
      const doc = createWheelDoc();
      addEntries(doc, Array.from({ length: random(70) }, (_, index) => `Old ${index}`));
      const lines = Array.from({ length: 1 + random(300) }, () => pool[random(pool.length)]);
      const tokens = tokensFor(lines);
      const before = getEntries(doc).length;
      const result = add(doc, lines, tokens);
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
      const replay = add(doc, lines, tokens);
      expect(getEntries(doc).length, `run ${run}`).toBe(before + created.length);
      if (result.ok) {
        expect(replay, `run ${run}`).toEqual(result);
        expect(outcome(replicaOf(doc), tokens), `run ${run}`).toEqual(result);
      } else {
        expect(outcome(replicaOf(doc), tokens), `run ${run}`).toEqual(NOTHING_ADDED);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

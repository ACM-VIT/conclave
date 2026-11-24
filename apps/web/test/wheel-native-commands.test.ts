import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addEntries,
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
import { addNames, labelsFrom, wheelStatus } from "../../../packages/apps-sdk/src/native-embed/wheel/commands";

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
      "Ada",
      "A".repeat(47),
    ]);
    expect(labelsFrom({ labels: "Ada" })).toEqual([]);
    expect(labelsFrom({ labels: Array.from({ length: 70 }, (_, index) => `N${index}`) })).toHaveLength(64);
  });

  it("answers by what the wheel added", () => {
    const doc = createWheelDoc();
    expect(addNames(doc, { labels: ["\u200B", " "] })).toEqual({ ok: false, error: "noNames" });
    expect(getEntries(doc)).toEqual([]);
    expect(addNames(doc, { labels: ["Ada"] })).toEqual({ ok: true });
    addEntries(doc, Array.from({ length: 63 }, (_, index) => `N${index}`));
    expect(addNames(doc, { labels: ["Late"] })).toEqual({ ok: false, error: "full" });
    expect(getEntries(doc)).toHaveLength(64);
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

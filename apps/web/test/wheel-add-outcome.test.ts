import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addEntries, clearEntries, createWheelDoc, getEntries } from "../../../packages/apps-sdk/src/apps/wheel/core/doc/index";
import { WHEEL_RECEIPT_LIMITS } from "../../../packages/apps-sdk/src/native-embed/protocol";
import { runWheelCommand, type WheelCommandContext } from "../../../packages/apps-sdk/src/native-embed/wheel/commands";

type Sent = { labels: string[]; tokens: string[]; sentAt: number };

const contextWith = (overrides: Partial<WheelCommandContext> = {}): WheelCommandContext => ({
  synced: true,
  canEdit: true,
  repeat: false,
  spinning: false,
  requestSpin: () => ({ ok: true }),
  setSounds: () => ({ ok: true }),
  ...overrides,
});

const CANNOT_TELL = { ok: false, error: "outcomeUnknown" };
const NOTHING_ADDED = { ok: false, error: "notApplied", added: [] };

const named = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
const everySlot = (sent: Sent): number[] => sent.labels.map((_, index) => index);

const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
const replicaOf = (doc: Y.Doc): Y.Doc => {
  const replica = createWheelDoc();
  sync(doc, replica);
  return replica;
};

const device = (startAt: number) => {
  let now = startAt;
  return {
    send: (labels: string[]): Sent => ({ labels, tokens: labels.map(() => crypto.randomUUID()), sentAt: (now += 250) }),
  };
};

const add = (doc: Y.Doc, sent: Sent, overrides: Partial<WheelCommandContext> = {}) =>
  runWheelCommand(doc, "addEntries", { labels: sent.labels, tokens: sent.tokens, sentAt: sent.sentAt }, contextWith(overrides));

const ask = (doc: Y.Doc, sent: Sent, overrides: Partial<WheelCommandContext> = {}) =>
  runWheelCommand(doc, "addOutcome", { tokens: sent.tokens, sentAt: sent.sentAt }, contextWith(overrides));

describe("what the wheel says about an add whose reply was lost", () => {
  it("cannot tell, and never says nothing was added, once 13 later full pastes pushed its receipt out", () => {
    const phone = device(1_800_000_000_000);
    const doc = createWheelDoc();
    const lost = phone.send(named("First ", 64));
    expect(add(doc, lost)).toEqual({ ok: true, added: everySlot(lost) });
    clearEntries(doc);

    for (let paste = 1; paste <= 13; paste += 1) {
      expect(ask(doc, lost), `before paste ${paste}`).toEqual({ ok: true, added: everySlot(lost) });
      const later = phone.send(named(`P${paste} `, 64));
      expect(add(doc, later)).toEqual({ ok: true, added: everySlot(later) });
      clearEntries(doc);
    }

    for (const copy of [doc, replicaOf(doc)]) {
      expect(ask(copy, lost)).toEqual(CANNOT_TELL);
      expect(add(copy, lost, { repeat: true })).toEqual(CANNOT_TELL);
    }
    expect(getEntries(doc)).toEqual([]);
  });

  it("cannot tell once more adds than the receipt list holds came after it", () => {
    const phone = device(1_800_000_000_000);
    const doc = createWheelDoc();
    const lost = phone.send(["Ada"]);
    expect(add(doc, lost)).toEqual({ ok: true, added: [0] });
    for (let later = 0; later < WHEEL_RECEIPT_LIMITS.count; later += 1) {
      expect(ask(doc, lost), `before add ${later}`).toEqual({ ok: true, added: [0] });
      expect(add(doc, phone.send([`N${later}`])).ok).toBe(true);
      clearEntries(doc);
    }
    expect(ask(replicaOf(doc), lost)).toEqual(CANNOT_TELL);
  });

  it("still says nothing was added for names that never reached the wheel after older receipts were dropped", () => {
    const phone = device(1_800_000_000_000);
    const doc = createWheelDoc();
    for (let paste = 0; paste < 30; paste += 1) {
      expect(add(doc, phone.send(named(`P${paste} `, 64))).ok).toBe(true);
      clearEntries(doc);
    }
    const neverArrived = phone.send(["Ada", "Bo"]);
    expect(ask(doc, neverArrived)).toEqual(NOTHING_ADDED);
    expect(ask(replicaOf(doc), neverArrived)).toEqual(NOTHING_ADDED);
    expect(add(doc, neverArrived, { repeat: true })).toEqual(NOTHING_ADDED);
    expect(ask(doc, neverArrived, { synced: false })).toEqual({ ok: false, error: "notSynced" });
  });

  it("never says nothing was added about names the wheel did add, for any mix of devices, clocks and edits", { timeout: 30_000 }, () => {
    let seed = 20261127;
    const random = (limit: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
    let cannotTell = 0;
    let definite = 0;
    for (let run = 0; run < 24; run += 1) {
      const base = createWheelDoc();
      addEntries(base, ["Host"]);
      clearEntries(base);
      const skews = [0, 3_600_000, -3_600_000, 90_000];
      const phones = [0, 1, 2].map(() => ({ doc: replicaOf(base), clock: device(1_800_000_000_000 + skews[random(skews.length)]) }));
      const sends: { sent: Sent; phone: number; added: number[] | null }[] = [];
      for (let step = 0; step < 260; step += 1) {
        const index = random(phones.length);
        const phone = phones[index];
        const where = `run ${run} step ${step}`;
        switch (random(8)) {
          case 0:
          case 1:
          case 2: {
            const sent = phone.clock.send(named(`r${run}s${step} `, random(2) === 0 ? 64 : 1 + random(4)));
            const result = add(phone.doc, sent);
            sends.push({ sent, phone: index, added: result.ok ? (result.added ?? []) : [] });
            if (random(4) > 0) clearEntries(phone.doc);
            break;
          }
          case 3:
            sends.push({ sent: phone.clock.send(named(`r${run}lost${step} `, 1 + random(3))), phone: index, added: null });
            break;
          case 4:
            clearEntries(phone.doc);
            break;
          case 5: {
            const other = phones[random(phones.length)];
            sync(phone.doc, other.doc);
            sync(other.doc, phone.doc);
            break;
          }
          default: {
            const mine = sends.filter((item) => item.phone === index);
            if (mine.length === 0) break;
            const item = mine[random(mine.length)];
            const answer = random(2) === 0 ? ask(phone.doc, item.sent) : add(phone.doc, item.sent, { repeat: true });
            if (answer.ok) {
              expect(answer.added, where).toEqual(item.added);
              expect(item.added !== null && item.added.length > 0, where).toBe(true);
            } else if (answer.error === "notApplied") {
              expect(answer.added, where).toEqual([]);
              expect(item.added ?? [], where).toEqual([]);
              definite += 1;
            } else {
              expect(answer, where).toEqual(CANNOT_TELL);
              cannotTell += 1;
            }
            break;
          }
        }
        expect(phone.doc.getArray("wheel.addReceipts").length, where).toBeLessThanOrEqual(WHEEL_RECEIPT_LIMITS.count);
      }
    }
    expect(cannotTell).toBeGreaterThan(20);
    expect(definite).toBeGreaterThan(20);
  });
});

/**
 * What the host holds to when an app module or a client gets something
 * wrong: rows changed behind the store's back, colliding view keys, repeats
 * under rate pressure, hostile record keys, and views that outlive a grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { s, SchemaError, type Json } from "@conclave/apps-sdk/authority";
import { key } from "@conclave/apps-sdk/authority/server";
import { Client } from "../../config/classes/Client.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { AuthorityStore } from "../../server/apps/authority/store.js";
import { Harness, person } from "./harness.js";
import { pollsContract } from "@conclave/apps-sdk/polls/core";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { probeAuthority, probeContract } from "./fixtures/probe.js";

const host = person("asha@example.com", "Asha", "host");
const priya = person("priya@example.com", "Priya");
const ravi = person("ravi@example.com", "Ravi");

const field = (value: Json | null, ...path: string[]): Json | null => {
  let node: Json | null = value;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as { readonly [key: string]: Json })[key] ?? null;
  }
  return node;
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stored rows", () => {
  it("keeps the row as it was staged, whatever the handler does to its object after", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);

    const result = await hostTab.act("putThenGrow", { id: "a" });
    await room.deliver();
    const dumped = await hostTab.query("dump");

    expect(result).toEqual({ ok: true, value: null });
    expect(hostTab.row("notes", "a")).toEqual({ id: "a", text: "small" });
    expect(dumped.ok && field(dumped.value, "notes")).toEqual([
      { id: "a", text: "small", stars: 0 },
    ]);
  });

  it("freezes a committed row all the way down", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    await hostTab.act("putThenGrow", { id: "a" });

    const starred = await hostTab.act("star", { id: "a" });
    const dumped = await hostTab.query("dump");

    expect(starred).toEqual({ ok: false, code: "app-fault" });
    expect(dumped.ok && field(dumped.value, "notes")).toEqual([
      { id: "a", text: "small", stars: 0 },
    ]);
  });
});

describe("cleared rows", () => {
  it("counts each cleared row once when a prefix and then its group are cleared", () => {
    const store = new AuthorityStore(probeAuthority.runtime, DEFAULT_AUTHORITY_LIMITS);
    const mark = (n: number) => ({ noteId: "a", n, shown: false });
    store.transact((tx) => {
      tx.put("marks", key("a", "x", "1"), mark(1));
      tx.put("marks", key("a", "x", "2"), mark(2));
      tx.put("marks", key("a", "y", "1"), mark(3));
      tx.put("marks", key("b", "x", "1"), mark(4));
    });

    const seen = store.transact((tx) => {
      const inner = tx.clear("marks", key("a", "x"));
      const afterInner = [tx.count("marks", key("a")), tx.count("marks")];
      const outer = tx.clear("marks", key("a"));
      const afterOuter = [
        tx.count("marks", key("a")),
        tx.count("marks", key("a", "x")),
        tx.count("marks"),
      ];
      tx.put("marks", key("a", "x", "9"), mark(9));
      const again = tx.clear("marks", key("a", "x"));
      tx.put("marks", key("a", "x", "9"), mark(9));
      return {
        inner,
        afterInner,
        outer,
        afterOuter,
        again,
        scanned: tx.scan("marks").map(([rowKey]) => rowKey),
      };
    });

    expect(seen.ok && seen.value).toEqual({
      inner: 2,
      afterInner: [1, 2],
      outer: 1,
      afterOuter: [0, 0, 1],
      again: 1,
      scanned: [key("b", "x", "1"), key("a", "x", "9")],
    });
    expect([...store.rows("marks").keys()]).toEqual([key("b", "x", "1"), key("a", "x", "9")]);
  });
});

describe("projected keys", () => {
  it("keeps the first row when two rows claim one key, through the second's removal", async () => {
    const room = new Harness([probeAuthority], { runtime: { verifyViews: false } });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);

    await hostTab.act("put", { id: "first", text: "same text" });
    await room.deliver();
    await hostTab.act("put", { id: "second", text: "same text" });
    await room.deliver();
    const whileBoth = raviTab.row("byText", "same text");
    await hostTab.act("remove", { id: "second" });
    await room.deliver();

    expect(whileBoth).toEqual({ id: "first" });
    expect(raviTab.row("byText", "same text")).toEqual({ id: "first" });
    expect(raviTab.rows("notes").length).toBe(1);
  });

  it("lets one row take a key another row gave up in the same flush", async () => {
    const room = new Harness([probeAuthority]);
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);
    await hostTab.act("put", { id: "a", text: "one" });
    await hostTab.act("put", { id: "b", text: "two" });
    await room.deliver();

    // "b" takes the text "a" had, and "a" moves off it, in one window.
    await hostTab.act("put", { id: "b", text: "one" });
    await hostTab.act("put", { id: "a", text: "three" });
    await room.deliver();

    expect(raviTab.row("byText", "one")).toEqual({ id: "b" });
    expect(raviTab.row("byText", "three")).toEqual({ id: "a" });
    expect(raviTab.row("byText", "two")).toBeNull();
  });
});

describe("repeats under rate pressure", () => {
  it("replays a recorded answer even when the person's budget is spent", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const priyaTab = await room.open(priya, pollsContract);
    const created = await hostTab.act("create", { question: "Q", options: ["a", "b"] });
    const pollId = created.ok ? (field(created.value, "pollId") as string) : "";
    await room.deliver();

    const operation = { issuedAtMs: Date.now(), nonce: "op-vote-once" };
    await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });
    // Spend the rest of the vote budget on refused attempts.
    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      const result = await priyaTab.act("vote", { pollId, optionIds: ["nope"] });
      limited = !result.ok && result.code === "rate-limited";
    }
    const retried = await priyaTab.actWith(operation, "vote", { pollId, optionIds: ["o1"] });

    expect(limited).toBe(true);
    expect(retried).toEqual({ ok: true, value: null });
  });
});

describe("identity", () => {
  it("treats a signed-in account as verified even when its email starts with guest-", async () => {
    const room = new Harness([pollsAuthority]);
    const hostTab = await room.open(host, pollsContract);
    const created = await hostTab.act("create", { question: "Q", options: ["a", "b"] });
    const pollId = created.ok ? (field(created.value, "pollId") as string) : "";
    await room.deliver();

    const account = await room.open(
      person("guest-services@example.com", "Guest services"),
      pollsContract,
      { tokenEmail: "guest-services@example.com" },
    );
    const anonymous = await room.open(person("guest-abc123", "Anonymous"), pollsContract);

    expect((await account.act("vote", { pollId, optionIds: ["o1"] })).ok).toBe(true);
    expect(await anonymous.act("vote", { pollId, optionIds: ["o1"] })).toEqual({
      ok: false,
      code: "identity-required",
    });
  });
});

describe("a replacement that arrives in parts", () => {
  it("drops the old view as soon as the first part of the new one lands", async () => {
    const room = new Harness([probeAuthority], {
      runtime: { limits: { ...DEFAULT_AUTHORITY_LIMITS, chunkBytes: 400 } },
    });
    const hostTab = await room.open(host, probeContract);
    const raviTab = await room.open(ravi, probeContract);
    room.room.promoteClientToAdmin(raviTab.seat.id);
    for (let index = 0; index < 5; index += 1) {
      await hostTab.act("put", { id: `n${index}`, text: `${index}`.repeat(200) });
    }
    await room.deliver();
    await room.drain();
    expect(raviTab.rows("notes").length).toBe(5);

    // A demotion replaces the view. Watch what the tab holds part by part.
    Object.setPrototypeOf(raviTab.seat, Client.prototype);
    room.authority.membershipChanged();
    const held: number[] = [];
    for (let turn = 0; turn < 12; turn += 1) {
      await vi.advanceTimersByTimeAsync(1);
      held.push(raviTab.rows("notes").length);
    }

    // Never the old five beside a new generation: nothing, then the whole.
    const firstEmpty = held.indexOf(0);
    expect(firstEmpty).toBeGreaterThanOrEqual(0);
    expect(held.slice(firstEmpty).every((count) => count === 0 || count === 5)).toBe(true);
    expect(held[held.length - 1]).toBe(5);
    expect(new Set(held.slice(firstEmpty)).has(5)).toBe(true);
  });
});

describe("schemas", () => {
  it("refuses record keys that would set an object's prototype", () => {
    const votes = s.record(s.int({ min: 0 }), { maxKeys: 10 });
    const hostile = JSON.parse('{"__proto__": 7, "o1": 1}') as unknown;

    expect(() => votes.parse(hostile)).toThrow(SchemaError);
    expect(() => votes.parse({ constructor: 1 })).toThrow(SchemaError);
    expect(votes.parse({ o1: 1, o2: 0 })).toEqual({ o1: 1, o2: 0 });
  });

  it("drops unknown input fields and refuses unknown output fields", () => {
    const note = s.object({ id: s.string({ max: 8 }), text: s.optional(s.string({ max: 8 })) });

    expect(note.parse({ id: "a", extra: true, text: undefined })).toEqual({ id: "a" });
    expect(() => note.parse({ id: "a", extra: true }, "strict")).toThrow(SchemaError);
    expect(() => note.parse({ id: 4 })).toThrow(SchemaError);
  });
});

/**
 * What the host holds to when an app module or a client gets something
 * wrong: rows changed behind the store's back, colliding view keys, repeats
 * under rate pressure, hostile record keys, and views that outlive a grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_ID_MAX_LENGTH,
  appIdProblem,
  appIdSchema,
  defineContract,
  s,
  SchemaError,
  type Json,
} from "@conclave/apps-sdk/authority";
import { key } from "@conclave/apps-sdk/authority/server";
import { Client } from "../../config/classes/Client.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { AuthorityStore } from "../../server/apps/authority/store.js";
import { answer } from "./answer.js";
import { Harness, person } from "./harness.js";
import { pollsAuthority, pollsContract } from "./fixtures/polls.js";
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

    expect(answer(result)).toEqual({ ok: true, value: null });
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

describe("the transaction budget", () => {
  const mark = (noteId: string, n: number) => ({ noteId, n, shown: false });

  it("keeps the rows when a clear runs a handler out of budget and the handler carries on", () => {
    const store = new AuthorityStore(probeAuthority.runtime, {
      ...DEFAULT_AUTHORITY_LIMITS,
      transactionOps: 700,
    });
    for (const from of [0, 300]) {
      store.transact((tx) => {
        for (let n = from; n < from + 300; n += 1) tx.put("marks", key("a", String(n)), mark("a", n));
      });
    }

    // 695 operations spent, and clearing 600 rows costs ten more.
    const outcome = store.transact((tx) => {
      for (let turn = 0; turn < 695; turn += 1) tx.count("marks");
      try {
        return tx.clear("marks", key("a"));
      } catch {
        return "carried on";
      }
    });

    expect(outcome).toMatchObject({ ok: false, kind: "fault" });
    expect(store.rows("marks").size).toBe(600);
  });

  it("answers thousands of checks on lists inside a large workspace for what they find", () => {
    // Rows keyed workspace, list, item: 100 lists of 200 items in one workspace.
    const store = new AuthorityStore(probeAuthority.runtime, {
      ...DEFAULT_AUTHORITY_LIMITS,
      transactionOps: 6_000,
    });
    for (let list = 0; list < 100; list += 1) {
      store.transact((tx) => {
        for (let item = 0; item < 200; item += 1) {
          tx.put("marks", key("big", `list-${list}`, String(item)), mark("big", item));
        }
      });
    }
    store.transact((tx) => tx.put("marks", key("small", "list-0", "0"), mark("small", 0)));
    const cpuMs = (run: () => void): number => {
      const before = process.cpuUsage();
      run();
      const used = process.cpuUsage(before);
      return (used.user + used.system) / 1_000;
    };
    /** 5,000 checks of lists that hold nothing, and clears of 500 of them. */
    const checks = (workspace: string) => () => {
      const outcome = store.transact((tx) => {
        let found = 0;
        for (let check = 0; check < 5_000; check += 1) {
          found += tx.count("marks", key(workspace, `no-such-list-${check}`));
        }
        for (let check = 0; check < 500; check += 1) {
          found += tx.clear("marks", key(workspace, `no-such-list-${check}`));
        }
        return found;
      });
      if (!outcome.ok) throw new Error(`the checks failed: ${outcome.kind}`);
    };

    const small = cpuMs(checks("small"));
    const big = cpuMs(checks("big"));
    const oneList = store.transact((tx) => tx.scan("marks", key("big", "list-3")).length);
    // A list of 200 costs its 200 rows to read: a budget of 150 is not enough.
    const tight = new AuthorityStore(probeAuthority.runtime, {
      ...DEFAULT_AUTHORITY_LIMITS,
      transactionOps: 450,
    });
    tight.transact((tx) => {
      for (let item = 0; item < 200; item += 1) {
        tx.put("marks", key("big", "list-3", String(item)), mark("big", item));
      }
    });
    const twice = tight.transact((tx) => {
      tx.scan("marks", key("big", "list-3"));
      tx.scan("marks", key("big", "list-3"));
      tx.scan("marks", key("big", "list-3"));
    });

    // The same work whatever else the workspace holds, not a walk of all of it.
    expect(big).toBeLessThan(Math.max(small, 2) * 25);
    expect(oneList).toEqual({ ok: true, value: 200, changed: false });
    expect(twice).toMatchObject({ ok: false, kind: "fault" });
  });

  it("keeps a row and the rows under its key in the order they were written", () => {
    const store = new AuthorityStore(probeAuthority.runtime, DEFAULT_AUTHORITY_LIMITS);
    const keysUnder = (prefix: ReturnType<typeof key>) => {
      const scanned = store.transact((tx) => tx.scan("marks", prefix).map(([rowKey]) => rowKey));
      return scanned.ok ? scanned.value : [];
    };
    store.transact((tx) => tx.put("marks", key("a", "x"), mark("a", 1)));
    store.transact((tx) => tx.put("marks", key("a"), mark("a", 2)));
    store.transact((tx) => tx.put("marks", key("a", "y"), mark("a", 3)));
    store.transact((tx) => tx.put("marks", key("a", "x", "deep"), mark("a", 4)));

    const all = keysUnder(key("a"));
    const underX = keysUnder(key("a", "x"));
    store.transact((tx) => tx.delete("marks", key("a", "x")));
    const afterDelete = keysUnder(key("a"));
    const counted = store.transact((tx) => [
      tx.count("marks", key("a")),
      tx.count("marks", key("a", "x")),
      tx.count("marks", key("a", "y")),
      tx.count("marks", key("b")),
    ]);
    store.transact((tx) => tx.clear("marks", key("a", "x")));

    expect(all).toEqual([key("a", "x"), key("a"), key("a", "y"), key("a", "x", "deep")]);
    expect(underX).toEqual([key("a", "x"), key("a", "x", "deep")]);
    expect(afterDelete).toEqual([key("a"), key("a", "y"), key("a", "x", "deep")]);
    expect(counted.ok && counted.value).toEqual([3, 1, 1, 0]);
    expect(keysUnder(key("a"))).toEqual([key("a"), key("a", "y")]);
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
    expect(answer(retried)).toEqual({ ok: true, value: null });
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

  it("holds a string to its pattern, once its length is settled", () => {
    const slug = s.string({ max: 8, pattern: /^[a-z]+$/ });
    const cut = s.string({ max: 3, truncate: true, pattern: /^[a-z]+$/ });

    expect(slug.parse("abc")).toBe("abc");
    expect(() => slug.parse("Abc")).toThrow(/does not match/);
    expect(() => slug.parse("abc1")).toThrow(SchemaError);
    expect(() => slug.parse("a".repeat(9))).toThrow(/longer than 8/);
    // What is matched is what is kept.
    expect(cut.parse("abc9")).toBe("abc");
  });

  it("gives a string schema with a pattern the same answer on every call, and refuses a pattern that keeps state", () => {
    const slug = s.string({ max: 8, pattern: /^[a-z]+$/ });
    const answers = (input: string) =>
      Array.from({ length: 4 }, () => {
        try {
          return slug.parse(input);
        } catch (error) {
          return error instanceof SchemaError ? "refused" : "threw";
        }
      });

    expect(answers("abc")).toEqual(["abc", "abc", "abc", "abc"]);
    expect(answers("Abc")).toEqual(["refused", "refused", "refused", "refused"]);
    // test() on a global or sticky expression moves its lastIndex, so the
    // same input would be taken on one call and refused on the next.
    expect(() => s.string({ max: 8, pattern: /^[a-z]+$/g })).toThrow(/g or y flag/);
    expect(() => s.string({ max: 8, pattern: /^[a-z]+$/y })).toThrow(/g or y flag/);
    expect(() => s.string({ max: 8, pattern: /^[a-z]+$/i })).not.toThrow();
  });

  it("has one rule for an app id, and holds a contract to it", () => {
    const contract = (id: string) =>
      defineContract({ id, major: 1, surface: "panel", actions: {}, queries: {}, views: {} });
    const longest = `a${"b".repeat(APP_ID_MAX_LENGTH - 1)}`;

    expect(APP_ID_MAX_LENGTH).toBe(48);
    expect(appIdSchema.parse(longest)).toBe(longest);
    expect(appIdProblem(longest)).toBeNull();
    expect(contract(longest).id).toBe(longest);
    expect(appIdProblem(`${longest}b`)).toMatch(/^longer than 48\. /);
    expect(() => contract(`${longest}b`)).toThrow(/Invalid authority app id .*: longer than 48/);
    for (const id of ["", "3d", "Sign-Up", "sign_up", "sign up", "-sign"]) {
      expect(appIdProblem(id), id).toMatch(/^does not match /);
      expect(() => contract(id), id).toThrow(/Invalid authority app id/);
    }
    expect(appIdProblem(48)).toMatch(/^expected a string/);
    expect(appIdProblem("sign-up-2")).toBeNull();
  });
});

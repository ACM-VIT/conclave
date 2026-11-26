import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORITY_EVENTS,
  AUTHORITY_LIMITS,
  defineContract,
  s,
  type AuthorityResult,
  type Json,
  type OperationId,
} from "@conclave/apps-sdk/authority";
import {
  defineAuthority,
  key,
  reject,
  table,
  type Subject,
} from "@conclave/apps-sdk/authority/server";
import { AuthorityInstance } from "../../server/apps/authority/instance.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { ReceiptBook } from "../../server/apps/authority/receipts.js";
import { answer } from "./answer.js";
import { allViewsIn, guestTab, linkPasses, sameGuest, startWithLostAnswer } from "./guest-links.js";
import { Harness, person, type Tab } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

type Fault =
  | "merge"
  | "owner"
  | "project"
  | "ownerUndefined"
  | "projectUndefined"
  | "ownerAtCommit"
  | "projectAtCommit"
  | "ownerOnce"
  | "ownerTwice"
  | "ownerAlways";

const ownerCalls = { count: 0 };
const nothing: unknown = undefined;
type Note = { id: string; subject: Subject; moved: boolean };

const notesApp = (
  id: string,
  faults: {
    fault?: Fault;
    mergeBy?: number;
    rate?: { burst: number; perSecond: number };
    webinarOnlyMerge?: boolean;
    faultInProjection?: () => boolean;
  } = {},
) => {
  const calls = new Map<string, number>();
  const nthCall = (kind: string, row: Note) => {
    const name = `${kind} ${row.subject} ${row.id}`;
    const count = (calls.get(name) ?? 0) + 1;
    calls.set(name, count);
    return count;
  };
  const contract = defineContract({
    id,
    major: 1,
    surface: "panel",
    actions: {
      note: { input: s.object({ id: s.string({ min: 1, max: 32 }) }), receipt: s.null() },
      refuse: { input: s.object({ id: s.string({ min: 1, max: 32 }) }), receipt: s.null() },
    },
    queries: {},
    views: { mine: s.object({ id: s.string({ min: 1, max: 32 }) }) },
  });
  const authority = defineAuthority({
    contract,
    tables: { notes: table<Note>({ maxRows: 1_000 }) },
    timers: {},
    canView: ({ role }) => role === "moderator" || role === "member",
    actions: {
      note: {
        roles: ["moderator", "member"],
        rate: faults.rate ?? { burst: 1_000, perSecond: 1_000 },
        run(ctx, tx, input) {
          tx.put("notes", key(ctx.subject, input.id), { id: input.id, subject: ctx.subject, moved: false });
          return null;
        },
      },
      refuse: {
        roles: ["moderator", "member"],
        rate: { burst: 1_000, perSecond: 1_000 },
        run() {
          return reject("refused");
        },
      },
    },
    queries: {},
    onTimer: {},
    views: {
      mine: {
        kind: "personal",
        source: "notes",
        owner: (row) => {
          ownerCalls.count += 1;
          if (faults.fault === "owner" && row.moved) throw new Error(`${id}: the owner of a moved note failed`);
          if (faults.fault === "ownerUndefined" && row.moved) throw nothing;
          if (faults.fault === "ownerOnce" && nthCall("owner", row) === 1) {
            throw new Error(`${id}: the owner failed once`);
          }
          if (faults.fault === "ownerTwice" && nthCall("owner", row) <= 2) {
            throw new Error(`${id}: the owner failed twice`);
          }
          if (faults.fault === "ownerAlways" && row.id.startsWith("bad")) throw new Error(`${id}: the owner always fails`);
          if (faults.fault === "ownerAtCommit" && row.moved && nthCall("owner", row) === 2) {
            throw new Error(`${id}: the owner of a moved note failed while the merge committed`);
          }
          return row.subject;
        },
        project: (row, policy) => {
          if (faults.faultInProjection?.()) throw new Error("projection temporarily unavailable");
          if (faults.fault === "project" && row.moved) throw new Error(`${id}: a moved note failed to project`);
          if (faults.fault === "projectUndefined" && row.moved) throw nothing;
          if (faults.fault === "projectAtCommit" && row.moved && nthCall("project", row) === 2) {
            throw new Error(`${id}: a moved note failed to project while the merge committed`);
          }
          if (faults.webinarOnlyMerge && row.moved && policy.mode === "webinar") return null;
          return { key: row.id, value: { id: row.id } };
        },
      },
    },
    mergeSubjects(ctx, tx, { from, into }) {
      if (faults.fault === "merge") throw new Error(`${id}: the merge failed`);
      if (faults.webinarOnlyMerge && ctx.room.mode !== "webinar") throw new Error("merge requires webinar mode");
      if (faults.mergeBy !== undefined && ctx.now > faults.mergeBy) reject("too-late");
      for (const [, row] of tx.scan("notes", key(from))) {
        tx.delete("notes", key(from, row.id));
        tx.put("notes", key(into, row.id), { ...row, subject: into, moved: true });
      }
      return undefined;
    },
  });
  return { contract, authority };
};

let nonces = 0;
const operation = (): OperationId => ({ issuedAtMs: Date.now(), nonce: `op-${(nonces += 1)}-of-a-tab` });

const notesOf = (tab: Tab) => tab.rows("mine").map((row) => JSON.stringify(row)).sort();

describe("a guest merge where one of three apps faults (Sol)", () => {
  const cases = [0, 1, 2].flatMap((at) =>
    (["merge", "owner", "project", "ownerUndefined", "projectUndefined"] as const).flatMap((fault) =>
      [true, false].map((verifyViews) => ({ at, fault, verifyViews })),
    ),
  );

  it.each(cases)(
    "a $fault fault in app $at, views verified $verifyViews, leaves every app, receipt and identity as it was",
    async ({ at, fault, verifyViews }) => {
      const apps = [0, 1, 2].map((index) => notesApp(`notes-${index}`, index === at ? { fault } : {}));
      const room = new Harness(apps.map((app) => app.authority), { runtime: { verifyViews } });
      const tabs: Tab[] = [];
      for (const pass of ["pass-a", "pass-b"]) {
        for (const [index, app] of apps.entries()) tabs.push(await guestTab(room, app.contract, pass, `${pass}-${index}`));
      }
      const sent: Array<[Tab, OperationId, AuthorityResult<Json>]> = [];
      for (const [index, tab] of tabs.entries()) {
        const op = operation();
        const first = await tab.actWith(op, "note", { id: `n${index}` });
        expect(first.ok).toBe(true);
        sent.push([tab, op, first]);
      }
      await allViewsIn(room);
      const before = tabs.map(notesOf);

      linkPasses(room, "pass-b", "pass-a");
      await allViewsIn(room);

      expect(sameGuest(room, tabs[0], tabs[3])).toBe(false);
      expect(tabs.map(notesOf)).toEqual(before);
      for (const [index, [tab, op, first]] of sent.entries()) {
        expect(answer(await tab.actWith(op, "note", { id: `n${index}` }))).toEqual(answer(first));
      }
      await allViewsIn(room);
      expect(tabs.map(notesOf)).toEqual(before);
    },
    30_000,
  );

  it("moves every app's rows and receipts together when none faults", async () => {
    const apps = [0, 1, 2].map((index) => notesApp(`notes-${index}`));
    const room = new Harness(apps.map((app) => app.authority));
    const tabs: Tab[] = [];
    for (const pass of ["pass-a", "pass-b"]) {
      for (const [index, app] of apps.entries()) tabs.push(await guestTab(room, app.contract, pass, `${pass}-${index}`));
    }
    const sent: Array<[Tab, OperationId, AuthorityResult<Json>]> = [];
    for (const [index, tab] of tabs.entries()) {
      const op = operation();
      sent.push([tab, op, await tab.actWith(op, "note", { id: `n${index}` })]);
    }
    await allViewsIn(room);

    linkPasses(room, "pass-b", "pass-a");
    await allViewsIn(room);

    expect(sameGuest(room, tabs[0], tabs[3])).toBe(true);
    for (const index of [0, 1, 2]) {
      expect(notesOf(tabs[index])).toEqual([`{"id":"n${index}"}`, `{"id":"n${index + 3}"}`].sort());
      expect(notesOf(tabs[index + 3])).toEqual(notesOf(tabs[index]));
    }
    for (const [index, [tab, op, first]] of sent.entries()) {
      expect(answer(await tab.actWith(op, "note", { id: `n${index}` }))).toEqual(answer(first));
    }
  });
});

describe("a guest merge where one of three apps faults only while the merge commits (Sol)", () => {
  const cases = [0, 1, 2].flatMap((at) =>
    (["ownerAtCommit", "projectAtCommit"] as const).map((fault) => ({ at, fault })),
  );

  it.each(cases)("a $fault fault in app $at moves every app's rows and receipts, and the row is shown once the fault passes", async ({ at, fault }) => {
    const apps = [0, 1, 2].map((index) => notesApp(`notes-${index}`, index === at ? { fault } : {}));
    const room = new Harness(apps.map((app) => app.authority), { runtime: { verifyViews: false } });
    const tabs: Tab[] = [];
    for (const pass of ["pass-a", "pass-b"]) {
      for (const [index, app] of apps.entries()) tabs.push(await guestTab(room, app.contract, pass, `${pass}-${index}`));
    }
    const sent: Array<[Tab, OperationId, AuthorityResult<Json>]> = [];
    for (const [index, tab] of tabs.entries()) {
      const op = operation();
      sent.push([tab, op, await tab.actWith(op, "note", { id: `n${index}` })]);
    }
    await allViewsIn(room);
    ownerCalls.count = 0;

    linkPasses(room, "pass-b", "pass-a");
    expect(ownerCalls.count).toBe(3);
    await allViewsIn(room);

    expect(sameGuest(room, tabs[0], tabs[3])).toBe(true);
    for (const index of [0, 1, 2]) {
      const shown = [`{"id":"n${index}"}`, `{"id":"n${index + 3}"}`].sort();
      expect(notesOf(tabs[index])).toEqual(shown);
      expect(notesOf(tabs[index + 3])).toEqual(shown);
    }
    for (const [index, [tab, op, first]] of sent.entries()) {
      expect(answer(await tab.actWith(op, "note", { id: `n${index}` }))).toEqual(answer(first));
    }
  });
});

describe("with views verified, a view fault while committed rows are taken in (Sol)", () => {
  it("does not escape the commit, and the next flush reports it", async () => {
    const app = notesApp("notes", { fault: "ownerOnce" });
    const room = new Harness([app.authority], { runtime: { verifyViews: true } });
    const tab = await guestTab(room, app.contract, "pass-a", "tab-1");

    const committed = room.authority.act(tab.context, {
      roomEpoch: room.authority.roomEpoch,
      subscription: tab.frames.find((frame) => frame.kind === "replace")!.subscription,
      generation: 1,
      operation: operation(),
      action: "note",
      input: { id: "a" },
    });

    expect(committed.ok).toBe(true);
    expect(() => room.authority.flushNow()).toThrow(/the owner failed once/);
  });
});

describe("a row whose view callback faults while it is taken in (Sol)", () => {
  it("is shown once the owner stops failing, to the tab that holds the view and to a new one", async () => {
    const app = notesApp("notes", { fault: "ownerOnce" });
    const room = new Harness([app.authority], { runtime: { verifyViews: false } });
    const tab = await guestTab(room, app.contract, "pass-a", "tab-1");

    expect((await tab.act("note", { id: "a" })).ok).toBe(true);
    await allViewsIn(room);
    await room.advance(1_000);
    const fresh = await guestTab(room, app.contract, "pass-a", "tab-2");
    await allViewsIn(room);

    expect(notesOf(tab)).toEqual(['{"id":"a"}']);
    expect(notesOf(fresh)).toEqual(['{"id":"a"}']);
  });

  it("is shown once the owner stops failing on a later try, with nothing else written", async () => {
    const app = notesApp("notes", { fault: "ownerTwice" });
    const room = new Harness([app.authority], { runtime: { verifyViews: false } });
    const tab = await guestTab(room, app.contract, "pass-a", "tab-1");

    expect((await tab.act("note", { id: "a" })).ok).toBe(true);
    for (let turn = 0; turn < 10; turn += 1) await vi.advanceTimersByTimeAsync(100);

    expect(notesOf(tab)).toEqual(['{"id":"a"}']);
  });

  it("is tried again only a few times when its owner always fails", async () => {
    const app = notesApp("notes", { fault: "ownerAlways" });
    const room = new Harness([app.authority], { runtime: { verifyViews: false } });
    const tab = await guestTab(room, app.contract, "pass-a", "tab-1");
    ownerCalls.count = 0;

    expect((await tab.act("note", { id: "bad" })).ok).toBe(true);
    expect((await tab.act("note", { id: "fine" })).ok).toBe(true);
    for (let second = 0; second < 30; second += 1) await room.advance(1_000);

    expect(notesOf(tab)).toEqual(['{"id":"fine"}']);
    expect(ownerCalls.count).toBeLessThanOrEqual(8);
  });
});

describe("a guest link plan (Sol)", () => {
  const withNotes = async (room: Harness, contract: ReturnType<typeof notesApp>["contract"]) => {
    const onA = await guestTab(room, contract, "pass-a", "tab-1");
    const onB = await guestTab(room, contract, "pass-b", "tab-2");
    expect((await onA.act("note", { id: "a" })).ok).toBe(true);
    expect((await onB.act("note", { id: "b" })).ok).toBe(true);
    await allViewsIn(room);
    return { onA, onB };
  };

  it("plans the merge under the current policy even before the policy sweep", async () => {
    const app = notesApp("notes", { webinarOnlyMerge: true });
    const room = new Harness([app.authority]);
    const { onA, onB } = await withNotes(room, app.contract);

    room.setWebinar(true);
    const link = room.room.planGuestLink([{ guestProof: "pass-a" }], "pass-b");

    expect(link?.recordable).toBe(true);
    expect(room.room.commitGuestLink(link!).linked).toBe(true);
    await allViewsIn(room);
    expect(sameGuest(room, onA, onB)).toBe(true);
    expect(notesOf(onA)).toEqual(['{"id":"a"}']);
    expect(notesOf(onB)).toEqual(notesOf(onA));
  });

  it.each(["before the sweep", "after the sweep", "after close"] as const)(
    "refuses a stale merge %s",
    async (when) => {
      const app = notesApp("notes");
      const room = new Harness([app.authority]);
      const { onA, onB } = await withNotes(room, app.contract);
      const link = room.room.planGuestLink([{ guestProof: "pass-a" }], "pass-b");
      expect(link?.recordable).toBe(true);

      if (when === "after close") {
        room.authority.close();
      } else {
        room.setWebinar(true, false);
        if (when === "after the sweep") await vi.advanceTimersByTimeAsync(10);
      }

      expect(room.room.commitGuestLink(link!)).toEqual({ linked: false });
      expect(sameGuest(room, onA, onB)).toBe(false);
    },
  );

  it("is not recorded when a pass took on app state after the plan", async () => {
    const app = notesApp("notes");
    const room = new Harness([app.authority]);
    const onA = await guestTab(room, app.contract, "pass-a", "tab-1");
    const onB = await guestTab(room, app.contract, "pass-b", "tab-2");
    expect((await onA.act("note", { id: "a" })).ok).toBe(true);
    const link = room.room.planGuestLink([{ guestProof: "pass-a" }], "pass-b");
    expect(link?.recordable).toBe(true);
    expect((await onB.act("note", { id: "b" })).ok).toBe(true);

    expect(room.room.commitGuestLink(link!).linked).toBe(false);
    await allViewsIn(room);

    expect(sameGuest(room, onA, onB)).toBe(false);
    expect(notesOf(onA)).toEqual(['{"id":"a"}']);
    expect(notesOf(onB)).toEqual(['{"id":"b"}']);
  });

  it("commits the merge it staged, and does not run it again with a later clock", async () => {
    const mergeBy = Date.now() + 1_000;
    const app = notesApp("notes", { mergeBy });
    const room = new Harness([app.authority]);
    const onA = await guestTab(room, app.contract, "pass-a", "tab-1");
    const onB = await guestTab(room, app.contract, "pass-b", "tab-2");
    expect((await onA.act("note", { id: "a" })).ok).toBe(true);
    expect((await onB.act("note", { id: "b" })).ok).toBe(true);
    await allViewsIn(room);

    const link = room.room.planGuestLink([{ guestProof: "pass-a" }], "pass-b");
    expect(link?.recordable).toBe(true);
    vi.setSystemTime(mergeBy + 5_000);
    room.room.commitGuestLink(link!);
    await allViewsIn(room);

    expect(sameGuest(room, onA, onB)).toBe(true);
    expect(notesOf(onB)).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });
});

it("repairs a transient snapshot projection fault in a quiet room", async () => {
  const projectFault = vi.fn<() => boolean>(() => false);
  const app = notesApp("notes", { faultInProjection: projectFault });
  const room = new Harness([app.authority], { runtime: { verifyViews: false } });
  const onA = await guestTab(room, app.contract, "pass-a", "tab-1");
  expect((await onA.act("note", { id: "a" })).ok).toBe(true);
  await allViewsIn(room);
  onA.session.close();
  await vi.advanceTimersByTimeAsync(1_000);

  projectFault.mockReturnValueOnce(true);
  const fresh = await room.open(onA.who, app.contract, { quiet: true });
  expect(fresh.state.kind).toBe("ready");
  expect(notesOf(fresh)).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);

  expect(notesOf(fresh)).toEqual(['{"id":"a"}']);
  const later = await room.open(onA.who, app.contract, { quiet: true });
  expect(notesOf(later)).toEqual(notesOf(fresh));
});

const startReplacement = (tab: Tab) => {
  const frame = tab.frames.find((item) => item.kind === "replace")!;
  tab.session.receive({ ...frame, generation: frame.generation + 1, last: false });
  expect(tab.state.kind).toBe("connecting");
  return frame;
};

it.each([0, 1])("does not send when the view becomes ready %i ms past the action deadline", async (past) => {
  const app = notesApp("notes");
  const room = new Harness([app.authority]);
  const tab = await room.open(person("ana@example.com", "Ana"), app.contract);
  const frame = startReplacement(tab);
  const emit = vi.spyOn(tab.socket, "emit");
  const result = tab.session.act("note", { id: "expired" });
  vi.setSystemTime(Date.now() + AUTHORITY_LIMITS.operationMaxAgeMs - 1_600 + past);
  tab.session.receive({ ...frame, generation: frame.generation + 1, part: 1, last: true });
  await vi.advanceTimersByTimeAsync(0);

  expect(emit.mock.calls.filter(([event]) => event === AUTHORITY_EVENTS.act)).toEqual([]);
  expect(await result).toEqual({ ok: false, code: "unknown-outcome" });
});

const waits = ["readiness", "ack", "lost retry", "rate-limit retry", "resubscribe retry"] as const;
const endings = ["close", "dispose", "revoke"] as const;
const cancelledWaits = waits.flatMap((wait) => endings.map((ending) => ({ wait, ending })));

it.each(cancelledWaits)("ends the $wait wait immediately on $ending", async ({ wait, ending }) => {
  const app = notesApp("notes");
  const room = new Harness([app.authority]);
  const tab = await room.open(person("ana@example.com", "Ana"), app.contract, { ackTimeoutMs: 100 });
  const frame = tab.frames.find((item) => item.kind === "replace")!;
  if (wait === "readiness") startReplacement(tab);
  const socket = tab.socket as unknown as {
    emit: (event: string, payload?: unknown, ack?: (reply: unknown) => void) => void;
  };
  const { emit: send } = socket;
  let sends = 0;
  vi.spyOn(socket, "emit").mockImplementation((event, payload, ack) => {
    if (event !== AUTHORITY_EVENTS.act) return send.call(socket, event, payload, ack);
    sends += 1;
    if (wait === "rate-limit retry" && sends === 2) ack?.({ ok: false, code: "rate-limited", retryAfterMs: 30_000 });
    if (wait === "resubscribe retry") ack?.({ ok: false, code: "stale-generation" });
  });
  const outcome: { result?: AuthorityResult<Json> } = {};
  void tab.session.act("note", { id: "pending" }).then((result) => {
    outcome.result = result;
  });
  await vi.advanceTimersByTimeAsync(wait === "rate-limit retry" ? 501 : wait === "lost retry" ? 101 : 0);
  const sentBeforeCancellation = wait === "readiness" ? 0 : wait === "rate-limit retry" ? 2 : 1;
  expect(sends).toBe(sentBeforeCancellation);
  expect(outcome.result).toBeUndefined();

  if (ending === "close") tab.session.close();
  if (ending === "dispose") tab.client.dispose();
  if (ending === "revoke") {
    tab.session.receive({
      kind: "revoke",
      reason: "forbidden",
      subscription: frame.subscription,
      generation: frame.generation,
      serverNowMs: Date.now(),
    });
  }
  await vi.advanceTimersByTimeAsync(0);

  expect(outcome.result).toEqual({ ok: false, code: ending === "revoke" ? "forbidden" : "unknown-outcome" });
  expect(sends).toBe(sentBeforeCancellation);
});

describe("a resend that meets the socket's act limit (Sol)", () => {
  it("is sent again until the saved answer comes back", async () => {
    const app = notesApp("notes");
    const room = new Harness([app.authority]);
    const tab = await guestTab(room, app.contract, "pass-a", "tab-1");
    const socket = tab.socket as unknown as {
      emit: (event: string, payload?: unknown, ack?: (reply: unknown) => void) => void;
    };
    const { answer: pending } = await startWithLostAnswer(room, tab, "note", { id: "once" });
    const send = socket.emit;
    let throttled = false;
    socket.emit = (event, payload, ack) => {
      if (event === AUTHORITY_EVENTS.act && !throttled) {
        throttled = true;
        for (let index = 0; index < 100; index += 1) send.call(socket, AUTHORITY_EVENTS.act, null, () => undefined);
      }
      return send.call(socket, event, payload, ack);
    };

    const result = await room.settle(pending);
    await allViewsIn(room);

    expect(throttled).toBe(true);
    expect(answer(result)).toEqual({ ok: true, value: null });
    expect(tab.rows("mine")).toEqual([{ id: "once" }]);
  });
});

describe("a resend that the action's own rate limit holds off past the id's deadline (Greptile)", () => {
  it("ends as unknown-outcome by the deadline instead of waiting out the limit", async () => {
    const app = notesApp("notes", { rate: { burst: 1, perSecond: 1 / 3_600 } });
    const room = new Harness([app.authority]);
    const tab = await guestTab(room, app.contract, "pass-a", "tab-1");
    expect((await tab.act("note", { id: "first" })).ok).toBe(true);
    const socket = tab.socket as unknown as {
      emit: (event: string, payload?: unknown, ack?: (reply: unknown) => void) => void;
    };
    const send = socket.emit;
    let dropped = false;
    socket.emit = (event, payload, ack) => {
      if (event === AUTHORITY_EVENTS.act && !dropped) {
        dropped = true;
        return;
      }
      send.call(socket, event, payload, ack);
    };
    const outcome: { result?: AuthorityResult<Json> } = {};
    void (tab.session.act("note", { id: "second" }) as Promise<AuthorityResult<Json>>).then((result) => {
      outcome.result = result;
    });

    for (let second = 0; second < 130 && !outcome.result; second += 1) await room.advance(1_000);

    expect(dropped).toBe(true);
    expect(outcome.result).toEqual({ ok: false, code: "unknown-outcome" });
  });
});

describe("an action whose answers never come back (Sol)", () => {
  it("ends as unknown-outcome by the id's deadline, however long the socket waits for an answer", async () => {
    const app = notesApp("notes");
    const room = new Harness([app.authority]);
    const tab = await room.open(person("ana@example.com", "Ana"), app.contract, { ackTimeoutMs: 600_000 });
    const socket = tab.socket as unknown as {
      emit: (event: string, payload?: unknown, ack?: (reply: unknown) => void) => void;
    };
    const send = socket.emit;
    let sends = 0;
    socket.emit = (event, payload, ack) => {
      if (event !== AUTHORITY_EVENTS.act) return send.call(socket, event, payload, ack);
      sends += 1;
      return send.call(socket, event, payload, () => undefined);
    };
    const outcome: { result?: AuthorityResult<Json> } = {};
    void (tab.session.act("note", { id: "unanswered" }) as Promise<AuthorityResult<Json>>).then((result) => {
      outcome.result = result;
    });

    for (let second = 0; second < 130 && !outcome.result; second += 1) await room.advance(1_000);

    expect(sends).toBeGreaterThan(0);
    expect(outcome.result).toEqual({ ok: false, code: "unknown-outcome" });
    expect(tab.rows("mine")).toEqual([{ id: "unanswered" }]);
  });
});

describe("saved answers when two subjects merge, against the per-person cap (Sol)", () => {
  const from = "subject-from" as Subject;
  const into = "subject-into" as Subject;
  const limits = { ...DEFAULT_AUTHORITY_LIMITS, receiptsPerSubject: 4 };
  const now = 1_000_000;
  const op = (nonce: string, issuedAtMs = now) => ({ issuedAtMs, nonce: `nonce-${nonce}` });
  const ok = { ok: true as const, value: null };

  it("fits when the merged answers are within the cap, once expired ones are dropped", () => {
    const book = new ReceiptBook(limits);
    for (const nonce of ["a", "b", "c"]) book.record(from, op(nonce, now - 200_000), "digest", ok);
    book.record(from, op("d"), "digest", ok);
    for (const nonce of ["e", "f", "g"]) book.record(into, op(nonce), "digest", ok);

    expect(book.mergeFits([{ from, into }], now)).toBe(true);
    book.merge(from, into);

    expect(book.size).toBe(4);
    expect(["d", "e", "f", "g"].map((nonce) => book.replay(into, op(nonce), "digest"))).toEqual([ok, ok, ok, ok]);
  });

  it("does not fit when the merged unexpired answers pass the cap, and drops none of them", () => {
    const book = new ReceiptBook(limits);
    for (const nonce of ["a", "b", "c"]) book.record(from, op(nonce), "digest", ok);
    for (const nonce of ["e", "f"]) book.record(into, op(nonce), "digest", ok);

    expect(book.mergeFits([{ from, into }], now)).toBe(false);
    expect(book.size).toBe(5);
    expect(["a", "b", "c"].every((nonce) => book.holds(from, op(nonce)))).toBe(true);
  });

  it("counts a subject's expired answers out of its cap at once", () => {
    const book = new ReceiptBook(limits);
    expect(book.hasRoom(from, now)).toBe(true);
    for (const nonce of ["a", "b", "c", "d"]) book.record(from, op(nonce, now - 119_500), "digest", ok);
    expect(book.hasRoom(from, now)).toBe(false);

    expect(book.hasRoom(from, now + 600)).toBe(true);
  });

  it("are swept on a timer once they expire, with no new action", async () => {
    const app = notesApp("notes");
    const room = new Harness([app.authority]);
    const tab = await guestTab(room, app.contract, "pass-a", "tab-1");
    expect((await tab.act("note", { id: "a" })).ok).toBe(true);
    expect(room.authority.receiptsHeld).toBe(1);

    await room.advance(2 * DEFAULT_AUTHORITY_LIMITS.operationMaxAgeMs + 1_000);

    expect(room.authority.receiptsHeld).toBe(0);
  });

  it("refuses an app's merge whose answers would not fit", () => {
    const app = notesApp("notes");
    const instance = new AuthorityInstance("notes.1", app.authority, { mode: "meeting", qaEnabled: true }, {
      limits,
      random: { next: () => 0, int: () => 0, shuffle: (list) => [...list] },
      verifyViews: true,
    });
    const actor = (subject: Subject) => ({ subject, role: "member" as const, verified: true, displayName: "Gita" });
    for (const nonce of ["a", "b", "c"]) {
      expect(instance.act(actor(from), "note", { id: nonce }, op(nonce), now).ok).toBe(true);
    }
    for (const nonce of ["e", "f"]) {
      expect(instance.act(actor(into), "note", { id: nonce }, op(nonce), now).ok).toBe(true);
    }

    expect(instance.stageMerge([{ from, into }], now)).toBeNull();
    expect(instance.act(actor(from), "note", { id: "a" }, op("a"), now)).toEqual({ ok: true, value: null });
  });

  it("cannot commit a staged merge once refused answers have pushed it past the cap", () => {
    const app = notesApp("notes");
    const instance = new AuthorityInstance("notes.1", app.authority, { mode: "meeting", qaEnabled: true }, {
      limits,
      random: { next: () => 0, int: () => 0, shuffle: (list) => [...list] },
      verifyViews: true,
    });
    const actor = (subject: Subject) => ({ subject, role: "member" as const, verified: true, displayName: "Gita" });
    for (const nonce of ["a", "b"]) expect(instance.act(actor(from), "note", { id: nonce }, op(nonce), now).ok).toBe(true);
    for (const nonce of ["e", "f"]) expect(instance.act(actor(into), "note", { id: nonce }, op(nonce), now).ok).toBe(true);
    const staged = instance.stageMerge([{ from, into }], now);
    expect(staged?.fresh()).toBe(true);

    expect(instance.act(actor(from), "refuse", { id: "c" }, op("c"), now)).toEqual({ ok: false, code: "rejected", reason: "refused" });

    expect(staged?.fresh()).toBe(false);
  });
});

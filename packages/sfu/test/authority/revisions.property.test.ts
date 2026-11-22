/**
 * View versions over random interleavings of actions, flushes, sockets that
 * fall behind and recover, fresh tabs, new subscriptions and policy changes.
 * Two properties hold in every run:
 *
 * (a) When a client's version reaches the one an answer named, its view
 *     already shows the action: it equals the viewer's committed view at
 *     the moment of the action or later.
 * (b) A member's frames and answers, versions included, are the same
 *     whether or not other people cast votes the member cannot see, before
 *     or after the member's snapshots.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AUTHORITY_EVENTS,
  type AuthorityFrame,
  type AuthorityResult,
  type Json,
} from "@conclave/apps-sdk/authority";
import type { CommittedView } from "../../server/apps/authority/views.js";
import { Harness, person, type Tab } from "./harness.js";
import { pollsAuthority, pollsContract } from "./fixtures/polls.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const random = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const VOTERS = 6;
const HIDDEN_POLLS = 2;

type Op =
  | { kind: "create"; by: "h1" | "h2" }
  | { kind: "end"; by: "h1" | "h2"; poll: number }
  | { kind: "share"; poll: number }
  | { kind: "vote"; by: number; poll: number; option: number }
  | { kind: "memberVote"; poll: number; option: number }
  | { kind: "hiddenVote"; by: number; poll: number }
  | { kind: "deliver" }
  | { kind: "behind"; who: "h2" | "m1" }
  | { kind: "recover" }
  | { kind: "freshTab" }
  | { kind: "resubscribe" }
  | { kind: "policy" };

const opsFor = (seed: number, steps: number): Op[] => {
  const next = random(seed);
  const pick = (n: number) => Math.floor(next() * n);
  const ops: Op[] = [];
  for (let step = 0; step < steps; step += 1) {
    const roll = next();
    // Weighted toward what has gone wrong before: a co-host who falls behind
    // and repeats an end or a share that someone else already made.
    if (roll < 0.08) ops.push({ kind: "create", by: next() < 0.5 ? "h1" : "h2" });
    else if (roll < 0.2) ops.push({ kind: "end", by: next() < 0.5 ? "h1" : "h2", poll: pick(4) });
    else if (roll < 0.26) ops.push({ kind: "share", poll: pick(4) });
    else if (roll < 0.36) ops.push({ kind: "vote", by: pick(VOTERS), poll: pick(4), option: pick(2) });
    else if (roll < 0.41) ops.push({ kind: "memberVote", poll: pick(4), option: pick(2) });
    else if (roll < 0.58) ops.push({ kind: "hiddenVote", by: pick(VOTERS), poll: pick(HIDDEN_POLLS) });
    else if (roll < 0.74) ops.push({ kind: "deliver" });
    else if (roll < 0.82) ops.push({ kind: "behind", who: next() < 0.7 ? "h2" : "m1" });
    else if (roll < 0.86) ops.push({ kind: "recover" });
    else if (roll < 0.9) ops.push({ kind: "freshTab" });
    else if (roll < 0.95) ops.push({ kind: "resubscribe" });
    else ops.push({ kind: "policy" });
  }
  return ops;
};

type Internals = {
  bySocket: Map<string, Map<string, { actor: unknown; instance: { committedView(actor: unknown): CommittedView } }>>;
};

/** A viewer's committed view, sorted as `Tab.held()` sorts what a client holds. */
const committedFor = (room: Harness, tab: Tab): string | null => {
  const subscription = [...tab.frames].reverse().find((frame) => frame.kind === "replace")?.subscription;
  if (!subscription) return null;
  const internals = room.authority as unknown as Internals;
  const held = internals.bySocket.get(tab.seat.socket.id)?.get(subscription);
  if (!held) return null;
  const view = held.instance.committedView(held.actor);
  const triples: [string, string, Json][] = [];
  for (const bucket of Object.keys(pollsContract.views)) {
    for (const key of view.keys(bucket)) triples.push([bucket, key, view.get(bucket, key)!]);
  }
  return JSON.stringify(triples.sort());
};

const versionOf = (tab: Tab): number => (tab.state.kind === "ready" ? tab.state.revision : -1);

/** A frame as a member sees it, less what differs only by chance: ids and clocks. */
const seen = (frame: AuthorityFrame): string => {
  const { subscription: _subscription, serverNowMs: _serverNowMs, ...rest } = frame;
  return JSON.stringify(rest);
};

const run = async (ops: Op[], withHidden: boolean) => {
  // Both runs start at the same moment, so timestamps in rows agree.
  vi.setSystemTime(1_000_000);
  const behind = new Set<string>();
  const room = new Harness([pollsAuthority], {
    runtime: {
      pressure: (socket) => (behind.has(socket.id) ? { packets: 300, bytes: 0 } : { packets: 0, bytes: 0 }),
    },
  });
  const h1 = await room.open(person("asha@example.com", "Asha", "host"), pollsContract);
  const h2 = await room.open(person("dev@example.com", "Dev", "host"), pollsContract);
  const voters: Tab[] = [];
  for (let index = 0; index < VOTERS; index += 1) {
    voters.push(await room.open(person(`voter${index}@example.com`, `Voter ${index}`), pollsContract));
  }
  // Through the client, which reads an answer's version as it reads its
  // view's, and without moving the clock, so flushes happen only where a
  // step asks for one.
  // A tab with no view yet has nothing to press, and its client would wait
  // for a view the test clock never brings.
  const act = async (tab: Tab, action: string, input: unknown): Promise<AuthorityResult<Json>> =>
    tab.state.kind !== "ready"
      ? { ok: false, code: "not-subscribed" }
      : (tab.session as unknown as { act(name: string, input: unknown): Promise<AuthorityResult<Json>> }).act(
          action,
          input,
        );
  const hidden: string[] = [];
  for (let index = 0; index < HIDDEN_POLLS; index += 1) {
    const made = await act(h1, "create", { question: `Hidden ${index}`, options: ["A", "B"] });
    if (made.ok) hidden.push((made.value as { pollId: string }).pollId);
  }
  await room.deliver();
  const ravi = person("ravi@example.com", "Ravi");
  const m1Tabs: Tab[] = [await room.open(ravi, pollsContract)];
  const polls: string[] = [];
  let webinar = false;

  const observed = () => [h1, h2, ...voters, ...m1Tabs];
  const moments: Map<Tab, string | null>[] = [];
  const record = () => moments.push(new Map(observed().map((tab) => [tab, committedFor(room, tab)])));
  const outstanding: { tab: Tab; revision: number; moment: number; what: string }[] = [];
  const violations: string[] = [];
  const answers: string[] = [];

  const answered = (tab: Tab, what: string, result: AuthorityResult<Json>) => {
    record();
    if (m1Tabs.includes(tab)) answers.push(JSON.stringify(result));
    if (result.ok && result.revision !== undefined) {
      outstanding.push({ tab, revision: result.revision, moment: moments.length - 1, what });
    }
  };
  const check = (step: number) => {
    for (const waiting of [...outstanding]) {
      if (versionOf(waiting.tab) < waiting.revision) continue;
      outstanding.splice(outstanding.indexOf(waiting), 1);
      const view = waiting.tab.held();
      const shown = moments
        .slice(waiting.moment)
        .some((moment) => moment.get(waiting.tab) === view);
      if (!shown) {
        violations.push(`step ${step}: version ${waiting.revision} reached before the view showed ${waiting.what}`);
      }
    }
  };
  const deliver = () => room.deliver();

  for (let step = 0; step < ops.length; step += 1) {
    const op = ops[step];
    switch (op.kind) {
      case "create": {
        const tab = op.by === "h1" ? h1 : h2;
        const made = await act(tab, "create", { question: `Poll ${step}`, options: ["A", "B"] });
        if (made.ok) polls.push((made.value as { pollId: string }).pollId);
        answered(tab, `create at ${step}`, made);
        break;
      }
      case "end":
      case "share": {
        if (polls.length === 0) break;
        const pollId = polls[op.poll % polls.length];
        const tab = op.kind === "share" || op.by === "h1" ? h1 : h2;
        const input = op.kind === "end" ? { pollId } : { pollId, shared: true };
        answered(tab, `${op.kind} at ${step}`, await act(tab, op.kind, input));
        break;
      }
      case "vote":
      case "memberVote": {
        if (polls.length === 0) break;
        const tab = op.kind === "vote" ? voters[op.by] : m1Tabs[m1Tabs.length - 1];
        const pollId = polls[op.poll % polls.length];
        answered(tab, `vote at ${step}`, await act(tab, "vote", { pollId, optionIds: [op.option ? "o2" : "o1"] }));
        break;
      }
      case "hiddenVote": {
        if (!withHidden) break;
        await act(voters[op.by], "vote", { pollId: hidden[op.poll], optionIds: ["o1"] });
        break;
      }
      case "deliver":
        await deliver();
        break;
      case "behind":
        behind.add((op.who === "h2" ? h2 : m1Tabs[m1Tabs.length - 1]).seat.socket.id);
        break;
      case "recover":
        await deliver();
        behind.clear();
        await vi.advanceTimersByTimeAsync(300);
        await deliver();
        break;
      case "freshTab":
        await deliver();
        m1Tabs.push(await room.open(ravi, pollsContract, { session: `ravi-${step}` }));
        break;
      case "resubscribe": {
        await deliver();
        const tab = m1Tabs[m1Tabs.length - 1];
        const last = [...tab.frames].reverse().find((frame) => frame.kind === "replace");
        if (!last) break;
        // A frame out of sequence: the client subscribes again.
        tab.seat.socket.emit(AUTHORITY_EVENTS.frame, {
          kind: "patch",
          subscription: last.subscription,
          generation: last.generation,
          serverNowMs: Date.now(),
          seq: 999,
          put: [],
          remove: [],
        } satisfies AuthorityFrame);
        await room.idle();
        break;
      }
      case "policy":
        await deliver();
        webinar = !webinar;
        room.setWebinar(webinar);
        break;
    }
    if (op.kind !== "create" && op.kind !== "end" && op.kind !== "share" && op.kind !== "vote" && op.kind !== "memberVote") {
      record();
    }
    check(step);
  }
  // Everything delivered and every socket caught up: no answer is left waiting.
  await deliver();
  behind.clear();
  await vi.advanceTimersByTimeAsync(300);
  await deliver();
  record();
  check(ops.length);
  for (const waiting of outstanding) {
    violations.push(`version ${waiting.revision} for ${waiting.what} was never reached`);
  }
  // Poll ids are random. Both runs create the polls in the same order, so
  // each id is named by the order it was made in.
  const named = (text: string): string =>
    [...hidden, ...polls].reduce((out, id, index) => out.replaceAll(id, `poll-${index}`), text);
  const member = m1Tabs.map((tab) => tab.frames.map((frame) => named(seen(frame))));
  return { violations, member, answers: answers.map(named) };
};

it("reaches an answer's version only once the view shows the action, and never shows a member what it cannot see", async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 24; seed += 1) {
    const ops = opsFor(seed, 60);
    const withHidden = await run(ops, true);
    const without = await run(ops, false);
    for (const violation of [...withHidden.violations, ...without.violations]) {
      failures.push(`seed ${seed}: ${violation}`);
    }
    if (JSON.stringify(withHidden.member) !== JSON.stringify(without.member)) {
      failures.push(`seed ${seed}: the member's frames differ when others vote out of their sight`);
    }
    if (JSON.stringify(withHidden.answers) !== JSON.stringify(without.answers)) {
      failures.push(`seed ${seed}: the member's answers differ when others vote out of their sight`);
    }
  }
  expect(failures).toEqual([]);
}, 120_000);

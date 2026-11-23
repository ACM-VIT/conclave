/**
 * What one viewer is told of a clear, and when their view version moves,
 * depends on nothing but the rows that viewer held. Random runs of cards,
 * private rows, clears, flushes and fresh tabs, with a small per-flush
 * budget for cleared rows, are played three times: as they are, without the
 * fresh tabs, and without anyone else's private rows. An existing viewer's
 * frames and answers must be byte for byte the same in all three.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthorityFrame, AuthorityResult, Json } from "@conclave/apps-sdk/authority";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { Harness, person, type Tab } from "./harness.js";
import { ledgerAuthority, ledgerContract } from "./fixtures/ledger.js";

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

const OTHERS = 3;
const CARD_IDS = 8;
const SECRET_IDS = 5;

type Op =
  | { kind: "card"; by: "host" | "alice" | "other"; other: number; id: number; text: number }
  | { kind: "aliceSecret"; id: number; text: number }
  | { kind: "otherSecret"; by: number; id: number; text: number }
  | { kind: "wipe" }
  | { kind: "aliceForget" }
  | { kind: "otherForget"; by: number }
  | { kind: "fresh"; alice: boolean }
  | { kind: "deliver" };

const opsFor = (seed: number, steps: number): Op[] => {
  const next = random(seed);
  const pick = (count: number) => Math.floor(next() * count);
  const ops: Op[] = [];
  for (let step = 0; step < steps; step += 1) {
    const roll = next();
    if (roll < 0.22) {
      const who = pick(3);
      ops.push({
        kind: "card",
        by: who === 0 ? "host" : who === 1 ? "alice" : "other",
        other: pick(OTHERS),
        id: pick(CARD_IDS),
        text: pick(3),
      });
    } else if (roll < 0.34) ops.push({ kind: "aliceSecret", id: pick(SECRET_IDS), text: pick(3) });
    else if (roll < 0.5) ops.push({ kind: "otherSecret", by: pick(OTHERS), id: pick(SECRET_IDS), text: pick(3) });
    else if (roll < 0.58) ops.push({ kind: "wipe" });
    else if (roll < 0.62) ops.push({ kind: "aliceForget" });
    else if (roll < 0.67) ops.push({ kind: "otherForget", by: pick(OTHERS) });
    else if (roll < 0.8) ops.push({ kind: "fresh", alice: next() < 0.3 });
    else ops.push({ kind: "deliver" });
  }
  return ops;
};

/** A frame as its viewer sees it, less what differs only by chance: ids and clocks. */
const seen = (frame: AuthorityFrame): string => {
  const { subscription: _subscription, serverNowMs: _serverNowMs, ...rest } = frame;
  return JSON.stringify(rest);
};

const run = async (
  ops: Op[],
  { withFresh, withOthers }: { withFresh: boolean; withOthers: boolean },
) => {
  vi.setSystemTime(1_000_000);
  const room = new Harness([ledgerAuthority], {
    runtime: {
      limits: {
        ...DEFAULT_AUTHORITY_LIMITS,
        clearedRowsPerFlush: 2,
        mutationsPerSecond: 1_000_000,
        mutationBurst: 1_000_000,
      },
    },
  });
  const host = await room.open(person("asha@example.com", "Asha", "host"), ledgerContract);
  const alice = person("alice@example.com", "Alice");
  const aliceTab = await room.open(alice, ledgerContract);
  const others: Tab[] = [];
  for (let index = 0; index < OTHERS; index += 1) {
    others.push(await room.open(person(`other${index}@example.com`, `Other ${index}`), ledgerContract));
  }
  // Through the client, and without moving the clock, so flushes happen
  // only where a step asks for one.
  const act = async (tab: Tab, action: string, input: unknown): Promise<AuthorityResult<Json>> =>
    tab.state.kind !== "ready"
      ? { ok: false, code: "not-subscribed" }
      : (tab.session as unknown as { act(name: string, input: unknown): Promise<AuthorityResult<Json>> }).act(
          action,
          input,
        );
  const answers: string[] = [];

  for (let step = 0; step < ops.length; step += 1) {
    const op = ops[step];
    // Every run is at the same moment at every step, whatever it skips, so
    // each socket's allowance refills alike. Setting the clock runs no timer.
    vi.setSystemTime(1_000_000 + (step + 1) * 1_000);
    switch (op.kind) {
      case "card": {
        const tab = op.by === "host" ? host : op.by === "alice" ? aliceTab : others[op.other];
        const result = await act(tab, "card", { id: `c${op.id}`, text: `text ${op.text}` });
        if (tab === aliceTab) answers.push(JSON.stringify(result));
        break;
      }
      case "aliceSecret":
        answers.push(JSON.stringify(await act(aliceTab, "secret", { id: `s${op.id}`, text: `text ${op.text}` })));
        break;
      case "otherSecret":
        if (!withOthers) break;
        await act(others[op.by], "secret", { id: `s${op.id}`, text: `text ${op.text}` });
        break;
      case "wipe":
        await act(host, "wipe", null);
        break;
      case "aliceForget":
        answers.push(JSON.stringify(await act(aliceTab, "forget", null)));
        break;
      case "otherForget":
        if (!withOthers) break;
        await act(others[op.by], "forget", null);
        break;
      case "fresh":
        // Someone opens the app with nothing flushed: their snapshot is read
        // in the middle of what is pending, a clear's owed rows included.
        if (!withFresh) break;
        await room.open(
          op.alice ? alice : person(`fresh${step}@example.com`, "Fresh"),
          ledgerContract,
          { quiet: true, ...(op.alice ? { session: `alice-${step}` } : {}) },
        );
        break;
      case "deliver":
        await room.deliver();
        break;
    }
  }
  // Every batch of every clear told.
  for (let flush = 0; flush < 40; flush += 1) await room.deliver();
  return {
    frames: aliceTab.frames.map(seen),
    answers,
    held: aliceTab.held(),
  };
};

/** Where two runs first part, to say what differed. */
const firstDifference = (a: string[], b: string[]): string => {
  const index = a.findIndex((item, at) => item !== b[at]);
  const at = index === -1 ? Math.min(a.length, b.length) : index;
  return ` at ${at}: ${a[at] ?? "(none)"} | ${b[at] ?? "(none)"}`;
};

it("tells a viewer of a clear only by the rows they held, whoever else opened the app or kept rows", async () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 24; seed += 1) {
    const ops = opsFor(seed, 60);
    const full = await run(ops, { withFresh: true, withOthers: true });
    const noFresh = await run(ops, { withFresh: false, withOthers: true });
    const noOthers = await run(ops, { withFresh: true, withOthers: false });
    if (JSON.stringify(full.frames) !== JSON.stringify(noFresh.frames)) {
      failures.push(
        `seed ${seed}: Alice's frames differ when others open the app${firstDifference(full.frames, noFresh.frames)}`,
      );
    }
    if (JSON.stringify(full.answers) !== JSON.stringify(noFresh.answers)) {
      failures.push(`seed ${seed}: Alice's answers differ when others open the app`);
    }
    if (JSON.stringify(full.frames) !== JSON.stringify(noOthers.frames)) {
      failures.push(
        `seed ${seed}: Alice's frames differ when others keep private rows${firstDifference(full.frames, noOthers.frames)}`,
      );
    }
    if (JSON.stringify(full.answers) !== JSON.stringify(noOthers.answers)) {
      failures.push(`seed ${seed}: Alice's answers differ when others keep private rows`);
    }
    if (full.held !== noFresh.held || full.held !== noOthers.held) {
      failures.push(`seed ${seed}: Alice ends up holding a different view`);
    }
  }
  expect(failures).toEqual([]);
}, 180_000);

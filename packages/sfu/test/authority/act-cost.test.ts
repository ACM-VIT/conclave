/**
 * What answering one action costs must not grow with what else is waiting
 * for the next flush: a large clear, or many other writes. Each case runs
 * 240 actions before a flush and bounds the work, by projections counted in
 * the app and by how the time scales with the size of what waits.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthorityResult, Json } from "@conclave/apps-sdk/authority";
import { DEFAULT_AUTHORITY_LIMITS } from "../../server/apps/authority/limits.js";
import { Harness, person, type Tab } from "./harness.js";
import { ledgerAuthority, ledgerContract, ledgerCounters } from "./fixtures/ledger.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const ACTS = 240;
const limits = {
  ...DEFAULT_AUTHORITY_LIMITS,
  mutationsPerSecond: 1_000_000,
  mutationBurst: 1_000_000,
};

type Room = { room: Harness; host: Tab; alice: Tab; others: Tab[] };

/** Changed or owed rows the app's views have looked at in their checks so far. */
const viewWork = (room: Harness): number => {
  const internals = room.authority as unknown as { instances: Map<string, { viewWork: number }> };
  return [...internals.instances.values()].reduce((total, instance) => total + instance.viewWork, 0);
};

/** 240 of Alice's actions before a flush, after `prepare`, timed and counted. */
const actsAfter = async (
  prepare: (room: Room) => Promise<void>,
  text: (index: number) => string = (index) => `answer ${index}`,
  id: (index: number) => string = (index) => `a${index % 40}`,
) => {
  const room = new Harness([ledgerAuthority], { runtime: { limits } });
  const host = await room.open(person("asha@example.com", "Asha", "host"), ledgerContract);
  const alice = await room.open(person("alice@example.com", "Alice"), ledgerContract);
  const others: Tab[] = [];
  for (let index = 0; index < 3; index += 1) {
    others.push(await room.open(person(`other${index}@example.com`, `Other ${index}`), ledgerContract));
  }
  await prepare({ room, host, alice, others });
  ledgerCounters.projections = 0;
  const flushesBefore = room.authority.stats.flushes;
  const examinedBefore = viewWork(room);
  const started = process.hrtime.bigint();
  let refused = 0;
  // Through the client, without moving any timer, so the flush the first
  // action asked for waits until the last has been answered.
  const session = alice.session as unknown as {
    act(name: string, input: unknown): Promise<AuthorityResult<Json>>;
  };
  for (let index = 0; index < ACTS; index += 1) {
    // The socket's own allowance refills with time. Setting the clock runs
    // no timer.
    vi.setSystemTime(Date.now() + 50);
    const answer = await session.act("card", { id: id(index), text: text(index) });
    if (!answer.ok) refused += 1;
  }
  const flushesMeanwhile = room.authority.stats.flushes - flushesBefore;
  const examined = viewWork(room) - examinedBefore;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const projections = ledgerCounters.projections;
  await room.deliver();
  return { ms, projections, refused, flushesMeanwhile, examined };
};

const clearShared = (rows: number) => async ({ room, host }: Room) => {
  await host.act("deal", { count: rows });
  await room.deliver();
  await host.act("wipe", null);
};

const clearPersonal = (rows: number) => async ({ room, host, others }: Room) => {
  for (const other of others) await other.act("stash", { count: Math.ceil(rows / others.length) });
  await room.deliver();
  await host.act("wipe", null);
};

it("answers each action after a large shared clear at the cost of one after a small one", async () => {
  const small = await actsAfter(clearShared(1_000));
  const large = await actsAfter(clearShared(5_000));

  expect([small.refused, large.refused]).toEqual([0, 0]);
  expect([small.flushesMeanwhile, large.flushesMeanwhile]).toEqual([0, 0]);
  // Each action projects its own row for the two roles that hold a view,
  // and looks at no cleared row to answer.
  expect(large.projections).toBeLessThanOrEqual(3 * ACTS);
  expect(large.examined).toBeLessThanOrEqual(2 * ACTS);
  // Five times the cleared rows, and the actions take about as long.
  expect(large.ms).toBeLessThan(small.ms * 1.6 + 60);
});

it("answers each action after a large clear of people's own rows at the cost of one after a small one", async () => {
  const small = await actsAfter(clearPersonal(1_000));
  const large = await actsAfter(clearPersonal(5_000));

  expect([small.refused, large.refused]).toEqual([0, 0]);
  expect([small.flushesMeanwhile, large.flushesMeanwhile]).toEqual([0, 0]);
  expect(large.projections).toBeLessThanOrEqual(3 * ACTS);
  expect(large.examined).toBeLessThanOrEqual(2 * ACTS);
  expect(large.ms).toBeLessThan(small.ms * 1.6 + 60);
});

it("projects each of 240 large writes once per audience, not once per action after it", async () => {
  const big = await actsAfter(
    async () => {},
    (index) => `${index}`.padEnd(4_096, "x"),
    (index) => `big${index}`,
  );

  expect(big.refused).toBe(0);
  expect(big.flushesMeanwhile).toBe(0);
  expect(big.projections).toBeLessThanOrEqual(3 * ACTS);
  expect(big.examined).toBeLessThanOrEqual(2 * ACTS);
});

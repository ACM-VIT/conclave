import { describe, expect, it } from "vitest";
import { createBatchStore, createOutbox, type OutboxDeps } from "../src/app/lib/telemetry-outbox";
import { type OutboxModule, type SimResult, simulate } from "./support/outbox-sim";
import { PARTIAL_HANDOFF, PARTIAL_RETRY, THREAD_CASES } from "./support/outbox-sim-cases";

const RUNS = Number(process.env.OUTBOX_SIM_RUNS ?? 300);
const FIRST_SEED = Number(process.env.OUTBOX_SIM_FIRST_SEED ?? 1);

describe("the outbox in a simulated browser", () => {
  it.each(THREAD_CASES.map((thread) => [thread.name, thread] as const))("%s", async (_name, thread) => {
    const result = await simulate(thread.seed, undefined, undefined, thread.scenario);

    for (const [metric, minimum] of Object.entries(thread.covers)) {
      expect(result[metric as keyof typeof thread.covers], metric).toBeGreaterThanOrEqual(minimum);
    }
    expect(result.violations).toEqual([]);
    expect(result.delivered + result.refused).toBe(result.events);
    if (thread.posts !== undefined) expect(result.posts).toBe(thread.posts);
  });

  const standIn = (mutate: (deps: OutboxDeps) => OutboxDeps): OutboxModule => ({
    createBatchStore,
    createOutbox: (deps) => createOutbox(mutate(deps)),
  });

  it("catches an outbox that ignores Retry-After on a partial reply", async () => {
    const mutant = standIn((deps) => ({
      ...deps,
      post: async (...args) => ({ ...(await deps.post(...args)), retryAfter: null }),
    }));
    const result = await simulate(4661287478, mutant, undefined, PARTIAL_RETRY);
    expect(result.violations.map(({ kind }) => kind)).toContain("sent before its Retry-After");
  });

  it("catches a replay that ignores the stored not-before after a partial reply", async () => {
    const mutant = standIn((deps) => ({
      ...deps,
      store: {
        ...deps.store,
        facts: (id) => {
          const facts = deps.store.facts(id);
          return facts && { ...facts, notBefore: 0 };
        },
      },
    }));
    const result = await simulate(4661287478, mutant, undefined, PARTIAL_HANDOFF);
    expect(result.violations.map(({ kind }) => kind)).toContain("sent before its Retry-After");
  });

  it("catches an outbox that treats refused writes as successful", async () => {
    const mutant = standIn((deps) => ({
      ...deps,
      store: {
        ...deps.store,
        save: (batch) => {
          deps.store.save(batch);
          return true;
        },
      },
    }));
    const result = await simulate(4661287478, mutant, undefined, {
      ...PARTIAL_RETRY,
      profile: { ...PARTIAL_RETRY.profile, refuseRate: 1 },
      actions: [...(PARTIAL_RETRY.actions ?? []), { at: 7000, act: "hide", tab: 1 }],
    });
    expect(result.refusedWrites).toBeGreaterThan(0);
    expect(result.violations.map(({ kind }) => kind)).toContain("work left with no owner");
  });

  it(`keeps every invariant over ${RUNS} random runs of 1 to 3 tabs`, async () => {
    const failures: Array<Pick<SimResult, "seed" | "violations">> = [];
    const totals = { runs: 0, multiTab: 0, aborted: 0, refusedWrites: 0, retryAfters: 0, closes: 0, counted: 0, races: 0, throttles: 0, lockRejects: 0, readFailures: 0, partials: 0 };
    for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS && failures.length < 5; seed++) {
      const result = await simulate(seed);
      totals.runs += 1;
      if (result.tabs > 1) totals.multiTab += 1;
      totals.aborted += result.aborted;
      totals.refusedWrites += result.refusedWrites;
      totals.retryAfters += result.retryAfters;
      totals.closes += result.closes;
      totals.counted += result.counted;
      totals.races += result.races;
      totals.throttles += result.throttles;
      totals.lockRejects += result.lockRejects;
      totals.readFailures += result.readFailures;
      totals.partials += result.partials;
      if (result.violations.length > 0) failures.push({ seed, violations: result.violations.slice(0, 3) });
    }

    expect(failures).toEqual([]);
    expect(totals.runs).toBe(RUNS);
    for (const [name, total] of Object.entries(totals)) expect(total, name).toBeGreaterThan(0);
  }, 900_000);
});

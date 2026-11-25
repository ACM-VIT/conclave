import { describe, expect, it } from "vitest";
import { type SimResult, simulate } from "./support/outbox-sim";
import { THREAD_CASES } from "./support/outbox-sim-cases";

const RUNS = Number(process.env.OUTBOX_SIM_RUNS ?? 300);
const FIRST_SEED = Number(process.env.OUTBOX_SIM_FIRST_SEED ?? 1);

describe("the outbox in a simulated browser", () => {
  it.each(THREAD_CASES.map((thread) => [thread.name, thread] as const))("%s", async (_name, thread) => {
    const result = await simulate(thread.seed, undefined, undefined, thread.scenario);

    expect(result.violations).toEqual([]);
    expect(result.delivered).toBe(result.events);
    if (thread.posts !== undefined) expect(result.posts).toBe(thread.posts);
  });

  it(`keeps every invariant over ${RUNS} random runs of 1 to 3 tabs`, async () => {
    const failures: Array<Pick<SimResult, "seed" | "violations">> = [];
    const totals = { runs: 0, multiTab: 0, aborted: 0, refusedWrites: 0, retryAfters: 0, closes: 0, counted: 0, races: 0, throttles: 0, lockRejects: 0, readFailures: 0 };
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
      if (result.violations.length > 0) failures.push({ seed, violations: result.violations.slice(0, 3) });
    }

    expect(failures).toEqual([]);
    expect(totals.runs).toBe(RUNS);
    for (const [name, total] of Object.entries(totals)) expect(total, name).toBeGreaterThan(0);
  }, 900_000);
});

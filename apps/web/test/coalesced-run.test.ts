import { describe, expect, it } from "vitest";
import { createCoalescedRunner } from "../src/app/lib/coalesced-run";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A task the test finishes by hand, recording every run and how many overlap.
const createTaskLog = () => {
  const started: string[] = [];
  const finishers: Array<(error?: Error) => void> = [];
  let running = 0;
  let maxRunning = 0;
  const task =
    (label: string) =>
    (): Promise<void> => {
      started.push(label);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<void>((resolve, reject) => {
        finishers.push((error) => {
          running -= 1;
          if (error) reject(error);
          else resolve();
        });
      });
    };
  const finishNow = (error?: Error) => {
    const finish = finishers.shift();
    if (!finish) throw new Error("no run is in flight");
    finish(error);
  };
  const finishNext = async (error?: Error) => {
    finishNow(error);
    await flush();
  };
  return {
    task,
    started,
    finishNow,
    finishNext,
    get inFlight() {
      return finishers.length;
    },
    get maxRunning() {
      return maxRunning;
    },
  };
};

describe("createCoalescedRunner", () => {
  it("starts a request at once when nothing is running", async () => {
    const run = createCoalescedRunner();
    const log = createTaskLog();

    const done = run(log.task("a"));
    await flush();
    expect(log.started).toEqual(["a"]);

    await log.finishNext();
    await expect(done).resolves.toBeUndefined();
  });

  it("answers a burst during a run with one follow-up run", async () => {
    const run = createCoalescedRunner();
    const log = createTaskLog();
    const settled: string[] = [];

    void run(log.task("first")).then(() => settled.push("first"));
    await flush();
    const burst = ["b1", "b2", "b3"].map((label) =>
      run(log.task(label)).then(() => settled.push(label)),
    );
    await flush();
    expect(log.started).toEqual(["first"]);

    await log.finishNext();
    expect(settled).toEqual(["first"]);
    expect(log.started).toEqual(["first", "b3"]);

    await log.finishNext();
    await Promise.all(burst);
    expect(settled).toEqual(["first", "b1", "b2", "b3"]);
    expect(log.started).toEqual(["first", "b3"]);
    expect(log.maxRunning).toBe(1);
  });

  it("never overlaps runs while a burst hands over to its follow-up", async () => {
    const run = createCoalescedRunner();
    const log = createTaskLog();

    void run(log.task("first"));
    void run(log.task("queued"));
    await flush();
    // Ask again at every microtask step while the first run settles and the
    // follow-up takes over.
    log.finishNow();
    for (let step = 0; step < 12; step += 1) {
      await Promise.resolve();
      void run(log.task(`step ${step}`));
    }
    await flush();
    while (log.inFlight > 0) await log.finishNext();

    expect(log.maxRunning).toBe(1);
    expect(log.started.length).toBeLessThanOrEqual(3);
  });

  it("still runs the follow-up when the current run fails", async () => {
    const run = createCoalescedRunner();
    const log = createTaskLog();

    const failed = run(log.task("first"));
    const followUp = run(log.task("retry"));
    await flush();

    await log.finishNext(new Error("lost"));
    await expect(failed).rejects.toThrow("lost");
    expect(log.started).toEqual(["first", "retry"]);

    await log.finishNext();
    await expect(followUp).resolves.toBeUndefined();
  });

  it("starts fresh once a burst has drained", async () => {
    const run = createCoalescedRunner();
    const log = createTaskLog();

    void run(log.task("first"));
    void run(log.task("follow-up"));
    await flush();
    await log.finishNext();
    await log.finishNext();

    void run(log.task("next"));
    await flush();
    expect(log.started).toEqual(["first", "follow-up", "next"]);
    await log.finishNext();
  });
});

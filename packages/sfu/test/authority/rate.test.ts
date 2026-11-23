/**
 * The per-person rate buckets, and what cleaning them up may and may not do.
 */
import { describe, expect, it } from "vitest";
import { RateBuckets } from "../../server/apps/authority/rate.js";

/** Q&A's `ask`: a short burst, then one question every ten seconds. */
const ASK = { burst: 3, perSecond: 0.1 };
const UPVOTE = { burst: 10, perSecond: 2 };

describe("cleaning up rate buckets", () => {
  it("keeps a cooldown that is still running, however full the table is", () => {
    const buckets = new RateBuckets(4);
    let now = 1_000_000;
    const asked = [0, 1, 2, 3].map(() => buckets.take("priya/ask", ASK, now));

    // A second later the table fills with other people's first actions,
    // which is when buckets are cleaned up.
    now += 1_000;
    for (let index = 0; index < 8; index += 1) buckets.take(`other-${index}/ask`, ASK, now);
    const afterOneSecond = buckets.take("priya/ask", ASK, now);
    // Ten seconds from her last question, she has one more.
    now += 9_000;
    const afterTen = [buckets.take("priya/ask", ASK, now), buckets.take("priya/ask", ASK, now)];

    expect(asked.map((verdict) => verdict.ok)).toEqual([true, true, true, false]);
    expect(afterOneSecond.ok).toBe(false);
    expect(afterOneSecond).toMatchObject({ retryAfterMs: expect.closeTo(9_000, -1) as number });
    expect(afterTen.map((verdict) => verdict.ok)).toEqual([true, false]);
  });

  it("drops a bucket once it has refilled, which changes nothing", () => {
    const buckets = new RateBuckets(4);
    let now = 1_000_000;
    for (let index = 0; index < 4; index += 1) buckets.take(`voter-${index}/upvote`, UPVOTE, now);
    const heldWhileCooling = buckets.size;

    // Half a second gives each of them their one upvote back.
    now += 500;
    buckets.take("late/upvote", UPVOTE, now);

    expect(heldWhileCooling).toBe(4);
    expect(buckets.size).toBe(1);
    // A dropped bucket and a refilled one answer alike: the full burst.
    const again = Array.from({ length: 11 }, () => buckets.take("voter-0/upvote", UPVOTE, now));
    expect(again.filter((verdict) => verdict.ok).length).toBe(10);
  });

  it("holds more buckets than its mark while they are all still cooling", () => {
    const buckets = new RateBuckets(4);
    const now = 1_000_000;
    // Ten people ask in the same instant. None of their cooldowns may be lost.
    for (let index = 0; index < 10; index += 1) {
      for (let question = 0; question < 3; question += 1) buckets.take(`asker-${index}/ask`, ASK, now);
    }

    expect(buckets.size).toBe(10);
    expect(
      Array.from({ length: 10 }, (_, index) => buckets.take(`asker-${index}/ask`, ASK, now + 1_000).ok),
    ).toEqual(Array(10).fill(false));
  });

  it("never drops a bucket that does not refill", () => {
    const buckets = new RateBuckets(2);
    let now = 1_000_000;
    const once = { burst: 1, perSecond: 0 };
    buckets.take("one-shot", once, now);
    now += 3_600_000;
    for (let index = 0; index < 6; index += 1) buckets.take(`other-${index}`, UPVOTE, now);

    expect(buckets.take("one-shot", once, now).ok).toBe(false);
  });
});

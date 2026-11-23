import type { RateLimit } from "@conclave/apps-sdk/authority/server";

type Bucket = {
  tokens: number;
  refilledAt: number;
  /** When it is back at its full burst, or never if it does not refill. */
  fullAt: number;
};

export type RateVerdict = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Token buckets keyed by whatever the caller limits: a subject and action, or
 * a whole app instance. Per-socket limits already exist; these follow the
 * person across tabs, which a per-socket limit cannot.
 */
export class RateBuckets {
  private readonly buckets = new Map<string, Bucket>();
  /** No bucket has refilled before this moment, so none is looked for. */
  private cleanAfter = 0;

  /** `cleanAt` is how many buckets there are before the refilled ones go. */
  constructor(private readonly cleanAt: number) {}

  get size(): number {
    return this.buckets.size;
  }

  take(key: string, limit: RateLimit, now: number): RateVerdict {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.cleanAt && now >= this.cleanAfter) {
        this.clean(now);
      }
      bucket = { tokens: limit.burst, refilledAt: now, fullAt: now };
      this.buckets.set(key, bucket);
    } else if (now > bucket.refilledAt) {
      const refill = ((now - bucket.refilledAt) / 1000) * limit.perSecond;
      bucket.tokens = Math.min(limit.burst, bucket.tokens + refill);
      bucket.refilledAt = now;
    }
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    const short = limit.burst - bucket.tokens;
    bucket.fullAt =
      short <= 0
        ? now
        : limit.perSecond > 0
          ? now + (short / limit.perSecond) * 1000
          : Number.POSITIVE_INFINITY;
    this.cleanAfter = Math.min(this.cleanAfter, bucket.fullAt);

    return allowed
      ? { ok: true }
      : {
          ok: false,
          retryAfterMs: Math.ceil(((1 - bucket.tokens) / limit.perSecond) * 1000),
        };
  }

  /**
   * Drops every bucket that has refilled. Such a bucket and no bucket answer
   * alike, with the full burst, so dropping it changes nothing.
   *
   * A bucket still short of its burst is a cooldown in progress, and it
   * stays however many there are. Dropping one would hand its owner a full
   * burst early: someone who had used up their questions could ask again
   * after a pause of a second. So `cleanAt` is where cleaning starts, not a
   * ceiling. What can pile up past it is one bucket for each person and
   * action still cooling down, which the room's size bounds.
   */
  private clean(now: number): void {
    let next = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.fullAt <= now) this.buckets.delete(key);
      else next = Math.min(next, bucket.fullAt);
    }
    this.cleanAfter = next;
  }
}

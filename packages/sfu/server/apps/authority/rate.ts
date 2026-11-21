import type { RateLimit } from "@conclave/apps-sdk/authority/server";

type Bucket = { tokens: number; refilledAt: number };

export type RateVerdict = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Token buckets keyed by whatever the caller limits: a subject and action, or
 * a whole app instance. Per-socket limits already exist; these follow the
 * person across tabs, which a per-socket limit cannot.
 */
export class RateBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxBuckets: number) {}

  take(key: string, limit: RateLimit, now: number): RateVerdict {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) this.prune(now);
      bucket = { tokens: limit.burst, refilledAt: now };
      this.buckets.set(key, bucket);
    } else if (now > bucket.refilledAt) {
      const refill = ((now - bucket.refilledAt) / 1000) * limit.perSecond;
      bucket.tokens = Math.min(limit.burst, bucket.tokens + refill);
      bucket.refilledAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return {
      ok: false,
      retryAfterMs: Math.ceil(((1 - bucket.tokens) / limit.perSecond) * 1000),
    };
  }

  /** Drops the buckets idle longest. A dropped bucket simply starts full. */
  private prune(now: number): void {
    const idle = [...this.buckets].sort(
      ([, a], [, b]) => a.refilledAt - b.refilledAt,
    );
    const drop = Math.max(1, Math.floor(idle.length / 4));
    for (const [key, bucket] of idle.slice(0, drop)) {
      if (now - bucket.refilledAt < 1_000) break;
      this.buckets.delete(key);
    }
  }
}

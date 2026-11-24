export const INGEST_RATE_LIMITS = { perClient: 120, total: 6000 } as const;
export const INGEST_WINDOW_MS = 60_000;

export type FixedWindow = { take: (now: number) => boolean };

export const createFixedWindow = (limit: number): FixedWindow => {
  let startedAt = Number.NEGATIVE_INFINITY;
  let count = 0;
  return {
    take(now) {
      if (now - startedAt >= INGEST_WINDOW_MS) {
        startedAt = now;
        count = 0;
      }
      if (count >= limit) return false;
      count += 1;
      return true;
    },
  };
};

export const INGEST_QUOTA_URL = "https://ingest-quota.internal/take";

export class IngestQuota {
  readonly #site = createFixedWindow(INGEST_RATE_LIMITS.total);

  async fetch(): Promise<Response> {
    return new Response(null, { status: this.#site.take(Date.now()) ? 204 : 429 });
  }
}

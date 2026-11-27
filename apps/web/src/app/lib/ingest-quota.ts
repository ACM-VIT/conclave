import { z } from "zod";

export const INGEST_RATE_LIMITS = { perClient: 120, total: 6000 } as const;
export const INGEST_WINDOW_MS = 60_000;

type Window = { startedAt: number; count: number };

const admit = (window: Window | null, limit: number, now: number): { admitted: boolean; window: Window } => {
  const current = window && now - window.startedAt < INGEST_WINDOW_MS ? window : { startedAt: now, count: 0 };
  if (current.count >= limit) return { admitted: false, window: current };
  return { admitted: true, window: { startedAt: current.startedAt, count: current.count + 1 } };
};

export type FixedWindow = { take: (now: number) => boolean };

export const createFixedWindow = (limit: number): FixedWindow => {
  let window: Window | null = null;
  return {
    take(now) {
      const next = admit(window, limit, now);
      window = next.window;
      return next.admitted;
    },
  };
};

export type QuotaStorage = {
  sql: { exec: (query: string, ...bindings: Array<string | number>) => { toArray: () => unknown[] } };
  transactionSync: <T>(run: () => T) => T;
};

const StoredWindow = z.object({ started_at: z.number(), count: z.number().int().min(0) });

export const INGEST_QUOTA_URL = "https://ingest-quota.internal/take";

export class IngestQuota {
  readonly #storage: QuotaStorage;

  constructor(state: { storage: QuotaStorage }) {
    this.#storage = state.storage;
    this.#storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS site_window (id INTEGER PRIMARY KEY CHECK (id = 0), started_at INTEGER NOT NULL, count INTEGER NOT NULL)",
    );
  }

  async fetch(): Promise<Response> {
    const admitted = this.#storage.transactionSync(() => {
      const [row] = this.#storage.sql.exec("SELECT started_at, count FROM site_window WHERE id = 0").toArray();
      const stored = StoredWindow.safeParse(row);
      const window = stored.success ? { startedAt: stored.data.started_at, count: stored.data.count } : null;
      const next = admit(window, INGEST_RATE_LIMITS.total, Date.now());
      if (next.admitted) {
        this.#storage.sql.exec(
          "INSERT INTO site_window (id, started_at, count) VALUES (0, ?, ?) ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at, count = excluded.count",
          next.window.startedAt,
          next.window.count,
        );
      }
      return next.admitted;
    });
    return new Response(null, { status: admitted ? 204 : 429 });
  }
}

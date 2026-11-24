import { getCloudflareContext } from "@opennextjs/cloudflare";
import { rateLimitClientKey } from "./unfurl-rate-limit";

export const INGEST_RATE_LIMITS = { perClient: 120, total: 6000 } as const;
const WINDOW_MS = 60_000;
const MAX_LOCAL_CLIENTS = 1_000;

type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type IngestAdmission =
  | { ok: true }
  | { ok: false; status: 429; retryAfterMs: number }
  | { ok: false; status: 503; retryAfterMs: null };

const LIMITED: IngestAdmission = { ok: false, status: 429, retryAfterMs: WINDOW_MS };
const UNAVAILABLE: IngestAdmission = { ok: false, status: 503, retryAfterMs: null };

type Window = { startedAt: number; count: number };
const clients = new Map<string, Window>();
let site: Window = { startedAt: 0, count: 0 };

const current = (window: Window | undefined, now: number): Window =>
  window && now - window.startedAt < WINDOW_MS ? window : { startedAt: now, count: 0 };

const takeLocal = (key: string): IngestAdmission => {
  const now = Date.now();
  const client = current(clients.get(key), now);
  if (client.count >= INGEST_RATE_LIMITS.perClient) return LIMITED;
  site = current(site, now);
  if (site.count >= INGEST_RATE_LIMITS.total) return LIMITED;
  client.count += 1;
  site.count += 1;
  clients.delete(key);
  clients.set(key, client);
  while (clients.size > MAX_LOCAL_CLIENTS) clients.delete(clients.keys().next().value as string);
  return { ok: true };
};

const bindingsOf = (env: Record<string, unknown>): { perClient: RateLimitBinding; total: RateLimitBinding } | null => {
  const perClient = env.INGEST_RATE_LIMITER as RateLimitBinding | undefined;
  const total = env.INGEST_GLOBAL_RATE_LIMITER as RateLimitBinding | undefined;
  return typeof perClient?.limit === "function" && typeof total?.limit === "function" ? { perClient, total } : null;
};

export async function takeIngestRateLimit(request: Request): Promise<IngestAdmission> {
  const key = `ingest:${rateLimitClientKey(request)}`;
  let env: Record<string, unknown>;
  try {
    env = (await getCloudflareContext({ async: true })).env as Record<string, unknown>;
  } catch {
    return takeLocal(key);
  }
  const limiters = bindingsOf(env);
  if (!limiters) return UNAVAILABLE;
  try {
    if (!(await limiters.perClient.limit({ key })).success) return LIMITED;
    return (await limiters.total.limit({ key: "ingest:all" })).success ? { ok: true } : LIMITED;
  } catch {
    return UNAVAILABLE;
  }
}

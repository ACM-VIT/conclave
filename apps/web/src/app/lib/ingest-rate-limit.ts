import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createFixedWindow, type FixedWindow, INGEST_QUOTA_URL, INGEST_RATE_LIMITS, INGEST_WINDOW_MS } from "./ingest-quota";
import { rateLimitClientKey } from "./unfurl-rate-limit";

const MAX_LOCAL_CLIENTS = 1_000;
const SITE_QUOTA_DEADLINE_MS = 2_000;

type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };
type QuotaStub = { fetch(url: string, init: RequestInit): Promise<Response> };
type QuotaNamespace = { idFromName(name: string): unknown; get(id: unknown): QuotaStub };

export type IngestAdmission =
  | { ok: true }
  | { ok: false; status: 429; retryAfterMs: number }
  | { ok: false; status: 503; retryAfterMs: null };

const ADMITTED: IngestAdmission = { ok: true };
const LIMITED: IngestAdmission = { ok: false, status: 429, retryAfterMs: INGEST_WINDOW_MS };
const UNAVAILABLE: IngestAdmission = { ok: false, status: 503, retryAfterMs: null };

const clients = new Map<string, FixedWindow>();
const site = createFixedWindow(INGEST_RATE_LIMITS.total);

const takeLocal = (key: string): IngestAdmission => {
  const now = Date.now();
  const client = clients.get(key) ?? createFixedWindow(INGEST_RATE_LIMITS.perClient);
  clients.delete(key);
  clients.set(key, client);
  while (clients.size > MAX_LOCAL_CLIENTS) clients.delete(clients.keys().next().value as string);
  if (!client.take(now)) return LIMITED;
  return site.take(now) ? ADMITTED : LIMITED;
};

const bindingsOf = (env: Record<string, unknown>): { perClient: RateLimitBinding; site: QuotaNamespace } | null => {
  const perClient = env.INGEST_RATE_LIMITER as RateLimitBinding | undefined;
  const quota = env.INGEST_QUOTA as QuotaNamespace | undefined;
  return typeof perClient?.limit === "function" && typeof quota?.get === "function" && typeof quota.idFromName === "function"
    ? { perClient, site: quota }
    : null;
};

const takeSiteQuota = async (quota: QuotaNamespace): Promise<IngestAdmission> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<IngestAdmission>((resolve) => {
    timer = setTimeout(() => resolve(UNAVAILABLE), SITE_QUOTA_DEADLINE_MS);
  });
  const answered = quota
    .get(quota.idFromName("site"))
    .fetch(INGEST_QUOTA_URL, { method: "POST" })
    .then((response) => (response.status === 204 ? ADMITTED : response.status === 429 ? LIMITED : UNAVAILABLE));
  try {
    return await Promise.race([answered, stalled]);
  } finally {
    clearTimeout(timer);
  }
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
    return await takeSiteQuota(limiters.site);
  } catch {
    return UNAVAILABLE;
  }
}

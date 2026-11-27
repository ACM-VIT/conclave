import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createFixedWindow, INGEST_QUOTA_URL, INGEST_RATE_LIMITS, INGEST_WINDOW_MS } from "./ingest-quota";

const ADMISSION_DEADLINE_MS = 2_000;

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

const processQuota = createFixedWindow(INGEST_RATE_LIMITS.perClient);

const bindingsOf = (env: Record<string, unknown>): { perClient: RateLimitBinding; site: QuotaNamespace } | null => {
  const perClient = env.INGEST_RATE_LIMITER as RateLimitBinding | undefined;
  const quota = env.INGEST_QUOTA as QuotaNamespace | undefined;
  return typeof perClient?.limit === "function" && typeof quota?.get === "function" && typeof quota.idFromName === "function"
    ? { perClient, site: quota }
    : null;
};

const takeSiteQuota = async (quota: QuotaNamespace): Promise<IngestAdmission> => {
  const response = await quota.get(quota.idFromName("site")).fetch(INGEST_QUOTA_URL, { method: "POST" });
  return response.status === 204 ? ADMITTED : response.status === 429 ? LIMITED : UNAVAILABLE;
};

const takeBoth = async (limiters: { perClient: RateLimitBinding; site: QuotaNamespace }, key: string): Promise<IngestAdmission> => {
  if (!(await limiters.perClient.limit({ key })).success) return LIMITED;
  return takeSiteQuota(limiters.site);
};

const withinAdmissionDeadline = async (admission: Promise<IngestAdmission>): Promise<IngestAdmission> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<IngestAdmission>((resolve) => {
    timer = setTimeout(() => resolve(UNAVAILABLE), ADMISSION_DEADLINE_MS);
  });
  try {
    return await Promise.race([admission.catch(() => UNAVAILABLE), stalled]);
  } finally {
    clearTimeout(timer);
  }
};

const inWorkers = (): boolean => typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

export async function takeIngestRateLimit(request: Request): Promise<IngestAdmission> {
  if (!inWorkers()) return processQuota.take(Date.now()) ? ADMITTED : LIMITED;
  const edgeIp = request.headers.get("cf-connecting-ip")?.trim().slice(0, 128) || "anonymous";
  let env: Record<string, unknown>;
  try {
    env = (await getCloudflareContext({ async: true })).env as Record<string, unknown>;
  } catch {
    return UNAVAILABLE;
  }
  const limiters = bindingsOf(env);
  if (!limiters) return UNAVAILABLE;
  return withinAdmissionDeadline(takeBoth(limiters, `ingest:${edgeIp}`));
}

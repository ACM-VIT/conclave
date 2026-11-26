import { getCloudflareContext } from "@opennextjs/cloudflare";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_LOCAL_BUCKETS = 1_000;

type CloudflareRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type LocalRateLimitBucket = { windowStartedAt: number; count: number };
const localBuckets = new Map<string, LocalRateLimitBucket>();

// Only Cloudflare's edge sets cf-connecting-ip. Under next start or next dev a
// caller can send any value (and OpenNext still hands over a simulated limiter),
// so off Workers every caller shares one bucket.
const runsOnCloudflareWorkers = (): boolean =>
  globalThis.navigator?.userAgent === "Cloudflare-Workers";

const clientKey = (request: Request): string =>
  runsOnCloudflareWorkers()
    ? (request.headers.get("cf-connecting-ip")?.trim() || "anonymous").slice(0, 128)
    : "shared";

const takeLocalRateLimit = (key: string): boolean => {
  const now = Date.now();
  const bucket = localBuckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= RATE_WINDOW_MS) {
    localBuckets.set(key, { windowStartedAt: now, count: 1 });
    while (localBuckets.size > MAX_LOCAL_BUCKETS) {
      const oldest = localBuckets.keys().next().value;
      if (oldest === undefined) break;
      localBuckets.delete(oldest);
    }
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
};

const readCloudflareRateLimiter = async (): Promise<CloudflareRateLimitBinding | null> => {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = (env as { CSP_REPORT_RATE_LIMITER?: CloudflareRateLimitBinding })
      .CSP_REPORT_RATE_LIMITER;
    return binding && typeof binding.limit === "function" ? binding : null;
  } catch {
    return null;
  }
};

export type CspReportRateLimitOutcome = "allowed" | "limited" | "unavailable";

export async function takeCspReportRateLimit(
  request: Request,
): Promise<CspReportRateLimitOutcome> {
  const key = `csp-report:${clientKey(request)}`;
  const limiter = await readCloudflareRateLimiter();
  if (limiter) {
    try {
      const { success } = await limiter.limit({ key });
      return success ? "allowed" : "limited";
    } catch {
      return "unavailable";
    }
  }
  if (process.env.NODE_ENV === "production") return "unavailable";
  return takeLocalRateLimit(key) ? "allowed" : "limited";
}

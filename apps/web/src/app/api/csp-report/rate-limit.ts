import { getCloudflareContext } from "@opennextjs/cloudflare";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_LOCAL_BUCKETS = 1_000;

type CloudflareRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type LocalRateLimitBucket = { windowStartedAt: number; count: number };
const localBuckets = new Map<string, LocalRateLimitBucket>();

// Cloudflare sets cf-connecting-ip on every request it forwards. Other client
// IP headers are whatever the caller sent, so they never pick the bucket.
const clientKey = (request: Request): string =>
  (request.headers.get("cf-connecting-ip")?.trim() || "anonymous").slice(0, 128);

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
  // Off Cloudflare the server cannot tell clients apart, so production refuses
  // reports rather than letting each request claim a fresh bucket.
  if (process.env.NODE_ENV === "production") return "unavailable";
  return takeLocalRateLimit(key) ? "allowed" : "limited";
}

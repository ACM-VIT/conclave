import { getCloudflareContext } from "@opennextjs/cloudflare";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const MAX_LOCAL_BUCKETS = 1_000;

type CloudflareRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type LocalRateLimitBucket = { windowStartedAt: number; count: number };
const localBuckets = new Map<string, LocalRateLimitBucket>();

const clientKey = (request: Request): string => {
  const forwardedFor = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .at(0)
    ?.trim();
  const candidate =
    [
      request.headers.get("cf-connecting-ip")?.trim(),
      request.headers.get("x-real-ip")?.trim(),
      forwardedFor,
      request.headers.get("user-agent")?.trim(),
    ].find((value): value is string => Boolean(value)) ?? "anonymous";
  return candidate.slice(0, 128);
};

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

export type UnfurlRateLimitOutcome =
  | { ok: true }
  | { ok: false; status: 429 | 503 };

export async function takeUnfurlRateLimit(
  request: Request,
): Promise<UnfurlRateLimitOutcome> {
  const key = `unfurl:${clientKey(request)}`;

  let limiter: CloudflareRateLimitBinding | null = null;
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = (env as { UNFURL_RATE_LIMITER?: CloudflareRateLimitBinding })
      .UNFURL_RATE_LIMITER;
    limiter = binding && typeof binding.limit === "function" ? binding : null;
  } catch {
    limiter = null;
  }

  if (limiter) {
    try {
      const { success } = await limiter.limit({ key });
      return success ? { ok: true } : { ok: false, status: 429 };
    } catch {
      // Fall through to the fail-closed production branch below.
    }
  }

  if (process.env.NODE_ENV === "production") {
    // An unfurler is an outbound-fetch proxy; never run it unmetered.
    return { ok: false, status: 503 };
  }

  return takeLocalRateLimit(key) ? { ok: true } : { ok: false, status: 429 };
}

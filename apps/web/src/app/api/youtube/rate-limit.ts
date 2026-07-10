import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

type RateLimitBucket = {
  windowStartedAt: number;
  count: number;
};

type RateLimitOptions = {
  scope: string;
  binding:
    | "YOUTUBE_SEARCH_RATE_LIMITER"
    | "YOUTUBE_TRENDING_RATE_LIMITER"
    | "YOUTUBE_METADATA_RATE_LIMITER";
  limit: number;
  windowMs: number;
};

type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; status: 429 | 503; error: string };

type CloudflareRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type YouTubeCloudflareEnv = Partial<
  Record<RateLimitOptions["binding"], CloudflareRateLimitBinding>
>;

const MAX_BUCKETS = 1_000;
const buckets = new Map<string, RateLimitBucket>();

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

const trimBuckets = (): void => {
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) return;
    buckets.delete(oldest);
  }
};

const readCloudflareRateLimitBinding = async (
  binding: RateLimitOptions["binding"],
): Promise<CloudflareRateLimitBinding | null> => {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const limiter = (env as YouTubeCloudflareEnv)[binding];
    return limiter && typeof limiter.limit === "function" ? limiter : null;
  } catch {
    return null;
  }
};

const takeLocalRateLimit = (
  key: string,
  options: RateLimitOptions,
): RateLimitResult => {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || now - current.windowStartedAt >= options.windowMs) {
    buckets.set(key, { windowStartedAt: now, count: 1 });
    trimBuckets();
    return { ok: true };
  }

  if (current.count >= options.limit) {
    return {
      ok: false,
      status: 429,
      error: "Too many YouTube requests",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((options.windowMs - (now - current.windowStartedAt)) / 1_000),
      ),
    };
  }

  current.count += 1;
  return { ok: true };
};

export const takeYouTubeRateLimit = async (
  request: Request,
  options: RateLimitOptions,
): Promise<RateLimitResult> => {
  const key = `${options.scope}:${clientKey(request)}`;
  const limiter = await readCloudflareRateLimitBinding(options.binding);

  if (limiter) {
    try {
      const { success } = await limiter.limit({ key });
      return success
        ? { ok: true }
        : {
            ok: false,
            status: 429,
            error: "Too many YouTube requests",
            retryAfterSeconds: Math.max(1, Math.ceil(options.windowMs / 1_000)),
          };
    } catch {
      // Fall through to the production fail-closed branch below.
    }
  }

  if (process.env.NODE_ENV === "production") {
    return {
      ok: false,
      status: 503,
      error: "YouTube rate limiter is not configured",
      retryAfterSeconds: Math.max(1, Math.ceil(options.windowMs / 1_000)),
    };
  }

  return takeLocalRateLimit(key, options);
};

// Typed as plain Response: @opennextjs/cloudflare pulls its own copy of the
// next types, and annotating the richer NextResponse here trips a structural
// mismatch between the two copies. Route handlers accept Response fine.
export const youtubeRateLimitResponse = (
  result: Extract<RateLimitResult, { ok: false }>,
): Response =>
  NextResponse.json(
    { error: result.error },
    {
      status: result.status,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
      },
    },
  );

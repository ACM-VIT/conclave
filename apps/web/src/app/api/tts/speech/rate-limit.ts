import { getCloudflareContext } from "@opennextjs/cloudflare";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const MAX_LOCAL_BUCKETS = 1_000;

type CloudflareRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type LocalRateLimitBucket = { windowStartedAt: number; count: number };
const localBuckets = new Map<string, LocalRateLimitBucket>();

const clientKey = (request: Request): string => {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",").at(0)?.trim();
  const candidate =
    [
      request.headers.get("cf-connecting-ip")?.trim(),
      request.headers.get("x-real-ip")?.trim(),
      forwardedFor,
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

export type SpeechRateLimitOutcome = "allowed" | "limited" | "unavailable";

export async function takeSpeechRateLimit(
  request: Request,
): Promise<SpeechRateLimitOutcome> {
  const key = `tts-speech:${clientKey(request)}`;
  let env: unknown;
  try {
    ({ env } = await getCloudflareContext({ async: true }));
  } catch {
    return takeLocalRateLimit(key) ? "allowed" : "limited";
  }
  const binding = (env as { TTS_SPEECH_RATE_LIMITER?: CloudflareRateLimitBinding })
    .TTS_SPEECH_RATE_LIMITER;
  if (!binding || typeof binding.limit !== "function") {
    console.error("[TTS] TTS_SPEECH_RATE_LIMITER binding is missing; refusing speech requests.");
    return "unavailable";
  }
  try {
    const { success } = await binding.limit({ key });
    return success ? "allowed" : "limited";
  } catch (error) {
    console.error("[TTS] Speech rate limiter failed; refusing speech requests.", error);
    return "unavailable";
  }
}

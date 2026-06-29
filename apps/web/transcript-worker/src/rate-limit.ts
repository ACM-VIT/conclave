export type TranscriptRateBucketName =
  | "audio"
  | "export"
  | "minutes"
  | "qa"
  | "session";

export type TranscriptRateLimitState = Partial<
  Record<
    TranscriptRateBucketName,
    {
      count: number;
      resetAt: number;
    }
  >
>;

const limits: Record<
  TranscriptRateBucketName,
  { max: number; windowMs: number }
> = {
  audio: { max: 160, windowMs: 10_000 },
  export: { max: 20, windowMs: 60_000 },
  minutes: { max: 12, windowMs: 60_000 },
  qa: { max: 10, windowMs: 60_000 },
  session: { max: 8, windowMs: 60_000 },
};

export const takeTranscriptRateLimit = (
  state: TranscriptRateLimitState,
  bucket: TranscriptRateBucketName,
  now = Date.now(),
): boolean => {
  const limit = limits[bucket];
  const current = state[bucket];
  if (!current || current.resetAt <= now) {
    state[bucket] = {
      count: 1,
      resetAt: now + limit.windowMs,
    };
    return true;
  }

  if (current.count >= limit.max) return false;
  current.count += 1;
  return true;
};

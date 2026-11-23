import { z } from "zod";

/**
 * What an HTTP answer means for the telemetry batch it answered, in one table
 * for the browser's outbox (answers from /ingest) and for /ingest (answers
 * from PostHog): delivered; to send again, no sooner than the Retry-After the
 * answer asked for, held to MAX_RETRY_AFTER_MS; or refused for good, which
 * sending the same batch again would not change.
 */
export type Answer =
  | { outcome: "delivered" }
  | { outcome: "retry"; afterMs: number | null }
  | { outcome: "refused" };

export const MAX_RETRY_AFTER_MS = 60_000;

// Timed out, too early, rate limited, or failing for now (any 5xx): the same
// batch may pass later.
const RETRYABLE = new Set([408, 425, 429]);

// A number of seconds, or an HTTP date.
const RetryAfter = z.union([
  z
    .string()
    .trim()
    .regex(/^\d{1,9}$/)
    .transform((seconds) => ({ seconds: Number(seconds) })),
  z
    .string()
    .trim()
    .pipe(z.coerce.date())
    .transform((date) => ({ at: date.getTime() })),
]);

const waitOf = (retryAfter: string | null, now: number): number | null => {
  const parsed = RetryAfter.safeParse(retryAfter);
  if (!parsed.success) return null;
  const ms = "seconds" in parsed.data ? parsed.data.seconds * 1000 : parsed.data.at - now;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
};

export function answerOf(status: number, retryAfter: string | null, now: number): Answer {
  if (status >= 200 && status < 300) return { outcome: "delivered" };
  if (RETRYABLE.has(status) || status >= 500) return { outcome: "retry", afterMs: waitOf(retryAfter, now) };
  return { outcome: "refused" };
}

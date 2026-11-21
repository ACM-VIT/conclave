import type { TelemetryProps } from "./telemetry";

const CALL_LOG_PREFIX = "[Meets]";
const MAX_DETAIL_LENGTH = 200;
const RATE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_LABEL = 3;
const MAX_REPORTS_PER_WINDOW = 30;

export type CallErrorReport = (error: unknown, props: TelemetryProps) => void;

type ConsoleLike = { error: (...args: unknown[]) => void };

const detailText = (value: unknown): string | null => {
  if (typeof value === "string") return value.slice(0, MAX_DETAIL_LENGTH);
  if (value && typeof value === "object") {
    const record = value as { error?: unknown; message?: unknown };
    const text =
      typeof record.error === "string"
        ? record.error
        : typeof record.message === "string"
          ? record.message
          : null;
    return text ? text.slice(0, MAX_DETAIL_LENGTH) : null;
  }
  return null;
};

/**
 * Turns a `console.error("[Meets] ...", ...)` call into an exception. Only the
 * developer-written label, Error objects and short server error strings are
 * kept; any other logged object is dropped.
 */
export function describeCallError(
  args: unknown[],
): { label: string; error: Error } | null {
  const [first, ...rest] = args;
  if (typeof first !== "string" || !first.startsWith(CALL_LOG_PREFIX)) {
    return null;
  }
  const label = first.trim().replace(/:$/, "");
  const thrown = rest.find((value): value is Error => value instanceof Error);
  if (thrown) return { label, error: thrown };

  const details = rest
    .map(detailText)
    .filter((text): text is string => Boolean(text));
  const error = new Error([label, ...details].join(" "));
  error.name = "CallError";
  return { label, error };
}

const createLimiter = (now: () => number) => {
  let windowStart = now();
  let total = 0;
  const perLabel = new Map<string, number>();
  return (label: string): boolean => {
    if (now() - windowStart >= RATE_WINDOW_MS) {
      windowStart = now();
      total = 0;
      perLabel.clear();
    }
    const used = perLabel.get(label) ?? 0;
    if (used >= MAX_REPORTS_PER_LABEL || total >= MAX_REPORTS_PER_WINDOW) {
      return false;
    }
    perLabel.set(label, used + 1);
    total += 1;
    return true;
  };
};

/**
 * Reports the call code's own `[Meets]` error logs (consume, produce, socket
 * and transport failures) without touching each call site. Returns the
 * function that restores the original `console.error`.
 */
export function installCallErrorCapture(
  report: CallErrorReport,
  { target = console as ConsoleLike, now = Date.now } = {},
): () => void {
  const original = target.error;
  const allow = createLimiter(now);
  let reporting = false;

  const patched = (...args: unknown[]) => {
    original.apply(target, args);
    if (reporting) return;
    reporting = true;
    try {
      const described = describeCallError(args);
      if (described && allow(described.label)) {
        report(described.error, {
          source: "call_log",
          call_log: described.label,
        });
      }
    } catch {
    } finally {
      reporting = false;
    }
  };

  target.error = patched;
  return () => {
    if (target.error === patched) target.error = original;
  };
}

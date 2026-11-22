import { isCallLogLabel } from "./call-log-labels";
import type { TelemetryProps } from "./telemetry";

const RATE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_LABEL = 3;
const MAX_REPORTS_PER_WINDOW = 30;

export type CallErrorReport = (error: unknown, props: TelemetryProps) => void;

type ConsoleLike = { error: (...args: unknown[]) => void };

// V8 writes "Name: message" above the frames; Firefox and Safari write frames only.
const framesOf = (stack: string): string => {
  const firstFrame = stack.indexOf("\n    at ");
  return firstFrame >= 0 ? stack.slice(firstFrame + 1) : stack;
};

/**
 * Turns a `console.error("[Meets] ...", ...)` call into an exception named by
 * its label, when that label is registered in call-log-labels exactly. A
 * logged Error keeps its type and stack frames but never its message, which
 * can carry server text such as a host's end-room note. Every other logged
 * value is dropped.
 */
export function describeCallError(
  args: unknown[],
): { label: string; error: Error } | null {
  const [first, ...rest] = args;
  if (typeof first !== "string") return null;
  const label = first.trim().replace(/:$/, "");
  if (!isCallLogLabel(label)) return null;
  const thrown = rest.find((value): value is Error => value instanceof Error);
  const error = new Error(label);
  error.name = thrown?.name ?? "CallError";
  if (thrown?.stack) {
    error.stack = `${error.name}: ${label}\n${framesOf(thrown.stack)}`;
  }
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
  {
    target = console,
    now = Date.now,
  }: { target?: ConsoleLike; now?: () => number } = {},
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

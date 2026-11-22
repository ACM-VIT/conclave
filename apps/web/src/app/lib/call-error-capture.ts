import type { CallLogLabel } from "./call-log-labels";
import type { TelemetryProps } from "./telemetry";

const RATE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_LABEL = 3;
const MAX_REPORTS_PER_WINDOW = 30;

export type CallErrorReport = (error: Error, props: TelemetryProps) => void;

// V8 writes "Name: message" above the frames; Firefox and Safari write frames only.
const framesOf = (stack: string): string => {
  const firstFrame = stack.indexOf("\n    at ");
  return firstFrame >= 0 ? stack.slice(firstFrame + 1) : stack;
};

/**
 * The exception a call log becomes: named by its label, with the type and
 * stack frames of the first logged Error but never its message, which can
 * carry server text such as a host's end-room note. Every other logged value
 * is dropped.
 */
export function describeCallError(label: CallLogLabel, details: unknown[]): Error {
  const thrown = details.find((value): value is Error => value instanceof Error);
  const error = new Error(label);
  error.name = thrown?.name ?? "CallError";
  if (thrown?.stack) {
    error.stack = `${error.name}: ${label}\n${framesOf(thrown.stack)}`;
  }
  return error;
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

let capture: { report: CallErrorReport; allow: (label: string) => boolean } | null = null;

/**
 * Logs a call failure (consume, produce, socket, transport, playback) to the
 * console under a registered label, and reports it to telemetry once capture
 * is installed: at most 3 reports per label and 30 in total per minute.
 */
export function logCallError(label: CallLogLabel, ...details: unknown[]): void {
  console.error(details.length > 0 ? `${label}:` : label, ...details);
  const active = capture;
  if (!active || !active.allow(label)) return;
  try {
    active.report(describeCallError(label, details), { source: "call_log", call_log: label });
  } catch {
  }
}

/**
 * Sends every logCallError to `report` from now on. Returns the function that
 * stops it.
 */
export function installCallErrorCapture(
  report: CallErrorReport,
  { now = Date.now }: { now?: () => number } = {},
): () => void {
  const installed = { report, allow: createLimiter(now) };
  capture = installed;
  return () => {
    if (capture === installed) capture = null;
  };
}

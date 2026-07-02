"use client";

import { color } from "@conclave/ui-tokens";

/** Top-right feedback stack: sticky errors, self-dismissing successes, and a
 * busy note that only appears for genuinely slow commands. */
export function Toasts({
  errorMessage,
  statusMessage,
  busyToast,
  onDismissError,
}: {
  errorMessage: string | null;
  statusMessage: string | null;
  busyToast: string | null;
  onDismissError: () => void;
}) {
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-40 flex w-[min(340px,90vw)] flex-col gap-2">
      {errorMessage ? (
        <div
          className="pointer-events-auto flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-[12.5px]"
          style={{
            borderColor: "rgba(234,67,53,0.4)",
            backgroundColor: color.bgAlt,
            color: "#f4b8b2",
          }}
        >
          <span className="min-w-0 break-words">{errorMessage}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      ) : null}
      {statusMessage ? (
        <div
          className="pointer-events-auto rounded-xl border px-3 py-2.5 text-[12.5px]"
          style={{
            borderColor: "rgba(34,197,94,0.35)",
            backgroundColor: color.bgAlt,
            color: "#b5e8c5",
          }}
        >
          {statusMessage}
        </div>
      ) : null}
      {busyToast ? (
        <div
          className="pointer-events-auto rounded-xl border px-3 py-2.5 text-[12px]"
          style={{
            borderColor: color.border,
            backgroundColor: color.bgAlt,
            color: color.textMuted,
          }}
        >
          {busyToast}...
        </div>
      ) : null}
    </div>
  );
}

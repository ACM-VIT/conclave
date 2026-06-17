"use client";

import { X } from "lucide-react";
import { color } from "@conclave/ui-tokens";

export interface ToastItem {
  id: string;
  label: string;
  message: string;
  /** "danger" reads as an error: danger label + a slightly lighter surface. */
  tone?: "accent" | "danger";
  onDismiss?: () => void;
}

export default function ToastQueue({ toasts }: { toasts: (ToastItem | null | undefined)[] }) {
  const active = toasts.filter(Boolean) as ToastItem[];
  if (active.length === 0) return null;
  const toast = active[0];
  const queuedCount = active.length - 1;
  const isDanger = toast.tone === "danger";
  const stripeColor = isDanger ? color.danger : color.accent;
  const labelColor = isDanger ? color.danger : color.accent;
  // Errors get a slightly lighter surface so they stand apart from the stage.
  const surfaceColor = isDanger ? color.surfaceRaised : color.surface;
  return (
    <div
      className="pointer-events-none absolute bottom-28 left-1/2 z-50 -translate-x-1/2 px-4"
      role="status"
      aria-live={isDanger ? "assertive" : "polite"}
    >
      <div
        className="pointer-events-auto flex max-w-[360px] items-start gap-3 overflow-hidden rounded-xl border py-3 pr-4"
        style={{
          backgroundColor: surfaceColor,
          borderColor: color.border,
          borderLeft: `4px solid ${stripeColor}`,
          paddingLeft: "calc(1rem - 3px)",
        }}
      >
        <div className="min-w-0">
          <p className="text-[13px] font-medium" style={{ color: labelColor }}>
            {toast.label}
          </p>
          <p className="mt-1 text-[12px] leading-snug" style={{ color: color.textMuted }}>
            {toast.message}
          </p>
          {queuedCount > 0 && (
            <p className="mt-1.5 text-[11px]" style={{ color: color.textFaint }}>
              +{queuedCount} more
            </p>
          )}
        </div>
        {toast.onDismiss && (
          <button
            type="button"
            onClick={toast.onDismiss}
            aria-label="Dismiss"
            className="ml-auto transition-[color] duration-[120ms]"
            style={{ color: color.textMuted }}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

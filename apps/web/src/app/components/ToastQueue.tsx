"use client";

import { X } from "lucide-react";
import { color } from "@conclave/ui-tokens";

export interface ToastItem {
  id: string;
  label: string;
  message: string;
  onDismiss?: () => void;
}

/**
 * Single bottom-center transient toast region (one at a time). Replaces the two
 * fixed corner error boxes. Flat solid surface, no gradient/glow, manual close.
 */
export default function ToastQueue({ toasts }: { toasts: (ToastItem | null | undefined)[] }) {
  const active = toasts.filter(Boolean) as ToastItem[];
  if (active.length === 0) return null;
  const toast = active[0];
  return (
    <div className="pointer-events-none absolute bottom-28 left-1/2 z-50 -translate-x-1/2 px-4">
      <div
        className="pointer-events-auto flex max-w-[360px] items-start gap-3 rounded-xl border px-4 py-3"
        style={{ backgroundColor: color.surface, borderColor: color.border }}
      >
        <div className="min-w-0">
          <p className="text-xs font-medium" style={{ color: color.accent }}>
            {toast.label}
          </p>
          <p className="mt-1 text-[11px]" style={{ color: color.textMuted }}>
            {toast.message}
          </p>
        </div>
        {toast.onDismiss && (
          <button
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

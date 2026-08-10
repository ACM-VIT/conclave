"use client";

import { AlertTriangle, Info, X } from "lucide-react";
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
  const accentColor = isDanger ? color.danger : color.accent;
  const Icon = isDanger ? AlertTriangle : Info;
  return (
    <div
      className="pointer-events-none absolute bottom-24 left-1/2 z-50 w-full max-w-[340px] -translate-x-1/2 px-3"
      role={isDanger ? "alert" : "status"}
      aria-live={isDanger ? "assertive" : "polite"}
    >
      <div
        className="pointer-events-auto flex items-center gap-2.5 rounded-xl border p-2.5 shadow-[0_12px_36px_rgba(0,0,0,0.34)] backdrop-blur-xl"
        style={{
          backgroundColor: color.surfaceRaised,
          borderColor: color.border,
        }}
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accentColor}18`, color: accentColor }}
          aria-hidden="true"
        >
          <Icon size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="text-[9.5px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: accentColor }}
          >
            {toast.label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-[1.35]" style={{ color: color.textMuted }}>
            {toast.message}
          </p>
          {queuedCount > 0 && (
            <p className="mt-1 text-[10px]" style={{ color: color.textFaint }}>
              +{queuedCount} more
            </p>
          )}
        </div>
        {toast.onDismiss && (
          <button
            type="button"
            onClick={toast.onDismiss}
            aria-label="Dismiss"
            className="ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-[background-color,color] duration-[120ms] hover:bg-white/[0.06]"
            style={{ color: color.textMuted }}
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}

"use client";

import { Sparkles, X, type LucideIcon } from "lucide-react";
import { color } from "@conclave/ui-tokens";

interface CoachmarkProps {
  title: string;
  description?: string;
  onDismiss: () => void;
  arrowLeft?: string;
  className?: string;
}

export default function Coachmark({
  title,
  description,
  onDismiss,
  arrowLeft = "50%",
  className = "",
}: CoachmarkProps) {
  return (
    <div
      role="status"
      className={
        "absolute bottom-full left-1/2 z-50 mb-3 w-[15rem] -translate-x-1/2 " +
        "origin-bottom animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)] " +
        className
      }
    >
      <div
        className="flex items-start gap-2.5 rounded-2xl border p-3 pr-2.5"
        style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
      >
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[13.5px] font-medium leading-snug" style={{ color: color.text }}>
            {title}
          </p>
          {description ? (
            <p className="mt-0.5 text-[12px] leading-snug" style={{ color: color.textMuted }}>
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss tip"
          className="shrink-0 rounded-md p-1 transition-[background-color,color] duration-[120ms] hover:bg-white/[0.08]"
          style={{ color: color.textFaint }}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div
        className="absolute top-full h-[7px] w-[14px] -translate-x-1/2 overflow-hidden"
        style={{ left: arrowLeft }}
        aria-hidden
      >
        <div
          className="absolute left-1/2 top-0 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r"
          style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
        />
      </div>
    </div>
  );
}

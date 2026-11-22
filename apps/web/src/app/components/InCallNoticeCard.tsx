"use client";

import { X, type LucideIcon } from "lucide-react";

interface InCallNoticeCardProps {
  tone?: "error" | "neutral";
  icon: LucideIcon;
  spinIcon?: boolean;
  title: string;
  detail?: string | null;
  actionLabel?: string;
  onAction?: () => void;
  actionOnCardClick?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export default function InCallNoticeCard({
  tone = "neutral",
  icon: Icon,
  spinIcon = false,
  title,
  detail,
  actionLabel,
  onAction,
  actionOnCardClick = false,
  onDismiss,
  dismissLabel = "Dismiss",
}: InCallNoticeCardProps) {
  const isError = tone === "error";
  const cardAction = actionOnCardClick ? onAction : undefined;
  return (
    <div className="w-full min-w-0 rounded-xl bg-[#18181b] shadow-[0_12px_32px_rgba(0,0,0,0.35)]">
      <div
        role={isError ? "alert" : "status"}
        aria-live={isError ? undefined : "polite"}
        onClick={cardAction}
        className={`flex min-w-0 items-center gap-3 rounded-xl border px-3.5 py-2.5 ${
          isError
            ? "border-[#F95F4A]/25 bg-[#F95F4A]/[0.07]"
            : "border-[#fafafa]/10"
        } ${cardAction ? "cursor-pointer" : ""}`}
      >
        <Icon
          aria-hidden
          strokeWidth={2}
          className={`h-4 w-4 shrink-0 ${
            isError ? "text-[#F95F4A]" : "text-[#fafafa]/60"
          } ${spinIcon ? "motion-safe:animate-spin" : ""}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words text-[13.5px] font-medium leading-5 text-[#fafafa]">
            {title}
          </span>
          {detail ? (
            <span className="break-words text-[12px] leading-4 text-[#fafafa]/55">
              {detail}
            </span>
          ) : null}
        </div>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAction();
            }}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              isError
                ? "bg-[#F95F4A]/15 text-[#F95F4A] hover:bg-[#F95F4A]/25"
                : "bg-[#fafafa]/[0.08] text-[#fafafa] hover:bg-[#fafafa]/[0.14]"
            }`}
          >
            {actionLabel}
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
            className="-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#fafafa]/40 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]/80"
            aria-label={dismissLabel}
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

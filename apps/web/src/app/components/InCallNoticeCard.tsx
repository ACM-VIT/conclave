"use client";

import { useEffect } from "react";
import { X, type LucideIcon } from "lucide-react";
import { useInCallNoticeLane } from "../lib/in-call-notice-lane";

type NoticeTone = "error" | "warning" | "neutral";

interface InCallNoticeCardProps {
  tone?: NoticeTone;
  icon: LucideIcon;
  spinIcon?: boolean;
  title: string;
  detail?: string | null;
  actionLabel?: string;
  onAction?: () => void;
  actionOnCardClick?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
  compact?: boolean;
}

const ICON_TONE: Record<NoticeTone, string> = {
  error: "text-[#F95F4A]",
  warning: "text-[#fafafa]",
  neutral: "text-[#fafafa]/55",
};

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
  compact: compactProp = false,
}: InCallNoticeCardProps) {
  const lane = useInCallNoticeLane();
  const announce = lane?.announce;
  const isError = tone === "error";
  const compact = compactProp || Boolean(lane?.compact);
  const showDetail = Boolean(detail) && !compact && (isError || lane?.expanded || !lane);
  const content = detail ? `${title}. ${detail}` : title;
  const cardAction = actionOnCardClick ? onAction : undefined;
  const action = actionLabel && onAction ? actionLabel : null;

  useEffect(() => announce?.(content, tone !== "neutral"), [announce, content, tone]);

  return (
    <div
      className={`h-full w-full min-w-0 border border-[#fafafa]/10 bg-[#232327] transition-opacity duration-100 [opacity:var(--notice-opacity,1)] rounded-2xl`}
    >
      <div
        data-in-call-notice
        data-notice-content={`${content}|${action ?? ""}|${onDismiss ? "dismiss" : ""}`}
        data-tone={tone}
        role={announce ? undefined : isError ? "alert" : "status"}
        aria-live={announce || isError ? undefined : "polite"}
        onClick={cardAction}
        className={`flex min-w-0 items-center gap-3 pl-4 pr-3 ${compact ? "h-[42px]" : "py-3"} ${cardAction ? "cursor-pointer" : ""}`}
      >
        <span
          aria-hidden
          className={`grid h-[18px] w-[18px] shrink-0 place-items-center ${
            showDetail ? "mt-px self-start" : "self-center"
          }`}
        >
          <Icon
            size={18}
            strokeWidth={1.75}
            className={`${ICON_TONE[tone]} ${spinIcon ? "motion-safe:animate-spin" : ""}`}
          />
        </span>
        <div className={`flex min-w-0 flex-1 flex-col justify-center ${compact ? "" : "min-h-7"}`}>
          <span
            className={`text-[13.5px] font-medium leading-5 text-[#fafafa] ${compact ? "truncate" : "line-clamp-2"}`}
            title={title}
          >
            {title}
          </span>
          {showDetail ? (
            <span className="mt-0.5 text-[12px] leading-4 text-[#fafafa]/55">{detail}</span>
          ) : null}
        </div>
        {action ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAction?.();
            }}
            className={`shrink-0 self-center px-2.5 py-1 text-[12.5px] font-medium transition-colors duration-100 rounded-lg ${
              isError
                ? "text-[#F95F4A] hover:bg-[#F95F4A]/10"
                : "text-[#fafafa]/80 hover:bg-[#fafafa]/[0.06] hover:text-[#fafafa]"
            }`}
          >
            {action}
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center self-center text-[#fafafa]/40 transition-colors duration-100 hover:bg-[#fafafa]/[0.06] hover:text-[#fafafa]/80 rounded-lg`}
            aria-label={dismissLabel}
            title="Dismiss"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

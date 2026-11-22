"use client";

import { Loader2, type LucideIcon } from "lucide-react";

interface StageNoticeProps {
  title: string;
  detail?: string;
  icon?: LucideIcon;
  busy?: boolean;
  compact?: boolean;
  role?: "status" | "alert";
  action?: { label: string; onClick: () => void };
}

export default function StageNotice({
  title,
  detail,
  icon: Icon,
  busy = false,
  compact = false,
  role,
  action,
}: StageNoticeProps) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#131316] p-4 text-center"
      role={role}
    >
      {busy ? (
        <Loader2
          size={compact ? 20 : 28}
          strokeWidth={1.75}
          className="animate-spin text-[#fafafa]/56"
          aria-hidden="true"
        />
      ) : Icon ? (
        <Icon
          size={compact ? 22 : 32}
          strokeWidth={1.75}
          className="text-[#F95F4A]"
          aria-hidden="true"
        />
      ) : null}
      <p
        className={`font-medium text-[#fafafa] ${
          compact ? "text-[11.5px]" : "text-[14px]"
        }`}
      >
        {title}
      </p>
      {detail && !compact ? (
        <p className="max-w-[20rem] text-[12px] leading-snug text-[#fafafa]/56">
          {detail}
        </p>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className={`mt-1 rounded-full border border-[#fafafa]/14 bg-[#18181b] font-medium text-[#fafafa]/82 transition-colors duration-100 hover:bg-[#232327] hover:text-[#fafafa] ${
            compact ? "px-3 py-1.5 text-[11.5px]" : "px-4 py-2 text-[13px]"
          }`}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

"use client";

import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { AdminNoticeNotification } from "../lib/types";

interface AdminNoticePillProps {
  notice?: AdminNoticeNotification | null;
  compact?: boolean;
}

export default function AdminNoticePill({
  notice,
  compact = false,
}: AdminNoticePillProps) {
  const message = notice?.message?.trim();
  if (!message) return null;

  const level = notice?.level ?? "info";
  const Icon =
    level === "error" ? XCircle : level === "warning" ? AlertTriangle : Info;
  const tone =
    level === "error"
      ? "text-[#F95F4A]"
      : level === "warning"
        ? "text-amber-300"
        : "text-[#fafafa]/72";

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center px-4">
      <div
        className={`flex max-w-[min(36rem,calc(100vw-2rem))] items-center gap-2 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/82 text-[#fafafa] shadow-[0_14px_42px_rgba(0,0,0,0.32)] backdrop-blur-md ${
          compact ? "px-3 py-2" : "px-3.5 py-2.5"
        }`}
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        role="status"
        aria-live="polite"
      >
        <Icon
          size={compact ? 14 : 16}
          strokeWidth={1.75}
          className={`shrink-0 ${tone}`}
        />
        <span
          className={`min-w-0 truncate font-medium leading-snug ${
            compact ? "text-[12px]" : "text-[13px]"
          }`}
          title={message}
        >
          {message}
        </span>
      </div>
    </div>
  );
}

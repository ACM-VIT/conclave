"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface StageSourcePillProps {
  icon: LucideIcon;
  label: string;
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}

export default function StageSourcePill({
  icon: Icon,
  label,
  compact = false,
  className = "",
  children,
}: StageSourcePillProps) {
  return (
    <div
      className={`absolute flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 ${
        compact ? "bottom-2 left-2 px-2.5 py-1" : "left-3 top-3 px-3 py-1.5"
      } ${className}`}
    >
      <Icon
        size={compact ? 15 : 18}
        strokeWidth={1.75}
        className="shrink-0 text-[#F95F4A]"
        aria-hidden="true"
      />
      <span
        className={`truncate font-medium text-[#fafafa] ${
          compact ? "text-[12.5px]" : "text-[13px]"
        }`}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

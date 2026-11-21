"use client";

import { color } from "@conclave/ui-tokens";

interface RoomPresenceBadgeProps {
  count: number;
  className?: string;
}

export default function RoomPresenceBadge({
  count,
  className = "",
}: RoomPresenceBadgeProps) {
  const hasPeople = count > 0;
  const label =
    count === 0
      ? "No one here yet"
      : count === 1
        ? "1 person here"
        : `${count} people here`;

  return (
    <span
      role="status"
      aria-live="polite"
      className={
        "flex items-center gap-1.5 text-[11.5px] font-medium leading-none " + className
      }
      style={{ color: hasPeople ? color.textMuted : color.textFaint }}
    >
      {hasPeople ? (
        <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
          <span
            className="relative inline-flex h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color.accent }}
          />
        </span>
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

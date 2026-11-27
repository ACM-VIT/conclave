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
        "flex items-center text-[11.5px] font-medium leading-none " + className
      }
      style={{ color: hasPeople ? color.textMuted : color.textFaint }}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

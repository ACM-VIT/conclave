"use client";

import { color } from "@conclave/ui-tokens";

interface RoomPresenceBadgeProps {
  count: number | null;
  loading?: boolean;
  className?: string;
}

export default function RoomPresenceBadge({
  count,
  loading = false,
  className = "",
}: RoomPresenceBadgeProps) {
  const isChecking = loading && count == null;
  const hasPeople = typeof count === "number" && count > 0;

  const label = isChecking
    ? "Checking…"
    : count == null
      ? null
      : count === 0
        ? "No one here yet"
        : count === 1
          ? "1 person here"
          : `${count} people here`;

  if (!label) return null;

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

"use client";

import { color } from "@conclave/ui-tokens";

interface RoomPresenceBadgeProps {
  // Number of people already in the room (excluding you), or null when unknown.
  count: number | null;
  // True while the first occupancy check is still in flight.
  loading?: boolean;
  className?: string;
}

// Quiet inline status that tells you who's already in a room before you join —
// "No one else is here yet" / "2 people are here". Designed to sit on the field
// label row (right-aligned) so it reads as a contextual hint without taking up
// its own space or overlapping the input/button.
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
            className="absolute inline-flex h-full w-full animate-ping rounded-full"
            style={{ backgroundColor: color.accent, opacity: 0.5 }}
          />
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

import React from "react";

/** Screen-with-play glyph for launcher surfaces. */
export function WatchAppIcon() {
  return (
    <svg
      width={19}
      height={19}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="13" rx="2.5" />
      <path d="M10 8.5v5l4.4-2.5Z" fill="currentColor" stroke="none" />
      <path d="M9 21h6" />
    </svg>
  );
}

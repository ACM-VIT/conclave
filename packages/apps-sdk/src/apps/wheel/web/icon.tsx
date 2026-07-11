import React from "react";

/** Segmented-wheel glyph for launcher surfaces. */
export function WheelAppIcon() {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v6.5" />
      <path d="m19.8 16.5-5.6-3.25" />
      <path d="m4.2 16.5 5.6-3.25" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

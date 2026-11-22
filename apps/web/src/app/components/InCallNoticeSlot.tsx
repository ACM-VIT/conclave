"use client";

import type { ReactNode } from "react";

interface InCallNoticeSlotProps {
  children: ReactNode;
  rightInset?: number;
  belowWebinarHeader?: boolean;
}

export default function InCallNoticeSlot({
  children,
  rightInset = 0,
  belowWebinarHeader = false,
}: InCallNoticeSlotProps) {
  return (
    <div
      data-in-call-notices
      className="pointer-events-none absolute inset-x-0 top-0 z-40 flex flex-col items-center gap-2 px-3 pt-3 md:px-40"
      style={{
        right: rightInset,
        paddingTop: belowWebinarHeader
          ? "calc(env(safe-area-inset-top, 0px) + 92px)"
          : undefined,
      }}
    >
      {children}
    </div>
  );
}

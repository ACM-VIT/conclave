"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

interface InCallNoticeSlotProps {
  children: ReactNode;
  rightInset?: number;
  belowWebinarHeader?: boolean;
}

export function InCallNoticeSlot({
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

interface InCallNoticeProps {
  show: boolean;
  children: ReactNode;
  className?: string;
  passive?: boolean;
}

export function InCallNotice({
  show,
  children,
  className = "max-w-full",
  passive = false,
}: InCallNoticeProps) {
  const reduceMotion = useReducedMotion();
  const offset = reduceMotion ? 0 : -6;
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          layout={reduceMotion ? false : "position"}
          initial={{ opacity: 0, y: offset }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: offset }}
          transition={{ duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT }}
          className={`${passive ? "pointer-events-none" : "pointer-events-auto"} flex justify-center ${className}`}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

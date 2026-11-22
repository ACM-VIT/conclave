"use client";

import type { ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

interface InCallNoticeProps {
  show: boolean;
  children: ReactNode;
}

function NoticeFrame({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const offset = reduceMotion ? 0 : -6;
  return (
    <motion.div
      layout={reduceMotion ? false : "position"}
      initial={{ opacity: 0, y: offset }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: offset }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT }}
      inert={!isPresent}
      aria-hidden={!isPresent || undefined}
      className={`${isPresent ? "pointer-events-auto" : "pointer-events-none"} flex w-full max-w-[560px] justify-center`}
    >
      {children}
    </motion.div>
  );
}

export default function InCallNotice({ show, children }: InCallNoticeProps) {
  return (
    <AnimatePresence>
      {show ? <NoticeFrame>{children}</NoticeFrame> : null}
    </AnimatePresence>
  );
}

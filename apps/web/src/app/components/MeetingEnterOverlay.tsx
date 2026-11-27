"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import type { MeetError } from "../lib/types";
import { playConclaveLock } from "../lib/conclaveSound";
import ConclaveLottie from "./ConclaveLottie";
import { BrandCaption, BrandMessage } from "./ConclaveBrandScreen";
import { BRAND_BTN_GHOST, BRAND_BTN_PRIMARY } from "./brandScreenStyles";
import { describeEnterError } from "../lib/meeting-enter-error";

export type MeetingEnterAction = "new" | "join";

type MeetingEnterOverlayProps = {
  show: boolean;
  action: MeetingEnterAction | null;
  error?: MeetError | null;
  roomId?: string;
  dismissLabel?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  onStartNewMeeting?: () => void;
};

const EASE = [0.22, 1, 0.36, 1] as const;

export default function MeetingEnterOverlay({
  show,
  action,
  error,
  roomId = "",
  dismissLabel = "Back to setup",
  onRetry,
  onDismiss,
  onStartNewMeeting,
}: MeetingEnterOverlayProps) {
  const [shownAction, setShownAction] = useState<MeetingEnterAction>("new");
  useEffect(() => {
    if (action) setShownAction(action);
  }, [action]);

  useEffect(() => {
    if (show) playConclaveLock();
  }, [show]);

  const reduceMotion = usePrefersReducedMotion();
  const scale = (value: number) => `scale(${reduceMotion ? 1 : value})`;
  const rise = (px: number) => `translateY(${reduceMotion ? 0 : px}px)`;

  const caption =
    shownAction === "new" ? "Starting your meeting" : "Joining the meeting";
  const errored = Boolean(error);
  const described = error ? describeEnterError(shownAction, error, roomId) : null;

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="meeting-enter-overlay"
          className="fixed inset-0 z-[200] overflow-hidden bg-black"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, pointerEvents: "auto" }}
          exit={{ opacity: 0, pointerEvents: "none" }}
          transition={{ duration: 0.42, ease: EASE }}
        >
          <motion.div
            className="absolute inset-0"
            initial={{ transform: scale(1.04) }}
            animate={{ transform: scale(1) }}
            exit={{ transform: scale(1.015) }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <ConclaveLottie />
          </motion.div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black via-black/65 to-transparent" />

          <div className="absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom,0px)+5vh,7vh)] flex justify-center px-6 text-center">
            <AnimatePresence mode="wait" initial={false}>
              {errored && described ? (
                <motion.div
                  key="error"
                  className="flex w-full justify-center"
                  initial={{ opacity: 0, transform: rise(8) }}
                  animate={{ opacity: 1, transform: rise(0) }}
                  exit={{ opacity: 0, transform: rise(-6) }}
                  transition={{ duration: 0.38, ease: EASE }}
                >
                  <BrandMessage
                    eyebrow={
                      error?.code === "ROOM_NOT_FOUND"
                        ? undefined
                        : "Something went wrong"
                    }
                    title={described.title}
                    detail={described.detail}
                    actions={
                      <>
                        {described.canRetry ? (
                          <button
                            type="button"
                            onClick={onRetry}
                            className={BRAND_BTN_PRIMARY}
                          >
                            Try again
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={onDismiss}
                          className={
                            described.canRetry
                              ? BRAND_BTN_GHOST
                              : BRAND_BTN_PRIMARY
                          }
                        >
                          {dismissLabel}
                        </button>
                        {onStartNewMeeting ? (
                          <button
                            type="button"
                            onClick={onStartNewMeeting}
                            className={BRAND_BTN_GHOST}
                          >
                            Start a new meeting instead
                          </button>
                        ) : null}
                      </>
                    }
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="loading"
                  className="pointer-events-none"
                  initial={{ opacity: 0, transform: rise(6) }}
                  animate={{ opacity: 1, transform: rise(0) }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.45, ease: "easeOut" }}
                >
                  <BrandCaption>{caption}</BrandCaption>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

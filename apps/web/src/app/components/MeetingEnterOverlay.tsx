"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { MeetError } from "../lib/types";
import { playConclaveLock } from "../lib/conclaveSound";
import ConclaveLottie from "./ConclaveLottie";
import { BrandCaption, BrandMessage } from "./ConclaveBrandScreen";
import { BRAND_BTN_GHOST, BRAND_BTN_PRIMARY } from "./brandScreenStyles";

export type MeetingEnterAction = "new" | "join";

type MeetingEnterOverlayProps = {
  show: boolean;
  action: MeetingEnterAction | null;
  error?: MeetError | null;
  onRetry?: () => void;
  onDismiss?: () => void;
};

const EASE = [0.22, 1, 0.36, 1] as const;

// Friendly, on-brand copy for each failure mode. `canRetry` distinguishes a
// transient connection issue (re-attemptable in place) from a device/permission
// problem that has to be fixed back in the lobby.
function describeError(
  action: MeetingEnterAction,
  error: MeetError,
): { title: string; detail: string; canRetry: boolean } {
  const verb = action === "new" ? "start" : "join";
  switch (error.code) {
    case "PERMISSION_DENIED":
      return {
        title: "Camera & mic are blocked",
        detail:
          "Allow access to your camera and microphone, then head back to setup to try again.",
        canRetry: false,
      };
    case "MEDIA_ERROR":
      return {
        title: "No camera or mic found",
        detail:
          "Check that your devices are connected, then head back to setup to try again.",
        canRetry: false,
      };
    case "CONNECTION_FAILED":
      return {
        title: `Couldn't ${verb} the meeting`,
        detail:
          "We couldn't reach the server. Check your connection and give it another go.",
        canRetry: true,
      };
    case "TRANSPORT_ERROR":
      return {
        title: `Couldn't ${verb} the meeting`,
        detail:
          "The media connection didn't go through. Another try usually does it.",
        canRetry: true,
      };
    case "UNKNOWN": {
      // Surface a clean server message (e.g. "Room not found") but hide raw
      // transport noise (e.g. "xhr poll error", "Failed to fetch").
      const raw = (error.message || "").trim();
      const technical =
        !raw ||
        /xhr|poll|websocket|transport|socket|network|fetch|timeout|load failed|econnrefused|err_/i.test(
          raw,
        );
      return {
        title: `Couldn't ${verb} the meeting`,
        detail: technical
          ? "Something interrupted the connection. Check your network and try again."
          : raw,
        canRetry: true,
      };
    }
  }
}

// Full-screen brand animation that takes over the instant a meeting is created
// or joined, so the navigation feels immediate while the SFU connection settles
// underneath. The Lottie stays the visible centerpiece throughout; the caption
// and (on failure) the error both sit low so they never cover the mark.
export default function MeetingEnterOverlay({
  show,
  action,
  error,
  onRetry,
  onDismiss,
}: MeetingEnterOverlayProps) {
  // Hold the last real action so copy doesn't flip during fade-out (the parent
  // clears `action` to null at the same time it sets `show` false).
  const [shownAction, setShownAction] = useState<MeetingEnterAction>("new");
  useEffect(() => {
    if (action) setShownAction(action);
  }, [action]);

  // The takeover follows a New/Join click, so the lock sound is within the user
  // activation window and plays. Once per overlay session (not on every render).
  useEffect(() => {
    if (show) playConclaveLock();
  }, [show]);

  const caption =
    shownAction === "new" ? "Starting your meeting" : "Joining the meeting";
  const errored = Boolean(error);
  const described = error ? describeError(shownAction, error) : null;

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="meeting-enter-overlay"
          className="fixed inset-0 z-[200] overflow-hidden bg-black"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.42, ease: EASE }}
        >
          <motion.div
            className="absolute inset-0"
            initial={{ scale: 1.04 }}
            animate={{ scale: 1 }}
            exit={{ scale: 1.015 }}
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
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.38, ease: EASE }}
                >
                  <BrandMessage
                    eyebrow="Something went wrong"
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
                          Back to setup
                        </button>
                      </>
                    }
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="loading"
                  className="pointer-events-none"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
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

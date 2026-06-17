"use client";

import { AlertCircle, X } from "lucide-react";
import type { MeetError } from "../lib/types";

interface MeetsErrorBannerProps {
  meetError: MeetError;
  onDismiss: () => void;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  variant?: "strip" | "inline";
}

export default function MeetsErrorBanner({
  meetError,
  onDismiss,
  primaryActionLabel,
  onPrimaryAction,
  variant = "strip",
}: MeetsErrorBannerProps) {
  const isGuestBlockedError =
    meetError.message === "Guests are not allowed in this meeting.";
  const isRoomNotFoundError = meetError.message === "No room found.";
  const helperText = isGuestBlockedError
    ? "This room only allows signed-in users. Sign in to join."
    : isRoomNotFoundError
    ? "Double-check the code and try again."
    : meetError.code === "PERMISSION_DENIED"
    ? "Allow camera and microphone access in your browser, then try again."
    : meetError.code === "MEDIA_ERROR"
    ? "Check that your camera and microphone aren’t in use by another app."
    : null;

  const shellClass =
    variant === "inline"
      ? "w-full min-w-0 rounded-xl border border-[#F95F4A]/20 bg-[#F95F4A]/[0.07] px-3.5 py-3 flex items-start gap-3"
      : "w-full min-w-0 px-6 py-3.5 bg-[#F95F4A]/[0.07] border-b border-[#F95F4A]/25 flex items-start gap-3 backdrop-blur-sm";

  return (
    <div className={shellClass} role="alert">
      <AlertCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-[#F95F4A]"
        strokeWidth={2}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words text-[13.5px] font-medium leading-5 text-[#fafafa]">
          {meetError.message}
        </span>
        {helperText && (
          <span className="break-words text-[12px] leading-4 text-[#fafafa]/50">
            {helperText}
          </span>
        )}
        {primaryActionLabel && onPrimaryAction && (
          <button
            onClick={onPrimaryAction}
            className="mt-2 inline-flex w-fit items-center rounded-lg bg-[#F95F4A]/15 px-3 py-1.5 text-[12.5px] font-medium text-[#F95F4A] transition-colors hover:bg-[#F95F4A]/25"
          >
            {primaryActionLabel}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="-mr-1 -mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#fafafa]/40 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]/80"
        aria-label="Dismiss error"
        title="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

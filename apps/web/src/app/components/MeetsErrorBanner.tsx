"use client";

import { useState } from "react";
import { AlertCircle, X } from "lucide-react";
import type { MeetError } from "../lib/types";
import InCallNoticeCard from "./InCallNoticeCard";

interface MeetsErrorBannerProps {
  meetError: MeetError;
  onDismiss: () => void;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  variant?: "strip" | "inline";
  collapseOnDismiss?: boolean;
}

const DEVICE_ACCESS = {
  camera: "camera",
  microphone: "microphone",
  both: "camera and microphone",
} as const;

const causeAdvice = (
  device: "camera" | "microphone",
  cause: NonNullable<MeetError["causes"]>["camera"],
) =>
  !cause || cause.kind === "other"
    ? null
    : cause.kind === "blocked"
      ? `allow ${device} access in your browser`
      : `check that your ${device} isn’t in use by another app`;

function mixedCauseAdvice(meetError: MeetError): string | null {
  const camera = meetError.causes?.camera;
  const microphone = meetError.causes?.microphone;
  if (!camera || !microphone || camera.kind === microphone.kind) return null;
  const parts = [causeAdvice("microphone", microphone), causeAdvice("camera", camera)].filter(
    (part): part is string => Boolean(part),
  );
  if (parts.length === 0) return null;
  const sentence = parts.join(", and ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}, then try again.`;
}

export default function MeetsErrorBanner({
  meetError,
  onDismiss,
  primaryActionLabel,
  onPrimaryAction,
  variant = "strip",
  collapseOnDismiss = false,
}: MeetsErrorBannerProps) {
  const [collapsedError, setCollapsedError] = useState<MeetError | null>(null);
  const isCollapsed = collapsedError === meetError;
  const collapsesOnDismiss =
    collapseOnDismiss && Boolean(primaryActionLabel && onPrimaryAction);
  const devices = DEVICE_ACCESS[meetError.device ?? "both"];
  const isGuestBlockedError =
    meetError.message === "Guests are not allowed in this meeting.";
  const isRoomNotFoundError = meetError.message === "No room found.";
  const mixedAdvice = mixedCauseAdvice(meetError);
  const helperText = mixedAdvice
    ? mixedAdvice
    : isGuestBlockedError
    ? "This room only allows signed-in users. Sign in to join."
    : isRoomNotFoundError
    ? "Double-check the code and try again."
    : meetError.code === "PERMISSION_DENIED"
    ? `Allow ${devices} access in your browser, then try again.`
    : meetError.code === "MEDIA_ERROR"
    ? meetError.device === "both" || !meetError.device
      ? "Check that your camera and microphone aren’t in use by another app."
      : `Check that your ${devices} isn’t in use by another app.`
    : null;

  if (variant === "strip") {
    return (
      <InCallNoticeCard
        tone="error"
        icon={AlertCircle}
        title={meetError.message}
        detail={helperText}
        actionLabel={primaryActionLabel}
        onAction={onPrimaryAction}
        compact={isCollapsed}
        onDismiss={
          isCollapsed
            ? undefined
            : collapsesOnDismiss
              ? () => setCollapsedError(meetError)
              : onDismiss
        }
        dismissLabel="Dismiss error"
      />
    );
  }

  return (
    <div
      className="w-full min-w-0 rounded-xl border border-[#F95F4A]/20 bg-[#F95F4A]/[0.07] px-3.5 py-3 flex items-start gap-3"
      role="alert"
    >
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

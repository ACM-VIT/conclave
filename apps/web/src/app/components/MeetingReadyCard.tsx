"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, UserPlus, X } from "lucide-react";
import { copyText, meetingLinkFor } from "../lib/meeting-link";

export function useMeetingReadyCard(roomId: string, hasCompany: boolean) {
  const [finishedRoomId, setFinishedRoomId] = useState<string | null>(null);
  useEffect(() => {
    if (hasCompany) setFinishedRoomId(roomId);
  }, [hasCompany, roomId]);
  const dismiss = useCallback(() => setFinishedRoomId(roomId), [roomId]);
  return { isOpen: finishedRoomId !== roomId, dismiss };
}

interface MeetingReadyCardProps {
  roomId: string;
  isHost: boolean;
  isMobile: boolean;
  onDismiss: () => void;
}

type Feedback = "idle" | "linkCopied" | "inviteCopied" | "shared";

const FEEDBACK_MS = 2000;

export default function MeetingReadyCard({
  roomId,
  isHost,
  isMobile,
  onDismiss,
}: MeetingReadyCardProps) {
  const [feedback, setFeedback] = useState<Feedback>("idle");
  const resetTimerRef = useRef<number | null>(null);
  const link = meetingLinkFor(roomId);

  useEffect(
    () => () => {
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const flash = (next: Feedback) => {
    setFeedback(next);
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(
      () => setFeedback("idle"),
      FEEDBACK_MS,
    );
  };

  const copyLink = async () => {
    if (await copyText(link)) flash("linkCopied");
  };

  const addOthers = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Join my Conclave meeting", url: link });
        flash("shared");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    if (await copyText(`Join my Conclave meeting: ${link}`)) {
      flash("inviteCopied");
    }
  };

  return (
    <section
      aria-labelledby="meeting-ready-title"
      className={`absolute top-3 z-30 rounded-xl border border-[#fafafa]/12 bg-[#18181b] p-4 text-[#fafafa] ${
        isMobile ? "inset-x-3" : "left-3 w-[21rem] max-w-[calc(100%-1.5rem)]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h2
          id="meeting-ready-title"
          className="pt-0.5 text-[15px] font-semibold leading-tight"
        >
          {isHost ? "Your meeting's ready" : "You are the only one here"}
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1.5 -mt-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#fafafa]/70 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#fafafa]/30"
        >
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>
      <button
        type="button"
        onClick={() => void addOthers()}
        className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[#F95F4A] px-3.5 text-[13px] font-medium text-white transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F95F4A]/40"
      >
        <UserPlus size={16} strokeWidth={1.8} />
        {feedback === "shared"
          ? "Invite sent"
          : feedback === "inviteCopied"
            ? "Invite copied"
            : "Add others"}
      </button>
      <p className="mt-3 text-[12.5px] leading-snug text-[#fafafa]/70">
        Or share this meeting link with others you want in the meeting.
      </p>
      <div className="mt-2 flex items-center gap-1 rounded-lg bg-white/[0.05] py-1 pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-[13px] text-[#fafafa]/90">
          {link.replace(/^https?:\/\//, "")}
        </span>
        <button
          type="button"
          onClick={() => void copyLink()}
          aria-label={
            feedback === "linkCopied" ? "Meeting link copied" : "Copy meeting link"
          }
          title="Copy meeting link"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#fafafa]/75 transition-colors hover:bg-white/[0.08] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#fafafa]/30"
        >
          {feedback === "linkCopied" ? (
            <Check size={16} strokeWidth={2} className="text-[#22c55e]" />
          ) : (
            <Copy size={16} strokeWidth={1.8} />
          )}
        </button>
      </div>
    </section>
  );
}

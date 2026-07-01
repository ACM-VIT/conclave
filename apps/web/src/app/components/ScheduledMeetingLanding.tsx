"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Copy, Loader2, PlayCircle } from "lucide-react";
import type { PublicScheduledMeeting } from "@/lib/scheduled-meetings";
import { buildMeetingPath, buildMeetingUrl } from "@/lib/meeting-links";

type Props = {
  meeting: PublicScheduledMeeting;
  clientId: string;
  viewerIsHost: boolean;
};

const pad = (n: number): string => String(n).padStart(2, "0");

const formatCountdown = (ms: number): string => {
  if (ms <= 0) return "starting now";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  }
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

const formatScheduledTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const CTA_PRIMARY =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05] disabled:cursor-not-allowed disabled:opacity-50";
const CTA_GHOST =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-[15px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.08]";

export default function ScheduledMeetingLanding({
  meeting,
  clientId,
  viewerIsHost,
}: Props) {
  const [now, setNow] = useState<number>(() => Date.now());
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = meeting.scheduledStartAt - now;
  const isLive = useMemo(() => {
    if (meeting.status === "cancelled") return false;
    if (meeting.startedAt !== null) return true;
    return now >= meeting.scheduledStartAt;
  }, [meeting, now]);

  const shareLink = useMemo(() => {
    if (typeof window === "undefined") return "";
    return buildMeetingUrl(window.location.origin, {
      roomCode: meeting.roomCode,
      clientId,
    });
  }, [clientId, meeting.roomCode]);

  useEffect(() => {
    if (!isLive) return;
    window.location.reload();
  }, [isLive]);

  const handleCopy = useCallback(async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }, [shareLink]);

  const handleStartNow = useCallback(async () => {
    if (isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const response = await fetch(
        `/api/meetings/scheduled/${encodeURIComponent(meeting.id)}/start`,
        { method: "POST" },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          (data && typeof data === "object" && "error" in data
            ? String((data as { error?: string }).error || "")
            : "") || "Could not start the meeting",
        );
      }
      window.location.reload();
    } catch (error) {
      setStartError((error as Error).message || "Could not start the meeting");
      setIsStarting(false);
    }
  }, [isStarting, meeting.id]);

  if (meeting.status === "cancelled") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
        <section className="animate-fade-in w-full max-w-lg rounded-2xl border border-white/10 bg-[#0e0e10] p-6 sm:p-8 text-center">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
            Scheduled meeting
          </p>
          <h1
            className="mt-3 text-[22px] leading-tight text-[#fafafa]"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            This meeting was cancelled
          </h1>
          <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
            The host called this one off. Reach out to them if you think this
            is a mistake.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
      <section className="animate-fade-in w-full max-w-lg rounded-2xl border border-white/10 bg-[#0e0e10] p-6 sm:p-8 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] text-[#fafafa]/55">
          <CalendarClock className="h-3.5 w-3.5" />
          Scheduled meeting
        </div>

        <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
          Starts in
        </p>
        <p
          className="mt-2 text-[44px] leading-none tabular-nums text-[#fafafa] sm:text-[52px]"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          {formatCountdown(remaining)}
        </p>

        <h1 className="mt-6 text-[20px] font-medium leading-snug text-[#fafafa]">
          {meeting.title}
        </h1>
        <p className="mt-2 text-[13.5px] text-[#fafafa]/55">
          {formatScheduledTime(meeting.scheduledStartAt)}
          {meeting.hostName ? ` · Hosted by ${meeting.hostName}` : ""}
        </p>

        <div className="mt-8 flex flex-col gap-2.5">
          {viewerIsHost && !isLive && (
            <button
              type="button"
              onClick={() => void handleStartNow()}
              disabled={isStarting}
              className={CTA_PRIMARY}
            >
              {isStarting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PlayCircle className="h-4 w-4" />
              )}
              {isStarting ? "Starting..." : "Start the meeting now"}
            </button>
          )}
          {isLive && (
            <a
              href={buildMeetingPath({
                roomCode: meeting.roomCode,
                clientId,
              })}
              className={CTA_PRIMARY}
            >
              Open the meeting
            </a>
          )}
          <button type="button" onClick={() => void handleCopy()} className={CTA_GHOST}>
            <Copy className="h-4 w-4" />
            {copied ? "Copied" : "Copy share link"}
          </button>
        </div>

        {startError ? (
          <p className="mt-4 text-[13px] text-[#F95F4A]">{startError}</p>
        ) : null}
      </section>
    </main>
  );
}

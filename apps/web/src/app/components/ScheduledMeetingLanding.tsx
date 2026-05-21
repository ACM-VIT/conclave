"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { CalendarClock, Copy, Loader2, PlayCircle } from "lucide-react";
import type { PublicScheduledMeeting } from "@/lib/scheduled-meetings";

type Props = {
  meeting: PublicScheduledMeeting;
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

export default function ScheduledMeetingLanding({
  meeting,
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
    return `${window.location.origin}/${meeting.roomCode}`;
  }, [meeting.roomCode]);

  useEffect(() => {
    if (!isLive) return;
    const timeout = setTimeout(() => {
      window.location.reload();
    }, 500);
    return () => clearTimeout(timeout);
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
      <div
        className="relative min-h-dvh bg-[#060606] text-[#FEFCD9] overflow-hidden"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      >
        <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
        <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
        <main className="relative z-10 mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center px-6 text-center">
          <p className="text-sm text-[#FEFCD9]/45">scheduled meeting</p>
          <h1
            className="mt-2 text-4xl md:text-5xl text-[#FEFCD9] tracking-tight"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            this meeting was cancelled
          </h1>
          <p className="mt-3 max-w-md text-sm text-[#FEFCD9]/55">
            The host called this one off. Reach out to them if you think this
            is a mistake.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-dvh bg-[#060606] text-[#FEFCD9] overflow-hidden"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      <div className="absolute inset-0 acm-bg-radial pointer-events-none" />

      <header className="relative z-10 flex items-center justify-between px-6 py-5">
        <a href="/" className="flex items-center" aria-label="ACM-VIT">
          <Image
            src="/assets/acm_topleft.svg"
            alt="ACM-VIT"
            width={120}
            height={32}
            priority
          />
        </a>
        <span className="hidden md:inline-flex items-center gap-2 text-xs text-[#FEFCD9]/45">
          <CalendarClock className="h-3.5 w-3.5" />
          scheduled meeting
        </span>
      </header>

      <main className="relative z-[5] mx-auto flex min-h-[calc(100dvh-72px)] w-full max-w-3xl flex-col items-center justify-center px-6 pb-24 text-center">
        <p className="text-sm text-[#FEFCD9]/45">starts in</p>
        <h1
          className="mt-3 text-6xl md:text-7xl text-[#FEFCD9] tracking-tight tabular-nums"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          {formatCountdown(remaining)}
        </h1>
        <p className="mt-6 text-lg md:text-xl text-[#FEFCD9]/85 max-w-2xl">
          {meeting.title}
        </p>
        <p className="mt-2 text-sm text-[#FEFCD9]/55">
          {formatScheduledTime(meeting.scheduledStartAt)}
          {meeting.hostName ? ` · hosted by ${meeting.hostName}` : ""}
        </p>

        <div className="mt-10 flex flex-col items-center gap-3">
          {viewerIsHost && !isLive && (
            <button
              type="button"
              onClick={() => void handleStartNow()}
              disabled={isStarting}
              className="inline-flex items-center gap-2 rounded-lg bg-[#F95F4A] px-5 py-2.5 text-sm text-white transition-all hover:bg-[#e8553f] hover:gap-3 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:gap-2"
            >
              {isStarting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PlayCircle className="h-4 w-4" />
              )}
              <span>{isStarting ? "Starting…" : "Start the meeting now"}</span>
            </button>
          )}
          {isLive && (
            <a
              href={`/${encodeURIComponent(meeting.roomCode)}`}
              className="inline-flex items-center gap-2 rounded-lg bg-[#F95F4A] px-5 py-2.5 text-sm text-white transition-all hover:bg-[#e8553f] hover:gap-3"
            >
              Open the meeting →
            </a>
          )}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-2 rounded-lg border border-[#FEFCD9]/15 px-4 py-2 text-xs text-[#FEFCD9]/75 transition hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9]"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "copied" : "copy share link"}
          </button>
        </div>

        {startError && (
          <p className="mt-4 text-xs text-[#F95F4A]">{startError}</p>
        )}

        <footer className="mt-16 flex flex-col items-center text-[#FEFCD9]/30">
          <div className="relative inline-block">
            <span
              className="absolute -left-5 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-2xl"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              [
            </span>
            <span
              className="text-2xl text-[#FEFCD9]/65 tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              c0nclav3
            </span>
            <span
              className="absolute -right-5 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-2xl"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              ]
            </span>
          </div>
          <p className="mt-3 text-xs text-[#FEFCD9]/30">
            video conferencing by ACM-VIT
          </p>
        </footer>
      </main>
    </div>
  );
}

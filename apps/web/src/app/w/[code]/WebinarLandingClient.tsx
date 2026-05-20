"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CalendarPlus,
  Clock,
  Copy,
  Link2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import MeetsClientShell from "../../meets-client-shell";

type PublicScheduledWebinar = {
  id: string;
  linkSlug: string;
  title: string;
  description: string;
  hostName: string;
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: "scheduled" | "live" | "ended" | "cancelled";
  publicAccess: boolean;
  requiresInviteCode: boolean;
  waitingRoomEnabled: boolean;
  earlyEntryMinutes: number;
  qaEnabled: boolean;
  webinarLink: string;
  roomId: string;
  clientId: string;
  totalJoinCount: number;
  peakAttendeeCount: number;
};

type Props = {
  webinarLinkCode: string;
  initialWebinar: PublicScheduledWebinar | null;
};

const pad = (n: number): string => String(n).padStart(2, "0");

const formatCountdown = (ms: number): string => {
  if (ms <= 0) return "starting…";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
};

const formatStartString = (timestamp: number): string => {
  const d = new Date(timestamp);
  return d.toLocaleString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
};

const buildGoogleCalendarUrl = (webinar: PublicScheduledWebinar): string => {
  const startIso =
    new Date(webinar.scheduledStartAt)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const endIso =
    new Date(webinar.scheduledEndAt)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: webinar.title,
    dates: `${startIso}/${endIso}`,
    details: `${webinar.description ?? ""}\n\nJoin: ${webinar.webinarLink}`,
    location: webinar.webinarLink,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};

export default function WebinarLandingClient({
  webinarLinkCode,
  initialWebinar,
}: Props) {
  const [webinar, setWebinar] = useState<PublicScheduledWebinar | null>(
    initialWebinar,
  );
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!webinar) return;
    if (webinar.status === "ended" || webinar.status === "cancelled") return;
    const interval = setInterval(async () => {
      try {
        const response = await fetch(
          `/api/webinars/by-slug/${encodeURIComponent(webinar.linkSlug)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          scheduledWebinar?: PublicScheduledWebinar | null;
        };
        if (data?.scheduledWebinar) {
          setWebinar(data.scheduledWebinar);
        }
      } catch (error) {
        setRefreshError((error as Error).message || "");
      }
    }, 20_000);
    return () => clearInterval(interval);
  }, [webinar]);

  const isOpen = useMemo(() => {
    if (!webinar) return true;
    if (webinar.status === "ended" || webinar.status === "cancelled") {
      return false;
    }
    if (webinar.status === "live") return true;
    const earlyMs = (webinar.earlyEntryMinutes ?? 0) * 60 * 1000;
    return now >= webinar.scheduledStartAt - earlyMs;
  }, [webinar, now]);

  if (isOpen) {
    return (
      <MeetsClientShell
        initialRoomId={webinarLinkCode}
        forceJoinOnly={true}
        bypassMediaPermissions={true}
        joinMode="webinar_attendee"
        autoJoinOnMount={true}
        hideJoinUI={true}
      />
    );
  }

  if (!webinar) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-[#060606] text-[#FEFCD9]"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      >
        <div className="max-w-md rounded-2xl border border-[#FEFCD9]/10 bg-black/30 p-8 text-center">
          <Loader2 className="mx-auto mb-4 h-6 w-6 animate-spin text-[#FEFCD9]/50" />
          <p className="text-xs uppercase tracking-[0.18em] text-[#FEFCD9]/45">
            Looking up webinar
          </p>
        </div>
      </div>
    );
  }

  if (webinar.status === "ended" || webinar.status === "cancelled") {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-[#060606] text-[#FEFCD9]"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      >
        <div className="max-w-md rounded-2xl border border-[#FEFCD9]/10 bg-black/40 p-8 text-center">
          <p
            className="text-[10px] uppercase tracking-[0.18em] text-[#FEFCD9]/40"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            {webinar.status === "cancelled" ? "Cancelled" : "Ended"}
          </p>
          <h1 className="mt-2 text-xl text-[#FEFCD9]">{webinar.title}</h1>
          {webinar.description ? (
            <p className="mt-2 text-sm text-[#FEFCD9]/60">
              {webinar.description}
            </p>
          ) : null}
          <p className="mt-4 text-[11px] text-[#FEFCD9]/50">
            This webinar is no longer accepting attendees. Contact the
            organizer for a replay or future sessions.
          </p>
        </div>
      </div>
    );
  }

  const msToStart = webinar.scheduledStartAt - now;
  const earlyEntryWindowMs = (webinar.earlyEntryMinutes ?? 0) * 60 * 1000;
  const msToLobby = webinar.scheduledStartAt - earlyEntryWindowMs - now;

  return (
    <div
      className="min-h-screen bg-[#060606] text-[#FEFCD9]"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
        <div>
          <p
            className="text-[10px] uppercase tracking-[0.2em] text-[#FEFCD9]/35"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            Webinar · {webinar.publicAccess ? "Public" : "Private"} link
          </p>
          <h1 className="mt-2 text-3xl font-medium text-[#FEFCD9]">
            {webinar.title}
          </h1>
          <p className="mt-1 text-sm text-[#FEFCD9]/55">
            Hosted by {webinar.hostName || "the organizer"}
          </p>
        </div>

        <div className="rounded-2xl border border-[#FEFCD9]/10 bg-gradient-to-br from-black/60 to-black/30 p-6">
          <div className="flex flex-wrap items-baseline gap-3">
            <Clock className="h-4 w-4 text-[#F95F4A]" />
            <p
              className="text-[10px] uppercase tracking-[0.2em] text-[#FEFCD9]/45"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              Starts in
            </p>
          </div>
          <div
            className="mt-2 font-mono text-4xl text-[#FEFCD9]"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            {formatCountdown(msToStart)}
          </div>
          <p className="mt-2 text-sm text-[#FEFCD9]/55">
            <CalendarDays className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
            {formatStartString(webinar.scheduledStartAt)}
          </p>
          {webinar.earlyEntryMinutes > 0 ? (
            <p className="mt-1 text-[11px] text-[#FEFCD9]/45">
              Lobby opens{" "}
              {msToLobby > 0
                ? `in ${formatCountdown(msToLobby)}`
                : "now — refresh to join"}{" "}
              ({webinar.earlyEntryMinutes} min before start)
            </p>
          ) : null}
        </div>

        {webinar.description ? (
          <div className="rounded-2xl border border-[#FEFCD9]/10 bg-black/30 p-5">
            <p
              className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[#FEFCD9]/40"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              About
            </p>
            <p className="text-sm leading-relaxed text-[#FEFCD9]/75 whitespace-pre-line">
              {webinar.description}
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <a
            href={buildGoogleCalendarUrl(webinar)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#FEFCD9]/15 bg-black/30 px-4 py-3 text-sm text-[#FEFCD9] hover:border-[#FEFCD9]/35 hover:bg-black/45"
          >
            <CalendarPlus className="h-4 w-4" />
            Add to Google Calendar
          </a>
          <button
            type="button"
            onClick={() => {
              if (typeof navigator === "undefined" || !navigator.clipboard) return;
              void navigator.clipboard.writeText(webinar.webinarLink).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#FEFCD9]/15 bg-black/30 px-4 py-3 text-sm text-[#FEFCD9] hover:border-[#FEFCD9]/35 hover:bg-black/45"
          >
            <Copy className="h-4 w-4" />
            {copied ? "Copied" : "Copy webinar link"}
          </button>
        </div>

        <div className="rounded-2xl border border-[#FEFCD9]/10 bg-black/25 p-5 text-[11px] text-[#FEFCD9]/55">
          <p
            className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[#FEFCD9]/40"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            Tips while you wait
          </p>
          <ul className="space-y-1.5 list-disc pl-4">
            <li>
              Use Chrome, Edge, or Firefox on a desktop for the best
              experience.
            </li>
            <li>
              Test your microphone and speakers. If you don&apos;t plan to
              speak, you&apos;ll join muted.
            </li>
            <li>
              Have the host&apos;s contact handy in case the link needs a
              refresh.
            </li>
            {webinar.requiresInviteCode ? (
              <li>
                <ShieldCheck className="mr-1 inline h-3 w-3 align-text-bottom" />
                Bring the invite code the organizer sent you.
              </li>
            ) : null}
            {webinar.qaEnabled ? (
              <li>Questions and reactions are enabled during the talk.</li>
            ) : null}
          </ul>
        </div>

        <div className="flex items-center gap-2 text-[10px] text-[#FEFCD9]/30">
          <Link2 className="h-3 w-3" />
          <span style={{ fontFamily: "'PolySans Mono', monospace" }}>
            {webinar.webinarLink}
          </span>
          {refreshError ? (
            <span className="text-[#F95F4A]/70">· offline</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

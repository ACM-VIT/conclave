"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { CalendarPlus, Check, Copy, Loader2 } from "lucide-react";
import MeetsClientShell from "../../meets-client-shell";

export type PublicScheduledWebinar = {
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

const formatCountdown = (ms: number): { primary: string; suffix: string } => {
  if (ms <= 0) return { primary: "starting", suffix: "now" };
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return {
      primary: `${days}`,
      suffix: days === 1 ? "day to go" : "days to go",
    };
  }
  if (hours > 0) {
    return {
      primary: `${hours}:${pad(minutes)}:${pad(seconds)}`,
      suffix: "until we begin",
    };
  }
  return {
    primary: `${minutes}:${pad(seconds)}`,
    suffix: "until we begin",
  };
};

const formatStartString = (timestamp: number): string => {
  const d = new Date(timestamp);
  return d.toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const buildGoogleCalendarUrl = (webinar: PublicScheduledWebinar): string => {
  const startIso = new Date(webinar.scheduledStartAt)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const endIso = new Date(webinar.scheduledEndAt)
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

const PageShell = ({ children }: { children: React.ReactNode }) => (
  <div
    className="relative min-h-dvh overflow-hidden bg-[#060606] text-[#FEFCD9]"
    style={{ fontFamily: "'PolySans Trial', sans-serif" }}
  >
    <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
    <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
    <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-6 py-5 pointer-events-none">
      <a
        href="/"
        className="pointer-events-auto flex items-center"
        aria-label="ACM-VIT"
      >
        <Image
          src="/assets/acm_topleft.svg"
          alt="ACM-VIT"
          width={120}
          height={32}
          priority
        />
      </a>
    </header>
    <main className="relative z-[5] flex min-h-dvh items-center justify-center px-6 py-24">
      {children}
    </main>
  </div>
);

const ConclaveLockup = ({ size = "lg" }: { size?: "md" | "lg" }) => {
  const titleClass =
    size === "lg" ? "text-4xl md:text-5xl" : "text-2xl md:text-3xl";
  const bracketClass =
    size === "lg" ? "text-4xl md:text-5xl" : "text-2xl md:text-3xl";
  const offsetClass = size === "lg" ? "-left-8 -right-8" : "-left-5 -right-5";
  return (
    <div className="relative inline-block">
      <span
        className={`absolute ${
          offsetClass.split(" ")[0]
        } top-1/2 -translate-y-1/2 text-[#F95F4A]/40 ${bracketClass}`}
        style={{ fontFamily: "'PolySans Mono', monospace" }}
      >
        [
      </span>
      <h1
        className={`${titleClass} text-[#FEFCD9] tracking-tight`}
        style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
      >
        c0nclav3
      </h1>
      <span
        className={`absolute ${
          offsetClass.split(" ")[1]
        } top-1/2 -translate-y-1/2 text-[#F95F4A]/40 ${bracketClass}`}
        style={{ fontFamily: "'PolySans Mono', monospace" }}
      >
        ]
      </span>
    </div>
  );
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!webinar) return;
    if (webinar.status === "ended" || webinar.status === "cancelled") return;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/webinars/by-slug/${encodeURIComponent(webinar.linkSlug)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          scheduledWebinar?: PublicScheduledWebinar | null;
        };
        if (data?.scheduledWebinar) setWebinar(data.scheduledWebinar);
      } catch {
        // The countdown can continue from the server-rendered snapshot.
      }
    }, 20_000);
    return () => window.clearInterval(interval);
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
        sfuClientId={webinar?.clientId}
        joinMode="webinar_attendee"
        autoJoinOnMount={true}
        hideJoinUI={true}
      />
    );
  }

  if (!webinar) {
    return (
      <PageShell>
        <div className="flex flex-col items-center text-center animate-fade-in">
          <Loader2 className="h-7 w-7 animate-spin text-[#FEFCD9]/45" />
          <p className="mt-4 text-sm text-[#FEFCD9]/45">
            Looking up your webinar...
          </p>
        </div>
      </PageShell>
    );
  }

  if (webinar.status === "ended" || webinar.status === "cancelled") {
    const ended = webinar.status === "ended";
    return (
      <PageShell>
        <div className="flex max-w-xl flex-col items-center text-center animate-fade-in">
          <p className="text-sm text-[#FEFCD9]/40">
            {ended ? "this webinar has ended" : "this webinar was cancelled"}
          </p>
          <h1
            className="mt-4 text-3xl md:text-4xl text-[#FEFCD9] tracking-tight"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {webinar.title}
          </h1>
          <p className="mt-4 text-sm text-[#FEFCD9]/55">
            {ended
              ? "Reach out to the organizer for a replay or about future sessions."
              : "The organizer cancelled this session. Reach out to them for an update."}
          </p>
          <div className="mt-10 text-[#FEFCD9]/30">
            <ConclaveLockup size="md" />
          </div>
        </div>
      </PageShell>
    );
  }

  const msToStart = webinar.scheduledStartAt - now;
  const earlyEntryWindowMs = (webinar.earlyEntryMinutes ?? 0) * 60 * 1000;
  const msToLobby = webinar.scheduledStartAt - earlyEntryWindowMs - now;
  const countdown = formatCountdown(msToStart);

  const handleCopy = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(webinar.webinarLink).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <PageShell>
      <div className="flex w-full max-w-2xl flex-col items-center text-center animate-fade-in">
        <p className="text-sm text-[#FEFCD9]/40">you&apos;re a little early</p>

        <h1
          className="mt-3 text-3xl md:text-5xl text-[#FEFCD9] tracking-tight"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          {webinar.title}
        </h1>

        <p className="mt-4 text-sm md:text-base text-[#FEFCD9]/60">
          hosted by{" "}
          <span className="text-[#FEFCD9]/90">
            {webinar.hostName || "the organizer"}
          </span>{" "}
          - {formatStartString(webinar.scheduledStartAt)}
        </p>

        <div className="mt-12 flex flex-col items-center">
          <div
            className="text-6xl md:text-7xl text-[#FEFCD9] tracking-tight tabular-nums"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {countdown.primary}
          </div>
          <div className="mt-3 text-sm text-[#FEFCD9]/45">
            {countdown.suffix}
          </div>
          {webinar.earlyEntryMinutes > 0 && msToLobby > 0 ? (
            <div className="mt-2 text-xs text-[#FEFCD9]/35">
              the lobby opens {webinar.earlyEntryMinutes} minutes before we
              start
            </div>
          ) : null}
        </div>

        {webinar.description ? (
          <p className="mt-12 max-w-xl text-sm md:text-base text-[#FEFCD9]/70 whitespace-pre-line">
            {webinar.description}
          </p>
        ) : null}

        <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
          <a
            href={buildGoogleCalendarUrl(webinar)}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-lg bg-[#F95F4A] px-5 py-2.5 text-sm text-white transition-all hover:bg-[#e8553f] hover:gap-3"
          >
            <CalendarPlus className="h-4 w-4" />
            <span>Add to calendar</span>
          </a>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-2 rounded-lg border border-[#FEFCD9]/15 px-5 py-2.5 text-sm text-[#FEFCD9]/85 transition-all hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9]"
          >
            {copied ? (
              <Check className="h-4 w-4 text-[#F95F4A]" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            <span>{copied ? "Link copied" : "Copy the link"}</span>
          </button>
        </div>

        <div className="mt-20 flex flex-col items-center text-[#FEFCD9]/35">
          <ConclaveLockup size="md" />
          <p className="mt-3 text-xs text-[#FEFCD9]/30">
            video conferencing by ACM-VIT
          </p>
        </div>
      </div>
    </PageShell>
  );
}

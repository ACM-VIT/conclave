"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarPlus, Check, Copy } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import MeetsClientPage from "../../meets-client-page";

const GUEST_USER_STORAGE_KEY = "conclave:guest-user";
const MAX_ATTENDEE_NAME_LENGTH = 60;

/** The stored guest name, or null when the viewer has never introduced themselves. */
const readStoredGuestName = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GUEST_USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown };
    if (typeof parsed?.id !== "string" || !parsed.id.startsWith("guest-")) {
      return null;
    }
    return typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : null;
  } catch {
    return null;
  }
};

const storeGuestName = (name: string): void => {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(GUEST_USER_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { id?: unknown }) : null;
    const id =
      parsed && typeof parsed.id === "string" && parsed.id.startsWith("guest-")
        ? parsed.id
        : `guest-${crypto.randomUUID()}`;
    window.localStorage.setItem(
      GUEST_USER_STORAGE_KEY,
      JSON.stringify({ id, name }),
    );
  } catch {
    // A blocked storage still lets them watch; they'll appear as "Guest".
  }
};

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
  if (ms <= 0) return { primary: "Starting", suffix: "now" };
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
      suffix: "until we start",
    };
  }
  return {
    primary: `${minutes}:${pad(seconds)}`,
    suffix: "until we start",
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
  <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
    <div className="animate-fade-in w-full max-w-lg">{children}</div>
  </main>
);

const StatusCard = ({ children }: { children: React.ReactNode }) => (
  <section className="rounded-2xl border border-white/10 bg-[#0e0e10] p-6 sm:p-8 text-center">
    {children}
  </section>
);

export default function WebinarLandingClient({
  webinarLinkCode,
  initialWebinar,
}: Props) {
  const [webinar, setWebinar] = useState<PublicScheduledWebinar | null>(
    initialWebinar,
  );
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const { data: authSession, isPending: isAuthSessionPending } = useSession();
  const [storedGuestName, setStoredGuestName] = useState<string | null>(null);
  const [isGuestNameReady, setIsGuestNameReady] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [isAttendeeReady, setIsAttendeeReady] = useState(false);

  useEffect(() => {
    setStoredGuestName(readStoredGuestName());
    setIsGuestNameReady(true);
  }, []);

  const needsAttendeeName =
    isGuestNameReady &&
    !isAuthSessionPending &&
    !authSession?.user &&
    !storedGuestName;

  const handleSubmitAttendeeName = (): void => {
    const name = nameDraft.trim().slice(0, MAX_ATTENDEE_NAME_LENGTH);
    if (!name) return;
    storeGuestName(name);
    setStoredGuestName(name);
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!webinar) return;
    if (webinar.status === "ended" || webinar.status === "cancelled") return;
    const refreshWebinar = async () => {
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
    };
    const interval = window.setInterval(() => {
      void refreshWebinar();
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

  // Guest session refetches become pending again on window focus. Once admitted,
  // keep the meeting mounted: unmounting it runs the socket/media cleanup.
  useEffect(() => {
    if (
      isOpen &&
      isGuestNameReady &&
      !isAuthSessionPending &&
      (authSession?.user || storedGuestName)
    ) {
      setIsAttendeeReady(true);
    }
  }, [authSession?.user, isAuthSessionPending, isGuestNameReady, isOpen, storedGuestName]);

  if (isOpen) {
    if (!isAttendeeReady && (!isGuestNameReady || isAuthSessionPending)) {
      return null;
    }
    if (!isAttendeeReady && needsAttendeeName) {
      return (
        <PageShell>
          <StatusCard>
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
              Live webinar
            </p>
            <h1
              className="mt-3 text-[22px] leading-tight text-[#fafafa]"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              {webinar?.title ?? "Join the audience"}
            </h1>
            <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
              Add your name so the host knows who&apos;s asking when you join
              the Q&amp;A.
            </p>
            <form
              className="mt-7 flex flex-col gap-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmitAttendeeName();
              }}
            >
              <input
                type="text"
                value={nameDraft}
                onChange={(event) =>
                  setNameDraft(
                    event.target.value.slice(0, MAX_ATTENDEE_NAME_LENGTH),
                  )
                }
                placeholder="Your name"
                autoFocus
                data-testid="webinar-attendee-name"
                className="h-12 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 text-[15px] text-[#fafafa] outline-none placeholder:text-[#fafafa]/35 focus:border-[#F95F4A]/50"
              />
              <button
                type="submit"
                disabled={!nameDraft.trim()}
                data-testid="webinar-attendee-name-submit"
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 enabled:hover:brightness-[1.05] disabled:opacity-40"
              >
                Start watching
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>
          </StatusCard>
        </PageShell>
      );
    }
    return (
      <MeetsClientPage
        initialRoomId={webinarLinkCode}
        forceJoinOnly={true}
        bypassMediaPermissions={true}
        sfuClientId={webinar?.clientId}
        joinMode="webinar_attendee"
        autoJoinOnMount={true}
        hideJoinUI={true}
        webinarTitle={webinar?.title}
      />
    );
  }

  // `isOpen` is always true when there's no webinar snapshot, so reaching here
  // guarantees `webinar` is present — this guard just restores that narrowing.
  if (!webinar) return null;

  if (webinar.status === "ended" || webinar.status === "cancelled") {
    const ended = webinar.status === "ended";
    return (
      <PageShell>
        <StatusCard>
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
            {ended ? "Webinar ended" : "Webinar cancelled"}
          </p>
          <h1
            className="mt-3 text-[22px] leading-tight text-[#fafafa]"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {webinar.title}
          </h1>
          <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
            {ended
              ? "Reach out to the organizer for a replay or about future sessions."
              : "The organizer cancelled this session. Reach out to them for an update."}
          </p>
        </StatusCard>
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
      <StatusCard>
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
          You&apos;re a little early
        </p>
        <h1
          className="mt-3 text-[22px] leading-tight text-[#fafafa]"
          style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
        >
          {webinar.title}
        </h1>
        <p className="mt-2 text-[13.5px] text-[#fafafa]/55">
          Hosted by{" "}
          <span className="text-[#fafafa]">
            {webinar.hostName || "the organizer"}
          </span>
          {" · "}
          {formatStartString(webinar.scheduledStartAt)}
        </p>

        <div className="mt-8">
          <p
            className="text-[44px] leading-none tabular-nums text-[#fafafa] sm:text-[52px]"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {countdown.primary}
          </p>
          <p className="mt-2 text-[13.5px] text-[#fafafa]/55">{countdown.suffix}</p>
          {webinar.earlyEntryMinutes > 0 && msToLobby > 0 ? (
            <p className="mt-2 text-[12.5px] text-[#fafafa]/45">
              The lobby opens {webinar.earlyEntryMinutes} minutes before we start.
            </p>
          ) : null}
        </div>

        {webinar.description ? (
          <p className="mt-8 text-left text-[13.5px] leading-relaxed text-[#fafafa]/55 whitespace-pre-line">
            {webinar.description}
          </p>
        ) : null}

        <div className="mt-8 flex flex-col gap-2.5">
          <a
            href={buildGoogleCalendarUrl(webinar)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05]"
          >
            <CalendarPlus className="h-4 w-4" />
            Add to calendar
          </a>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-[15px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.08]"
          >
            {copied ? (
              <Check className="h-4 w-4 text-[#F95F4A]" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied ? "Link copied" : "Copy the link"}
          </button>
        </div>
      </StatusCard>
    </PageShell>
  );
}

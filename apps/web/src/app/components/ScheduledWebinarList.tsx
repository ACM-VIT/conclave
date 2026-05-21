"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Copy,
  Download,
  Loader2,
  PlayCircle,
  RefreshCw,
  Trash2,
  Users,
  Video,
  XCircle,
} from "lucide-react";
import type { ScheduledWebinar } from "@/lib/scheduled-webinars";

const monoFontStyle = { fontFamily: "'PolySans Mono', monospace" };

const formatTimeRange = (webinar: ScheduledWebinar): string => {
  const start = new Date(webinar.scheduledStartAt);
  const end = new Date(webinar.scheduledEndAt);
  const sameDay = start.toDateString() === end.toDateString();
  const dateOpts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    weekday: "short",
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  if (sameDay) {
    return `${start.toLocaleDateString(undefined, dateOpts)} · ${start.toLocaleTimeString(undefined, timeOpts)} – ${end.toLocaleTimeString(undefined, timeOpts)}`;
  }
  return `${start.toLocaleString(undefined, { ...dateOpts, ...timeOpts })} – ${end.toLocaleString(undefined, { ...dateOpts, ...timeOpts })}`;
};

const formatRelative = (target: number, now: number): string => {
  const diff = target - now;
  if (Math.abs(diff) < 60_000) {
    return diff > 0 ? "in <1 min" : "just now";
  }
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) {
    return diff > 0 ? `in ${minutes} min` : `${-minutes} min ago`;
  }
  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) {
    return diff > 0 ? `in ${hours} hr` : `${-hours} hr ago`;
  }
  const days = Math.round(diff / 86_400_000);
  return diff > 0 ? `in ${days} day(s)` : `${-days} day(s) ago`;
};

const STATUS_TONE: Record<ScheduledWebinar["status"], string> = {
  scheduled: "border-[#FEFCD9]/15 text-[#FEFCD9]/65",
  live: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
  ended: "border-[#FEFCD9]/10 text-[#FEFCD9]/35",
  cancelled: "border-amber-300/30 bg-amber-300/5 text-amber-200/80",
};

const STATUS_LABEL: Record<ScheduledWebinar["status"], string> = {
  scheduled: "Scheduled",
  live: "Live",
  ended: "Ended",
  cancelled: "Cancelled",
};

const copyToClipboard = async (value: string): Promise<boolean> => {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

export type ScheduledWebinarListProps = {
  webinars: ScheduledWebinar[];
  isLoading?: boolean;
  onRefresh?: () => void;
  onChange?: (webinars: ScheduledWebinar[]) => void;
  emptyHint?: string;
  variant?: "panel" | "dashboard";
};

export default function ScheduledWebinarList({
  webinars,
  isLoading = false,
  onRefresh,
  onChange,
  emptyHint = "No webinars scheduled yet.",
  variant = "dashboard",
}: ScheduledWebinarListProps) {
  const [now, setNow] = useState(() => Date.now());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sorted = useMemo(() => {
    return [...webinars].sort((a, b) => {
      if (a.status === "live" && b.status !== "live") return -1;
      if (b.status === "live" && a.status !== "live") return 1;
      return a.scheduledStartAt - b.scheduledStartAt;
    });
  }, [webinars]);

  const updateWebinar = useCallback(
    (updated: ScheduledWebinar) => {
      if (!onChange) return;
      onChange(webinars.map((w) => (w.id === updated.id ? updated : w)));
    },
    [onChange, webinars],
  );

  const removeWebinar = useCallback(
    (id: string) => {
      if (!onChange) return;
      onChange(webinars.filter((w) => w.id !== id));
    },
    [onChange, webinars],
  );

  const performAction = useCallback(
    async (
      webinarId: string,
      kind: "start" | "end" | "cancel" | "delete",
    ): Promise<void> => {
      setPendingId(webinarId);
      setError(null);
      try {
        if (kind === "delete") {
          const response = await fetch(
            `/api/webinars/scheduled/${encodeURIComponent(webinarId)}`,
            { method: "DELETE" },
          );
          if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw new Error(
              data && typeof data === "object" && "error" in data
                ? String(
                    (data as { error?: string }).error || "Failed to delete",
                  )
                : "Failed to delete",
            );
          }
          removeWebinar(webinarId);
          return;
        }

        const response = await fetch(
          `/api/webinars/scheduled/${encodeURIComponent(webinarId)}?action=${kind}`,
          { method: "POST" },
        );
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(
            data && typeof data === "object" && "error" in data
              ? String((data as { error?: string }).error || "Action failed")
              : "Action failed",
          );
        }
        const data = (await response.json()) as {
          scheduledWebinar?: ScheduledWebinar;
        };
        if (data?.scheduledWebinar) {
          updateWebinar(data.scheduledWebinar);
        }
      } catch (err) {
        setError((err as Error).message || "Action failed");
      } finally {
        setPendingId(null);
      }
    },
    [removeWebinar, updateWebinar],
  );

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-6 text-[#FEFCD9]/50"
        style={monoFontStyle}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="text-xs uppercase tracking-[0.15em]">
          Loading webinars…
        </span>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[#FEFCD9]/10 bg-black/20 px-3 py-4 text-center">
        <p className="text-[11px] text-[#FEFCD9]/45" style={monoFontStyle}>
          {emptyHint}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p className="text-[11px] text-[#F95F4A]" style={monoFontStyle}>
          {error}
        </p>
      ) : null}

      {onRefresh && variant === "dashboard" ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2.5 py-1 text-[11px] text-[#FEFCD9]/65 transition hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
      ) : null}

      {sorted.map((webinar) => {
        const isLive = webinar.status === "live";
        const isEnded =
          webinar.status === "ended" || webinar.status === "cancelled";
        const isPending = pendingId === webinar.id;
        const hostJoinHref =
          `/${encodeURIComponent(webinar.roomId)}?host=1&clientId=${encodeURIComponent(webinar.clientId)}`;
        const attendeeHref = webinar.webinarLink || `/w/${webinar.linkSlug}`;
        return (
          <div
            key={webinar.id}
            className="rounded-lg border border-[#FEFCD9]/10 bg-black/35 p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.15em] ${STATUS_TONE[webinar.status]}`}
                    style={monoFontStyle}
                  >
                    {STATUS_LABEL[webinar.status]}
                  </span>
                  <span className="text-[10px] text-[#FEFCD9]/40">
                    {formatRelative(webinar.scheduledStartAt, now)}
                  </span>
                </div>
                <h3 className="mt-1.5 truncate text-sm font-medium text-[#FEFCD9]">
                  {webinar.title}
                </h3>
                <p
                  className="mt-0.5 text-[11px] text-[#FEFCD9]/50"
                  style={monoFontStyle}
                >
                  <CalendarDays className="mr-1 inline h-3 w-3 align-text-bottom" />
                  {formatTimeRange(webinar)}
                </p>
                {webinar.description ? (
                  <p className="mt-1 line-clamp-2 text-[11px] text-[#FEFCD9]/55">
                    {webinar.description}
                  </p>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#FEFCD9]/40">
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {webinar.peakAttendeeCount} peak ·{" "}
                    {webinar.totalJoinCount} joins · cap{" "}
                    {webinar.maxAttendees}
                  </span>
                  {webinar.coHosts.length > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      {webinar.coHosts.length} co-host
                      {webinar.coHosts.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {webinar.requiresInviteCode ? (
                    <span className="inline-flex items-center gap-1">
                      invite-code required
                    </span>
                  ) : null}
                  {!webinar.publicAccess ? (
                    <span className="inline-flex items-center gap-1">
                      private link
                    </span>
                  ) : null}
                  {webinar.qaEnabled ? (
                    <span className="inline-flex items-center gap-1">
                      Q&amp;A
                    </span>
                  ) : null}
                  {webinar.waitingRoomEnabled ? (
                    <span className="inline-flex items-center gap-1">
                      waiting room
                    </span>
                  ) : null}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <a
                    href={attendeeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2 py-1 text-[10px] text-[#FEFCD9]/70 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
                    style={monoFontStyle}
                  >
                    {webinar.webinarLink}
                  </a>
                  <button
                    type="button"
                    onClick={() =>
                      void copyToClipboard(webinar.webinarLink).then(() =>
                        setError(null),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2 py-1 text-[10px] text-[#FEFCD9]/55 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
                    title="Copy link"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  <a
                    href={`/api/webinars/scheduled/${encodeURIComponent(webinar.id)}/ics`}
                    className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2 py-1 text-[10px] text-[#FEFCD9]/55 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
                    title="Download .ics"
                  >
                    <Download className="h-3 w-3" /> .ics
                  </a>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1">
                {!isEnded ? (
                  <a
                    href={hostJoinHref}
                    className="inline-flex items-center gap-1 rounded-md border border-[#F95F4A]/40 bg-[#F95F4A]/15 px-2.5 py-1 text-[11px] text-[#F95F4A] transition hover:border-[#F95F4A]/60 hover:bg-[#F95F4A]/25"
                  >
                    <Video className="h-3 w-3" />
                    {isLive ? "Rejoin as host" : "Start as host"}
                  </a>
                ) : null}
                {!isEnded && !isLive ? (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void performAction(webinar.id, "start")}
                    className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2.5 py-1 text-[10px] text-[#FEFCD9]/75 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9] disabled:opacity-40"
                  >
                    <PlayCircle className="h-3 w-3" /> Mark live
                  </button>
                ) : null}
                {isLive ? (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void performAction(webinar.id, "end")}
                    className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2.5 py-1 text-[10px] text-[#FEFCD9]/75 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9] disabled:opacity-40"
                  >
                    <XCircle className="h-3 w-3" /> End now
                  </button>
                ) : null}
                {!isEnded ? (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void performAction(webinar.id, "cancel")}
                    className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2.5 py-1 text-[10px] text-[#FEFCD9]/55 hover:border-amber-300/40 hover:text-amber-200 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => void performAction(webinar.id, "delete")}
                  className="inline-flex items-center gap-1 rounded-md border border-[#FEFCD9]/10 px-2.5 py-1 text-[10px] text-[#FEFCD9]/45 hover:border-[#F95F4A]/40 hover:text-[#F95F4A] disabled:opacity-40"
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

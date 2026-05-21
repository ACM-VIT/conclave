"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  Copy,
  Download,
  Lock,
  Loader2,
  MoreHorizontal,
  PlayCircle,
  ShieldCheck,
  Trash2,
  Users,
  Video,
  XCircle,
} from "lucide-react";
import type { ScheduledWebinar } from "@/lib/scheduled-webinars";

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
    return diff > 0 ? "in less than a minute" : "just now";
  }
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) {
    return diff > 0
      ? `in ${minutes} minute${minutes === 1 ? "" : "s"}`
      : `${-minutes} minute${minutes === -1 ? "" : "s"} ago`;
  }
  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 24) {
    return diff > 0
      ? `in ${hours} hour${hours === 1 ? "" : "s"}`
      : `${-hours} hour${hours === -1 ? "" : "s"} ago`;
  }
  const days = Math.round(diff / 86_400_000);
  return diff > 0
    ? `in ${days} day${days === 1 ? "" : "s"}`
    : `${-days} day${days === -1 ? "" : "s"} ago`;
};

const STATUS_TONE: Record<ScheduledWebinar["status"], string> = {
  scheduled: "bg-[#FEFCD9]/10 text-[#FEFCD9]/70",
  live: "bg-[#F95F4A]/15 text-[#F95F4A]",
  ended: "bg-[#FEFCD9]/5 text-[#FEFCD9]/40",
  cancelled: "bg-amber-300/10 text-amber-200/85",
};

const STATUS_LABEL: Record<ScheduledWebinar["status"], string> = {
  scheduled: "Scheduled",
  live: "Live now",
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

const stripScheme = (url: string): string => url.replace(/^https?:\/\//, "");

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
  onChange,
  emptyHint = "No webinars scheduled yet.",
}: ScheduledWebinarListProps) {
  const [now, setNow] = useState(() => Date.now());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [pendingCoHostInviteId, setPendingCoHostInviteId] = useState<
    string | null
  >(null);
  const [copiedCoHostInviteId, setCopiedCoHostInviteId] = useState<
    string | null
  >(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!openMenuId) return;
    const onDown = () => setOpenMenuId(null);
    document.addEventListener("click", onDown);
    return () => document.removeEventListener("click", onDown);
  }, [openMenuId]);

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
      setOpenMenuId(null);
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

  const copyLink = useCallback(async (webinar: ScheduledWebinar) => {
    const ok = await copyToClipboard(webinar.webinarLink);
    if (ok) {
      setCopiedLinkId(webinar.id);
      window.setTimeout(() => {
        setCopiedLinkId((current) =>
          current === webinar.id ? null : current,
        );
      }, 1800);
    }
  }, []);

  const copyCoHostInvite = useCallback(async (webinarId: string) => {
    setPendingCoHostInviteId(webinarId);
    setCopiedCoHostInviteId(null);
    setError(null);
    try {
      const response = await fetch(
        `/api/webinars/scheduled/${encodeURIComponent(webinarId)}/cohost-invite`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: string }).error || "Invite failed")
            : "Invite failed",
        );
      }
      const link =
        data && typeof data === "object" && "coHostInviteLink" in data
          ? String(
              (data as { coHostInviteLink?: string }).coHostInviteLink || "",
            )
          : "";
      if (!link) throw new Error("Co-host invite link was not returned.");
      const copied = await copyToClipboard(link);
      if (!copied) {
        throw new Error("Copy failed. Browser clipboard access is blocked.");
      }
      setCopiedCoHostInviteId(webinarId);
      window.setTimeout(() => {
        setCopiedCoHostInviteId((current) =>
          current === webinarId ? null : current,
        );
      }, 1800);
    } catch (err) {
      setError((err as Error).message || "Failed to create co-host invite");
    } finally {
      setPendingCoHostInviteId(null);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 py-8 text-sm text-[#FEFCD9]/45">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading your webinars…</span>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[#FEFCD9]/15 bg-black/15 px-6 py-10 text-center">
        <p className="text-sm text-[#FEFCD9]/55">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/5 px-4 py-2.5 text-sm text-[#F95F4A]">
          {error}
        </div>
      )}

      {sorted.map((webinar) => {
        const isLive = webinar.status === "live";
        const isEnded =
          webinar.status === "ended" || webinar.status === "cancelled";
        const isPending = pendingId === webinar.id;
        const isCoHostInvitePending = pendingCoHostInviteId === webinar.id;
        const isCoHostInviteCopied = copiedCoHostInviteId === webinar.id;
        const isLinkCopied = copiedLinkId === webinar.id;
        const hostJoinHref = `/${encodeURIComponent(webinar.roomId)}?host=1&clientId=${encodeURIComponent(webinar.clientId)}`;
        const attendeeHref = webinar.webinarLink || `/w/${webinar.linkSlug}`;
        const isMenuOpen = openMenuId === webinar.id;

        return (
          <article
            key={webinar.id}
            className={`relative rounded-2xl border bg-black/30 p-5 transition-colors ${
              isLive
                ? "border-[#F95F4A]/35"
                : "border-[#FEFCD9]/10 hover:border-[#FEFCD9]/20"
            }`}
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${STATUS_TONE[webinar.status]}`}
                  >
                    {isLive && (
                      <span className="block h-1.5 w-1.5 rounded-full bg-[#F95F4A] animate-pulse" />
                    )}
                    {STATUS_LABEL[webinar.status]}
                  </span>
                  <span className="text-xs text-[#FEFCD9]/40">
                    {formatRelative(webinar.scheduledStartAt, now)}
                  </span>
                </div>

                <h3
                  className="mt-3 text-xl md:text-2xl text-[#FEFCD9] tracking-tight"
                  style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
                >
                  {webinar.title}
                </h3>

                <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm text-[#FEFCD9]/55">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {formatTimeRange(webinar)}
                </p>

                {webinar.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-[#FEFCD9]/60">
                    {webinar.description}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#FEFCD9]/40">
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    {webinar.peakAttendeeCount > 0
                      ? `${webinar.peakAttendeeCount} peak · ${webinar.totalJoinCount} joined`
                      : `cap ${webinar.maxAttendees}`}
                  </span>
                  {webinar.coHosts.length > 0 && (
                    <span>
                      {webinar.coHosts.length} co-host
                      {webinar.coHosts.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {webinar.requiresInviteCode && (
                    <span className="inline-flex items-center gap-1">
                      <Lock className="h-3 w-3" />
                      invite code
                    </span>
                  )}
                  {!webinar.publicAccess && (
                    <span>private link</span>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <div className="inline-flex items-center gap-0.5 rounded-lg border border-[#FEFCD9]/10 bg-black/30">
                    <a
                      href={attendeeHref}
                      target="_blank"
                      rel="noreferrer"
                      className="max-w-[260px] truncate px-3 py-1.5 text-sm text-[#FEFCD9]/70 hover:text-[#FEFCD9]"
                      title={webinar.webinarLink}
                    >
                      {stripScheme(webinar.webinarLink)}
                    </a>
                    <button
                      type="button"
                      onClick={() => void copyLink(webinar)}
                      className="inline-flex items-center gap-1 border-l border-[#FEFCD9]/10 px-2.5 py-1.5 text-sm text-[#FEFCD9]/55 hover:text-[#FEFCD9]"
                      title="Copy public link"
                    >
                      {isLinkCopied ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-[#F95F4A]" />
                          <span className="text-xs text-[#F95F4A]">Copied</span>
                        </>
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>

                  <a
                    href={`/api/webinars/scheduled/${encodeURIComponent(webinar.id)}/ics`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#FEFCD9]/10 px-3 py-1.5 text-sm text-[#FEFCD9]/65 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9]"
                    title="Download calendar invite"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Calendar
                  </a>

                  {!isEnded && (
                    <button
                      type="button"
                      disabled={isCoHostInvitePending}
                      onClick={() => void copyCoHostInvite(webinar.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#FEFCD9]/10 px-3 py-1.5 text-sm text-[#FEFCD9]/65 hover:border-[#FEFCD9]/25 hover:text-[#FEFCD9] disabled:opacity-40"
                      title="Generate a co-host invite link"
                    >
                      {isCoHostInvitePending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isCoHostInviteCopied ? (
                        <Check className="h-3.5 w-3.5 text-[#F95F4A]" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5" />
                      )}
                      {isCoHostInviteCopied ? "Co-host link copied" : "Co-host link"}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-stretch gap-2 md:items-end md:w-44 shrink-0">
                {!isEnded ? (
                  <a
                    href={hostJoinHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#F95F4A] px-4 py-2 text-sm text-white transition-all hover:bg-[#e8553f]"
                  >
                    <Video className="h-4 w-4" />
                    <span>{isLive ? "Rejoin as host" : "Open room"}</span>
                  </a>
                ) : null}

                {!isEnded && !isLive && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void performAction(webinar.id, "start")}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#FEFCD9]/15 px-4 py-2 text-sm text-[#FEFCD9]/75 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:opacity-40"
                  >
                    <PlayCircle className="h-4 w-4" />
                    Mark live
                  </button>
                )}

                {isLive && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void performAction(webinar.id, "end")}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#FEFCD9]/15 px-4 py-2 text-sm text-[#FEFCD9]/75 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:opacity-40"
                  >
                    <XCircle className="h-4 w-4" />
                    End now
                  </button>
                )}

                <div
                  className="relative inline-flex justify-end md:justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setOpenMenuId((current) =>
                        current === webinar.id ? null : webinar.id,
                      )
                    }
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm text-[#FEFCD9]/45 hover:text-[#FEFCD9]/85"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {isMenuOpen && (
                    <div className="absolute right-0 top-full z-10 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-[#FEFCD9]/10 bg-[#0c0c0c] shadow-xl">
                      {!isEnded && (
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => void performAction(webinar.id, "cancel")}
                          className="block w-full px-3 py-2 text-left text-sm text-[#FEFCD9]/75 hover:bg-amber-300/10 hover:text-amber-200"
                        >
                          Cancel webinar
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          if (
                            !window.confirm(
                              "Delete this webinar? This cannot be undone.",
                            )
                          )
                            return;
                          void performAction(webinar.id, "delete");
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-[#FEFCD9]/75 hover:bg-[#F95F4A]/10 hover:text-[#F95F4A]"
                      >
                        <Trash2 className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" />
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

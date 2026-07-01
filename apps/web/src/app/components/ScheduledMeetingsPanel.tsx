"use client";

import {
  CalendarClock,
  Check,
  Copy,
  Loader2,
  PlayCircle,
  Plus,
  XCircle,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { ScheduledMeeting } from "@/lib/scheduled-meetings";
import { buildMeetingPath, buildMeetingUrl } from "@/lib/meeting-links";

type ScheduledMeetingsResponse = {
  scheduledMeetings?: ScheduledMeeting[];
  scheduledMeeting?: ScheduledMeeting;
  error?: string;
};

type ScheduledMeetingsPanelProps = {
  isSignedIn: boolean;
};

const INPUT =
  "w-full rounded-lg border border-white/10 bg-[#111114] px-3 py-2 text-[13px] text-[#fafafa] placeholder:text-[#fafafa]/30 outline-none transition-colors focus:border-[#F95F4A]";
const ACTION =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-[#18181b] px-3 py-2 text-[12px] font-medium text-[#fafafa]/80 transition-colors hover:bg-[#232327] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-50";

const getDefaultStartInput = (): string => {
  const date = new Date(Date.now() + 30 * 60 * 1000);
  date.setSeconds(0, 0);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
};

const readError = async (response: Response): Promise<string> => {
  const data = (await response.json().catch(() => null)) as
    | ScheduledMeetingsResponse
    | null;
  return data?.error || response.statusText || "Request failed";
};

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  live: "Live",
  ended: "Ended",
  cancelled: "Cancelled",
};

const formatTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function ScheduledMeetingsPanel({ isSignedIn }: ScheduledMeetingsPanelProps) {
  const [meetings, setMeetings] = useState<ScheduledMeeting[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<"upcoming" | "past">("upcoming");
  const [title, setTitle] = useState("");
  const [startInput, setStartInput] = useState(getDefaultStartInput);
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [roomCode, setRoomCode] = useState("");
  const [copiedMeetingId, setCopiedMeetingId] = useState<string | null>(null);
  const [workingMeetingId, setWorkingMeetingId] = useState<string | null>(null);

  const refreshMeetings = useCallback(async () => {
    if (!isSignedIn) {
      setMeetings([]);
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/meetings/scheduled", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const data = (await response.json()) as ScheduledMeetingsResponse;
      setMeetings(Array.isArray(data.scheduledMeetings) ? data.scheduledMeetings : []);
      setStatus("idle");
    } catch (loadError) {
      setError((loadError as Error).message || "Could not load meetings");
      setStatus("error");
    }
  }, [isSignedIn]);

  useEffect(() => {
    void refreshMeetings();
  }, [refreshMeetings]);

  const groupedMeetings = useMemo(() => {
    const now = Date.now();
    const upcoming: ScheduledMeeting[] = [];
    const past: ScheduledMeeting[] = [];
    for (const meeting of meetings) {
      const isPast =
        meeting.status === "ended" ||
        meeting.status === "cancelled" ||
        meeting.scheduledEndAt < now;
      if (isPast) {
        past.push(meeting);
      } else {
        upcoming.push(meeting);
      }
    }
    return {
      upcoming,
      past: past.sort((a, b) => b.scheduledStartAt - a.scheduledStartAt),
    };
  }, [meetings]);

  const visibleMeetings =
    activeTab === "upcoming" ? groupedMeetings.upcoming : groupedMeetings.past;

  const createMeeting = useCallback(async () => {
    if (isCreating) return;
    const startAt = new Date(startInput).getTime();
    const duration = Number.parseInt(durationMinutes, 10);
    if (!title.trim()) {
      setError("Add a meeting title.");
      return;
    }
    if (!Number.isFinite(startAt)) {
      setError("Choose a valid start time.");
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/meetings/scheduled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          scheduledStartAt: startAt,
          scheduledEndAt: startAt + Math.max(duration || 60, 15) * 60 * 1000,
          ...(roomCode.trim() ? { roomCode: roomCode.trim() } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const data = (await response.json()) as ScheduledMeetingsResponse;
      if (data.scheduledMeeting) {
        setMeetings((current) =>
          [...current, data.scheduledMeeting as ScheduledMeeting].sort(
            (a, b) => a.scheduledStartAt - b.scheduledStartAt,
          ),
        );
      } else {
        await refreshMeetings();
      }
      setTitle("");
      setStartInput(getDefaultStartInput());
      setDurationMinutes("60");
      setRoomCode("");
      setActiveTab("upcoming");
    } catch (createError) {
      setError((createError as Error).message || "Could not schedule meeting");
    } finally {
      setIsCreating(false);
    }
  }, [
    durationMinutes,
    isCreating,
    refreshMeetings,
    roomCode,
    startInput,
    title,
  ]);

  const startMeeting = useCallback(async (meeting: ScheduledMeeting) => {
    if (workingMeetingId) return;
    setWorkingMeetingId(meeting.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/meetings/scheduled/${encodeURIComponent(meeting.id)}/start`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      window.location.href = buildMeetingPath(meeting);
    } catch (startError) {
      setError((startError as Error).message || "Could not start meeting");
      setWorkingMeetingId(null);
    }
  }, [workingMeetingId]);

  const cancelMeeting = useCallback(async (meeting: ScheduledMeeting) => {
    if (workingMeetingId) return;
    setWorkingMeetingId(meeting.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/meetings/scheduled/${encodeURIComponent(meeting.id)}/cancel`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const data = (await response.json()) as ScheduledMeetingsResponse;
      if (data.scheduledMeeting) {
        setMeetings((current) =>
          current.map((entry) =>
            entry.id === data.scheduledMeeting?.id
              ? data.scheduledMeeting
              : entry,
          ),
        );
      } else {
        await refreshMeetings();
      }
    } catch (cancelError) {
      setError((cancelError as Error).message || "Could not cancel meeting");
    } finally {
      setWorkingMeetingId(null);
    }
  }, [refreshMeetings, workingMeetingId]);

  const copyMeetingLink = useCallback(async (meeting: ScheduledMeeting) => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(
        buildMeetingUrl(window.location.origin, meeting),
      );
      setCopiedMeetingId(meeting.id);
      setTimeout(() => setCopiedMeetingId(null), 1600);
    } catch {
      setCopiedMeetingId(null);
    }
  }, []);

  if (!isSignedIn) return null;

  return (
    <section className="rounded-xl border border-white/10 bg-[#151518] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-medium text-[#fafafa]">
            Your meetings
          </h2>
          <p className="mt-0.5 text-[12px] text-[#fafafa]/60">
            Schedule rooms and reopen them anytime.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshMeetings()}
          disabled={status === "loading"}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-[#fafafa]/60 transition-colors hover:bg-white/5 hover:text-[#fafafa] disabled:opacity-50"
        >
          {status === "loading" ? "Loading" : "Refresh"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Meeting title"
          className={`${INPUT} col-span-2`}
        />
        <input
          type="datetime-local"
          value={startInput}
          onChange={(event) => setStartInput(event.target.value)}
          className={INPUT}
        />
        <select
          value={durationMinutes}
          onChange={(event) => setDurationMinutes(event.target.value)}
          className={INPUT}
        >
          <option value="30">30 min</option>
          <option value="45">45 min</option>
          <option value="60">60 min</option>
          <option value="90">90 min</option>
        </select>
        <input
          value={roomCode}
          onChange={(event) => setRoomCode(event.target.value)}
          placeholder="Custom code (optional)"
          className={`${INPUT} col-span-2`}
        />
        <button
          type="button"
          onClick={() => void createMeeting()}
          disabled={isCreating}
          className="col-span-2 inline-flex items-center justify-center gap-2 rounded-lg bg-[#F95F4A] px-3 py-2.5 text-[13px] font-medium text-white transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isCreating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Schedule meeting
        </button>
      </div>

      <div className="mt-4 flex rounded-lg border border-white/10 bg-[#101013] p-1">
        {(["upcoming", "past"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-md px-3 py-1.5 text-[12px] capitalize transition-colors ${
              activeTab === tab
                ? "bg-[#232327] text-[#fafafa]"
                : "text-[#fafafa]/45 hover:text-[#fafafa]"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="mt-3 max-h-[260px] space-y-2 overflow-y-auto pr-1">
        {visibleMeetings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 px-3 py-5 text-center">
            <CalendarClock className="mx-auto h-5 w-5 text-[#fafafa]/35" />
            <p className="mt-2 text-[12px] text-[#fafafa]/45">
              {activeTab === "upcoming"
                ? "No upcoming meetings yet."
                : "Past meetings will show up here."}
            </p>
          </div>
        ) : (
          visibleMeetings.map((meeting) => {
            const isWorking = workingMeetingId === meeting.id;
            const isLive = meeting.status === "live" || meeting.startedAt !== null;
            const isCancelled = meeting.status === "cancelled";
            return (
              <article
                key={meeting.id}
                className="rounded-lg border border-white/10 bg-[#101013] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[13px] font-medium text-[#fafafa]">
                      {meeting.title}
                    </h3>
                    <p className="mt-1 truncate text-[12px] text-[#fafafa]/45">
                      {formatTime(meeting.scheduledStartAt)} · {meeting.roomCode}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                      isLive
                        ? "bg-[#2BA84A]/15 text-[#6FE28A]"
                        : isCancelled
                          ? "bg-white/5 text-[#fafafa]/40"
                          : "bg-[#F95F4A]/15 text-[#ff9a8c]"
                    }`}
                  >
                    {STATUS_LABELS[meeting.status] ?? meeting.status}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!isCancelled && (
                    <a href={buildMeetingPath(meeting)} className={ACTION}>
                      {isLive ? "Join" : "Open"}
                    </a>
                  )}
                  {!isCancelled && meeting.status !== "ended" && (
                    <button
                      type="button"
                      onClick={() => void startMeeting(meeting)}
                      disabled={isWorking || Boolean(workingMeetingId)}
                      className={ACTION}
                    >
                      {isWorking ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <PlayCircle className="h-3.5 w-3.5" />
                      )}
                      Start
                    </button>
                  )}
                  {!isCancelled && (
                    <button
                      type="button"
                      onClick={() => void copyMeetingLink(meeting)}
                      className={ACTION}
                    >
                      {copiedMeetingId === meeting.id ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      Copy
                    </button>
                  )}
                  {meeting.status === "scheduled" && (
                    <button
                      type="button"
                      onClick={() => void cancelMeeting(meeting)}
                      disabled={isWorking || Boolean(workingMeetingId)}
                      className={ACTION}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>

      {error ? <p className="mt-3 text-[12px] text-[#F95F4A]">{error}</p> : null}
    </section>
  );
}

export default memo(ScheduledMeetingsPanel);

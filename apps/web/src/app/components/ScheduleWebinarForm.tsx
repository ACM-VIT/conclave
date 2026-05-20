"use client";

import { useCallback, useMemo, useState } from "react";
import { CalendarPlus, Loader2 } from "lucide-react";
import type {
  CreateScheduledWebinarPayload,
  ScheduledWebinar,
  ScheduledWebinarCoHost,
} from "@/lib/scheduled-webinars";

const monoFontStyle = { fontFamily: "'PolySans Mono', monospace" };
const inputClass =
  "w-full rounded-md border border-[#FEFCD9]/10 bg-black/40 px-3 py-1.5 text-xs text-[#FEFCD9] outline-none placeholder:text-[#FEFCD9]/30 focus:border-[#FEFCD9]/25";
const labelClass =
  "block text-[10px] uppercase tracking-[0.14em] text-[#FEFCD9]/45";
const actionButtonClass =
  "inline-flex items-center justify-center gap-1 rounded-md border border-[#FEFCD9]/10 px-3 py-1.5 text-[11px] text-[#FEFCD9]/85 transition hover:border-[#FEFCD9]/25 hover:bg-[#FEFCD9]/10 disabled:cursor-not-allowed disabled:opacity-40";
const primaryButtonClass =
  "inline-flex items-center justify-center gap-1 rounded-md border border-[#F95F4A]/40 bg-[#F95F4A]/15 px-3 py-1.5 text-[11px] text-[#F95F4A] transition hover:border-[#F95F4A]/60 hover:bg-[#F95F4A]/25 disabled:cursor-not-allowed disabled:opacity-40";

const pad = (n: number): string => String(n).padStart(2, "0");

const toLocalInputValue = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

const nextRoundedHour = (): Date => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
};

const parseLocalDateTime = (value: string): number => {
  if (!value) return Number.NaN;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
};

const parseCoHostList = (raw: string): ScheduledWebinarCoHost[] => {
  return raw
    .split(/[,\s\n]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.includes("@"))
    .map((email) => ({ email }));
};

const DURATION_OPTIONS = [
  { label: "30 min", minutes: 30 },
  { label: "45 min", minutes: 45 },
  { label: "60 min", minutes: 60 },
  { label: "90 min", minutes: 90 },
  { label: "2 hr", minutes: 120 },
];

export type ScheduleWebinarFormProps = {
  defaultHostEmail?: string;
  defaultHostName?: string;
  compact?: boolean;
  onScheduled?: (webinar: ScheduledWebinar) => void;
};

export default function ScheduleWebinarForm({
  defaultHostEmail,
  defaultHostName,
  compact = false,
  onScheduled,
}: ScheduleWebinarFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const initialStart = useMemo(() => nextRoundedHour(), []);
  const [startAt, setStartAt] = useState<string>(
    toLocalInputValue(initialStart),
  );
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [coHosts, setCoHosts] = useState("");
  const [linkSlug, setLinkSlug] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [publicAccess, setPublicAccess] = useState(true);
  const [waitingRoomEnabled, setWaitingRoomEnabled] = useState(true);
  const [qaEnabled, setQaEnabled] = useState(true);
  const [recordingRequested, setRecordingRequested] = useState(false);
  const [earlyEntryMinutes, setEarlyEntryMinutes] = useState(10);
  const [maxAttendees, setMaxAttendees] = useState(500);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      const startMs = parseLocalDateTime(startAt);
      if (!title.trim()) {
        setError("Add a title.");
        return;
      }
      if (!Number.isFinite(startMs)) {
        setError("Pick a valid start time.");
        return;
      }
      if (startMs < Date.now() - 60_000) {
        setError("Start time must be in the future.");
        return;
      }
      const payload: CreateScheduledWebinarPayload = {
        title: title.trim(),
        description: description.trim() || undefined,
        scheduledStartAt: startMs,
        scheduledEndAt: startMs + durationMinutes * 60 * 1000,
        hostEmail: defaultHostEmail,
        hostName: defaultHostName,
        coHosts: parseCoHostList(coHosts),
        linkSlug: linkSlug.trim() || undefined,
        publicAccess,
        maxAttendees,
        inviteCode: inviteCode.trim() || null,
        waitingRoomEnabled,
        earlyEntryMinutes,
        qaEnabled,
        recordingRequested,
      };
      setIsWorking(true);
      try {
        const response = await fetch("/api/webinars/scheduled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(
            data && typeof data === "object" && "error" in data
              ? String((data as { error?: string }).error || "Failed to schedule")
              : "Failed to schedule",
          );
        }
        const data = (await response.json()) as {
          scheduledWebinar?: ScheduledWebinar;
        };
        if (data?.scheduledWebinar) {
          setTitle("");
          setDescription("");
          setCoHosts("");
          setLinkSlug("");
          setInviteCode("");
          onScheduled?.(data.scheduledWebinar);
        }
      } catch (err) {
        setError((err as Error).message || "Failed to schedule webinar");
      } finally {
        setIsWorking(false);
      }
    },
    [
      title,
      description,
      startAt,
      durationMinutes,
      defaultHostEmail,
      defaultHostName,
      coHosts,
      linkSlug,
      inviteCode,
      publicAccess,
      maxAttendees,
      waitingRoomEnabled,
      earlyEntryMinutes,
      qaEnabled,
      recordingRequested,
      onScheduled,
    ],
  );

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2.5"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div>
        <label className={labelClass} style={monoFontStyle}>
          Title
        </label>
        <input
          type="text"
          className={inputClass}
          value={title}
          maxLength={140}
          placeholder="e.g. Q2 product launch"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      {!compact && (
        <div>
          <label className={labelClass} style={monoFontStyle}>
            Description
          </label>
          <textarea
            className={`${inputClass} resize-none`}
            rows={2}
            value={description}
            maxLength={2000}
            placeholder="Short summary shown on the landing page"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass} style={monoFontStyle}>
            Start
          </label>
          <input
            type="datetime-local"
            className={inputClass}
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} style={monoFontStyle}>
            Duration
          </label>
          <select
            className={inputClass}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(Number(e.target.value))}
          >
            {DURATION_OPTIONS.map((option) => (
              <option key={option.minutes} value={option.minutes}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!compact && (
        <div>
          <label className={labelClass} style={monoFontStyle}>
            Co-hosts (comma-separated emails)
          </label>
          <input
            type="text"
            className={inputClass}
            value={coHosts}
            placeholder="alex@example.com, jordan@example.com"
            onChange={(e) => setCoHosts(e.target.value)}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass} style={monoFontStyle}>
            Link code
          </label>
          <input
            type="text"
            className={inputClass}
            value={linkSlug}
            placeholder="optional"
            onChange={(e) =>
              setLinkSlug(
                e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
              )
            }
          />
        </div>
        <div>
          <label className={labelClass} style={monoFontStyle}>
            Max attendees
          </label>
          <input
            type="number"
            min={1}
            max={5000}
            className={inputClass}
            value={maxAttendees}
            onChange={(e) => setMaxAttendees(Number(e.target.value) || 500)}
          />
        </div>
      </div>

      {!compact && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass} style={monoFontStyle}>
              Invite code (optional)
            </label>
            <input
              type="text"
              className={inputClass}
              value={inviteCode}
              placeholder="leave empty for none"
              onChange={(e) => setInviteCode(e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} style={monoFontStyle}>
              Open lobby (min before)
            </label>
            <input
              type="number"
              min={0}
              max={240}
              className={inputClass}
              value={earlyEntryMinutes}
              onChange={(e) =>
                setEarlyEntryMinutes(Math.max(0, Number(e.target.value) || 0))
              }
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-[#FEFCD9]/80">
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            className="accent-[#F95F4A]"
            checked={publicAccess}
            onChange={(e) => setPublicAccess(e.target.checked)}
          />
          Public link
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            className="accent-[#F95F4A]"
            checked={waitingRoomEnabled}
            onChange={(e) => setWaitingRoomEnabled(e.target.checked)}
          />
          Waiting room
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            className="accent-[#F95F4A]"
            checked={qaEnabled}
            onChange={(e) => setQaEnabled(e.target.checked)}
          />
          Q&amp;A enabled
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            className="accent-[#F95F4A]"
            checked={recordingRequested}
            onChange={(e) => setRecordingRequested(e.target.checked)}
          />
          Request recording
        </label>
      </div>

      {error ? (
        <p className="text-[11px] text-[#F95F4A]">{error}</p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={isWorking}
          className={primaryButtonClass}
        >
          {isWorking ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <CalendarPlus className="h-3 w-3" />
          )}
          {isWorking ? "Scheduling…" : "Schedule webinar"}
        </button>
      </div>
    </form>
  );
}

export { actionButtonClass as scheduledWebinarSecondaryButtonClass };

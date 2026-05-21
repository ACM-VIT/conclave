"use client";

import { useCallback, useMemo, useState } from "react";
import { CalendarPlus, Loader2 } from "lucide-react";
import type {
  CreateScheduledWebinarPayload,
  ScheduledWebinar,
  ScheduledWebinarCoHost,
} from "@/lib/scheduled-webinars";

const inputClass =
  "w-full rounded-lg border border-[#FEFCD9]/15 bg-black/30 px-4 py-2.5 text-sm text-[#FEFCD9] outline-none placeholder:text-[#FEFCD9]/30 transition-colors focus:border-[#FEFCD9]/35";
const labelClass = "block text-sm text-[#FEFCD9]/65 mb-1.5";
const helperClass = "mt-1 text-xs text-[#FEFCD9]/35";

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
  { label: "30 minutes", minutes: 30 },
  { label: "45 minutes", minutes: 45 },
  { label: "1 hour", minutes: 60 },
  { label: "1.5 hours", minutes: 90 },
  { label: "2 hours", minutes: 120 },
];

export type ScheduleWebinarFormProps = {
  defaultHostEmail?: string;
  defaultHostName?: string;
  compact?: boolean;
  onScheduled?: (webinar: ScheduledWebinar) => void;
};

type Toggle = {
  key: "publicAccess" | "waitingRoomEnabled" | "qaEnabled" | "recordingRequested";
  label: string;
  description: string;
};

type FieldProps = {
  children: React.ReactNode;
  span?: 1 | 2;
};

function Field({ children, span = 1 }: FieldProps) {
  return <div className={span === 2 ? "md:col-span-2" : ""}>{children}</div>;
}

const TOGGLES: Toggle[] = [
  {
    key: "publicAccess",
    label: "Public link",
    description: "Anyone with the link can join.",
  },
  {
    key: "waitingRoomEnabled",
    label: "Waiting room",
    description: "Attendees wait until you start.",
  },
  {
    key: "qaEnabled",
    label: "Q&A",
    description: "Audience can submit questions.",
  },
  {
    key: "recordingRequested",
    label: "Record automatically",
    description: "Start recording when the room opens.",
  },
];

export default function ScheduleWebinarForm({
  defaultHostEmail,
  defaultHostName,
  compact = false,
  onScheduled,
}: ScheduleWebinarFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const initialStart = useMemo(() => nextRoundedHour(), []);
  const [startAt, setStartAt] = useState<string>(toLocalInputValue(initialStart));
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [coHosts, setCoHosts] = useState("");
  const [linkSlug, setLinkSlug] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [toggles, setToggles] = useState({
    publicAccess: true,
    waitingRoomEnabled: true,
    qaEnabled: true,
    recordingRequested: false,
  });
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
        setError("Add a title for the webinar.");
        return;
      }
      if (!Number.isFinite(startMs)) {
        setError("Pick a valid start time.");
        return;
      }
      if (startMs < Date.now() - 60_000) {
        setError("The start time has to be in the future.");
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
        publicAccess: toggles.publicAccess,
        maxAttendees,
        inviteCode: inviteCode.trim() || null,
        waitingRoomEnabled: toggles.waitingRoomEnabled,
        earlyEntryMinutes,
        qaEnabled: toggles.qaEnabled,
        recordingRequested: toggles.recordingRequested,
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
              ? String(
                  (data as { error?: string }).error || "Failed to schedule",
                )
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
      toggles,
      maxAttendees,
      earlyEntryMinutes,
      onScheduled,
    ],
  );

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <Field span={2}>
        <label htmlFor="webinar-title" className={labelClass}>
          Title
        </label>
        <input
          id="webinar-title"
          type="text"
          className={inputClass}
          value={title}
          maxLength={140}
          placeholder="e.g. Q2 product launch"
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>

      {!compact && (
        <Field span={2}>
          <label htmlFor="webinar-desc" className={labelClass}>
            Description
          </label>
          <textarea
            id="webinar-desc"
            className={`${inputClass} resize-none`}
            rows={3}
            value={description}
            maxLength={2000}
            placeholder="A short summary that attendees see on the waiting page."
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field>
          <label htmlFor="webinar-start" className={labelClass}>
            Starts at
          </label>
          <input
            id="webinar-start"
            type="datetime-local"
            className={inputClass}
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </Field>
        <Field>
          <label htmlFor="webinar-duration" className={labelClass}>
            Duration
          </label>
          <select
            id="webinar-duration"
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
        </Field>
      </div>

      {!compact && (
        <Field span={2}>
          <label htmlFor="webinar-cohosts" className={labelClass}>
            Co-hosts
          </label>
          <input
            id="webinar-cohosts"
            type="text"
            className={inputClass}
            value={coHosts}
            placeholder="alex@example.com, jordan@example.com"
            onChange={(e) => setCoHosts(e.target.value)}
          />
          <p className={helperClass}>
            Comma-separated emails. Co-hosts are auto-promoted when they
            join.
          </p>
        </Field>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field>
          <label htmlFor="webinar-slug" className={labelClass}>
            Custom link
          </label>
          <div className="flex items-stretch rounded-lg border border-[#FEFCD9]/15 bg-black/30 transition-colors focus-within:border-[#FEFCD9]/35">
            <span className="flex items-center px-3 text-sm text-[#FEFCD9]/35 select-none">
              /w/
            </span>
            <input
              id="webinar-slug"
              type="text"
              className="flex-1 bg-transparent px-1 py-2.5 text-sm text-[#FEFCD9] outline-none placeholder:text-[#FEFCD9]/30"
              value={linkSlug}
              placeholder="optional"
              onChange={(e) =>
                setLinkSlug(
                  e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                )
              }
            />
          </div>
        </Field>
        <Field>
          <label htmlFor="webinar-cap" className={labelClass}>
            Max attendees
          </label>
          <input
            id="webinar-cap"
            type="number"
            min={1}
            max={5000}
            className={inputClass}
            value={maxAttendees}
            onChange={(e) => setMaxAttendees(Number(e.target.value) || 500)}
          />
        </Field>
      </div>

      {!compact && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Field>
            <label htmlFor="webinar-invite" className={labelClass}>
              Invite code
            </label>
            <input
              id="webinar-invite"
              type="text"
              className={inputClass}
              value={inviteCode}
              placeholder="Leave blank for public access"
              onChange={(e) => setInviteCode(e.target.value)}
            />
          </Field>
          <Field>
            <label htmlFor="webinar-lobby" className={labelClass}>
              Open lobby (minutes before)
            </label>
            <input
              id="webinar-lobby"
              type="number"
              min={0}
              max={240}
              className={inputClass}
              value={earlyEntryMinutes}
              onChange={(e) =>
                setEarlyEntryMinutes(Math.max(0, Number(e.target.value) || 0))
              }
            />
          </Field>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TOGGLES.map((toggle) => {
          const checked = toggles[toggle.key];
          return (
            <button
              key={toggle.key}
              type="button"
              onClick={() =>
                setToggles((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }))
              }
              className={`relative flex items-start gap-3 rounded-lg border bg-black/20 p-4 text-left transition-colors ${
                checked
                  ? "border-[#F95F4A]/40 bg-[#F95F4A]/5"
                  : "border-[#FEFCD9]/10 hover:border-[#FEFCD9]/25"
              }`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                  checked
                    ? "border-[#F95F4A] bg-[#F95F4A]"
                    : "border-[#FEFCD9]/25"
                }`}
                aria-hidden
              >
                {checked && (
                  <svg
                    className="h-3 w-3 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </span>
              <div>
                <p className="text-sm text-[#FEFCD9]">{toggle.label}</p>
                <p className="mt-0.5 text-xs text-[#FEFCD9]/50">
                  {toggle.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg border border-[#F95F4A]/30 bg-[#F95F4A]/5 px-4 py-3 text-sm text-[#F95F4A]">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end">
        <button
          type="submit"
          disabled={isWorking}
          className="group inline-flex items-center gap-2 rounded-lg bg-[#F95F4A] px-5 py-2.5 text-sm text-white transition-all hover:bg-[#e8553f] hover:gap-3 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:gap-2"
        >
          {isWorking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarPlus className="h-4 w-4" />
          )}
          <span>{isWorking ? "Scheduling…" : "Schedule webinar"}</span>
        </button>
      </div>
    </form>
  );
}

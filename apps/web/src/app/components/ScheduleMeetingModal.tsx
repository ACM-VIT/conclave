"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, Copy, Loader2, X } from "lucide-react";
import type {
  CreateScheduledMeetingPayload,
  ScheduledMeeting,
} from "@/lib/scheduled-meetings";
import { ROOM_CODE_MAX_LENGTH } from "../lib/utils";

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

const DURATION_OPTIONS = [
  { label: "30 minutes", minutes: 30 },
  { label: "45 minutes", minutes: 45 },
  { label: "1 hour", minutes: 60 },
  { label: "1.5 hours", minutes: 90 },
  { label: "2 hours", minutes: 120 },
];

const sanitizeRoomCodeInput = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/g, "")
    .slice(0, ROOM_CODE_MAX_LENGTH);

const inputClass =
  "w-full rounded-lg border border-[#FEFCD9]/15 bg-black/30 px-3 py-2.5 text-sm text-[#FEFCD9] outline-none placeholder:text-[#FEFCD9]/30 transition-colors focus:border-[#FEFCD9]/35";
const labelClass = "block text-xs text-[#FEFCD9]/55 mb-1.5";

type Props = {
  open: boolean;
  onClose: () => void;
  onScheduled?: (meeting: ScheduledMeeting) => void;
};

export default function ScheduleMeetingModal({
  open,
  onClose,
  onScheduled,
}: Props) {
  const initialStart = useMemo(() => nextRoundedHour(), []);
  const [title, setTitle] = useState("");
  const [startAt, setStartAt] = useState<string>(toLocalInputValue(initialStart));
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [roomCode, setRoomCode] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledMeeting | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setStartAt(toLocalInputValue(nextRoundedHour()));
      setDurationMinutes(60);
      setRoomCode("");
      setError(null);
      setScheduled(null);
      setCopied(false);
      setIsWorking(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const shareLink = useMemo(() => {
    if (!scheduled || typeof window === "undefined") return "";
    return `${window.location.origin}/${scheduled.roomCode}`;
  }, [scheduled]);

  const submit = useCallback(async () => {
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
      setError("Start time has to be in the future.");
      return;
    }
    const payload: CreateScheduledMeetingPayload = {
      title: title.trim(),
      scheduledStartAt: startMs,
      scheduledEndAt: startMs + durationMinutes * 60 * 1000,
      roomCode: roomCode.trim() || undefined,
    };
    setIsWorking(true);
    try {
      const response = await fetch("/api/meetings/scheduled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          (data && typeof data === "object" && "error" in data
            ? String((data as { error?: string }).error || "")
            : "") || "Could not schedule",
        );
      }
      const meeting = (data as { scheduledMeeting?: ScheduledMeeting } | null)
        ?.scheduledMeeting;
      if (!meeting) throw new Error("Schedule succeeded but no details came back");
      setScheduled(meeting);
      onScheduled?.(meeting);
    } catch (err) {
      setError((err as Error).message || "Could not schedule");
    } finally {
      setIsWorking(false);
    }
  }, [title, startAt, durationMinutes, roomCode, onScheduled]);

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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md rounded-2xl border border-[#FEFCD9]/10 bg-[#0d0e0d]/95 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#F95F4A]/15 text-[#F95F4A]">
              <CalendarClock className="h-4 w-4" />
            </span>
            <h2
              className="text-base text-[#FEFCD9] tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              {scheduled ? "meeting scheduled" : "schedule a meeting"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[#FEFCD9]/45 transition hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {scheduled ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-300/25 bg-emerald-300/5 p-4">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-300" />
                <div className="text-sm text-[#FEFCD9]/85">
                  <p className="font-medium">{scheduled.title}</p>
                  <p className="mt-1 text-xs text-[#FEFCD9]/55">
                    {new Date(scheduled.scheduledStartAt).toLocaleString(
                      undefined,
                      {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      },
                    )}
                  </p>
                </div>
              </div>
            </div>
            <div>
              <label className={labelClass}>share link</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareLink}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#FEFCD9]/15 px-3 py-2 text-xs text-[#FEFCD9]/75 transition hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied ? "copied" : "copy"}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-[#FEFCD9]/45">
                Anyone who opens this before the start time sees a countdown.
                You can start it early from there.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-[#FEFCD9]/15 px-3 py-2 text-sm text-[#FEFCD9]/70 transition hover:border-[#FEFCD9]/30 hover:text-[#FEFCD9]"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="meeting-title" className={labelClass}>
                title
              </label>
              <input
                id="meeting-title"
                type="text"
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="ACM-VIT Cybersec Session"
                maxLength={140}
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="meeting-start" className={labelClass}>
                  starts at
                </label>
                <input
                  id="meeting-start"
                  type="datetime-local"
                  className={inputClass}
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="meeting-duration" className={labelClass}>
                  duration
                </label>
                <select
                  id="meeting-duration"
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

            <div>
              <label htmlFor="meeting-code" className={labelClass}>
                meeting code (optional)
              </label>
              <div className="flex items-stretch rounded-lg border border-[#FEFCD9]/15 bg-black/30 transition-colors focus-within:border-[#FEFCD9]/35">
                <span className="flex items-center px-2.5 text-sm text-[#FEFCD9]/35 select-none">
                  /
                </span>
                <input
                  id="meeting-code"
                  type="text"
                  className="flex-1 bg-transparent px-1 py-2.5 text-sm text-[#FEFCD9] outline-none placeholder:text-[#FEFCD9]/30"
                  value={roomCode}
                  onChange={(e) =>
                    setRoomCode(sanitizeRoomCodeInput(e.target.value))
                  }
                  placeholder="acmvit-cybersec, or leave blank for random"
                  maxLength={ROOM_CODE_MAX_LENGTH}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-[#F95F4A]/30 bg-[#F95F4A]/5 px-3 py-2 text-xs text-[#F95F4A]">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-[#FEFCD9]/15 px-3 py-2 text-sm text-[#FEFCD9]/70 transition hover:border-[#FEFCD9]/30 hover:text-[#FEFCD9]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isWorking}
                className="inline-flex items-center gap-2 rounded-lg bg-[#F95F4A] px-4 py-2 text-sm text-white transition-all hover:bg-[#e8553f] hover:gap-3 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:gap-2"
              >
                {isWorking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CalendarClock className="h-4 w-4" />
                )}
                <span>{isWorking ? "Scheduling…" : "Schedule"}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

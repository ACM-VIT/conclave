"use client";

import {
  ArrowLeft,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Globe2,
  Loader2,
  Mail,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AvailableSlot,
  BookingConfirmation,
  PublicSchedulingPage,
} from "@/lib/scheduling";

type Props = {
  username: string;
  eventSlug: string;
};

const DISPLAY_FONT = { fontFamily: "'PolySans Bulky Wide', sans-serif" };

const FIELD =
  "h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 text-[14px] text-[#fafafa] outline-none transition-colors placeholder:text-[#fafafa]/30 focus:border-[#F95F4A]/55 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#F95F4A] px-4 text-[14px] font-semibold text-white transition hover:brightness-[1.07] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55";
const GHOST =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-[14px] font-medium text-[#fafafa]/80 transition-colors hover:border-white/20 hover:bg-white/[0.08] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BTN =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-[#fafafa]/70 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40";
const LABEL = "text-[11px] font-semibold uppercase tracking-[0.1em] text-[#fafafa]/40";

const FALLBACK_TIME_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const listTimeZones = (): string[] => {
  try {
    const zones = (
      Intl as { supportedValuesOf?: (key: "timeZone") => string[] }
    ).supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones;
  } catch {
    // Older runtimes: fall back to a curated list below.
  }
  return FALLBACK_TIME_ZONES;
};

const readError = async (response: Response): Promise<string> => {
  const data = await response.json().catch(() => null);
  return data && typeof data === "object" && "error" in data
    ? String((data as { error?: string }).error || "Request failed")
    : response.statusText || "Request failed";
};

const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
};

const dateKey = (timestamp: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const parseDateKey = (value: string): { year: number; month: number; day: number } => {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return { year, month, day };
};

const addDaysToDateKey = (value: string, days: number): string => {
  const { year, month, day } = parseDateKey(value);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(next.getUTCDate()).padStart(2, "0")}`;
};

const addMonthsToMonthKey = (value: string, months: number): string => {
  const [year, month] = value.split("-").map((part) => Number(part));
  const next = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}`;
};

const weekdayForDateKey = (value: string): number => {
  const { year, month, day } = parseDateKey(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

const monthTitle = (monthKey: string): string => {
  const [year, month] = monthKey.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

const formatDateKeyLong = (value: string): string => {
  const { year, month, day } = parseDateKey(value);
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString(
    undefined,
    {
      timeZone: "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
    },
  );
};

const formatLongDate = (timestamp: number, timeZone: string): string =>
  new Date(timestamp).toLocaleDateString(undefined, {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

const formatTime = (timestamp: number, timeZone: string): string =>
  new Date(timestamp).toLocaleTimeString(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });

const buildGoogleCalendarUrl = (
  booking: BookingConfirmation,
  timeZone: string,
): string => {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: booking.title,
    dates: `${new Date(booking.startsAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}/${new Date(booking.endsAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
    details: `Join Conclave: ${booking.meetingLink}`,
    location: "Conclave room",
    ctz: timeZone,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};

function TimeZoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const options = useMemo(() => {
    const zones = listTimeZones();
    return value && !zones.includes(value) ? [value, ...zones] : zones;
  }, [value]);
  return (
    <div className="relative">
      <Globe2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#fafafa]/35" />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${FIELD} appearance-none pl-10 pr-9`}
      >
        {options.map((zone) => (
          <option key={zone} value={zone} className="bg-[#111114] text-[#fafafa]">
            {zone.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#fafafa]/35" />
    </div>
  );
}

export default function BookingClient({ username, eventSlug }: Props) {
  const initialTimeZone = useMemo(() => browserTimeZone(), []);
  const [page, setPage] = useState<PublicSchedulingPage | null>(null);
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [visibleMonth, setVisibleMonth] = useState(() =>
    dateKey(Date.now(), initialTimeZone).slice(0, 7),
  );
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailableSlot | null>(null);
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const [slotStatus, setSlotStatus] = useState<"idle" | "loading" | "error">("idle");
  const [isBooking, setIsBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    fetchJson<{ schedulingPage: PublicSchedulingPage }>(
      `/api/scheduling/public/${encodeURIComponent(username)}/${encodeURIComponent(eventSlug)}`,
    )
      .then((data) => {
        if (cancelled) return;
        setPage(data.schedulingPage);
        setStatus("idle");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError((loadError as Error).message || "Booking page not found");
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [username, eventSlug]);

  const loadSlots = useCallback(async () => {
    if (!page) return;
    setSlotStatus("loading");
    setError(null);
    try {
      const [year, month] = visibleMonth.split("-").map((part) => Number(part));
      const from = Date.UTC(year, month - 1, 1) - 7 * 24 * 60 * 60 * 1000;
      const to = Date.UTC(year, month, 1) + 7 * 24 * 60 * 60 * 1000;
      const data = await fetchJson<{ slots?: AvailableSlot[] }>(
        `/api/scheduling/public/${encodeURIComponent(username)}/${encodeURIComponent(eventSlug)}/slots?from=${from}&to=${to}&timeZone=${encodeURIComponent(timeZone)}`,
      );
      setSlots(data.slots ?? []);
      setSlotStatus("idle");
    } catch (slotError) {
      setError((slotError as Error).message || "Could not load slots");
      setSlotStatus("error");
    }
  }, [eventSlug, page, timeZone, username, visibleMonth]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  const slotsByDate = useMemo(() => {
    const grouped = new Map<string, AvailableSlot[]>();
    for (const slot of slots) {
      const key = dateKey(slot.startAt, timeZone);
      grouped.set(key, [...(grouped.get(key) ?? []), slot]);
    }
    return grouped;
  }, [slots, timeZone]);

  const monthDays = useMemo(() => {
    const days: Array<{ key: string; day: number; inMonth: boolean }> = [];
    const firstOfMonth = `${visibleMonth}-01`;
    const firstGridDay = addDaysToDateKey(
      firstOfMonth,
      -weekdayForDateKey(firstOfMonth),
    );
    for (let i = 0; i < 42; i += 1) {
      const key = addDaysToDateKey(firstGridDay, i);
      days.push({
        key,
        day: parseDateKey(key).day,
        inMonth: key.startsWith(`${visibleMonth}-`),
      });
    }
    return days;
  }, [visibleMonth]);

  const selectedSlots = selectedDate ? slotsByDate.get(selectedDate) ?? [] : [];

  const confirmBooking = useCallback(async () => {
    if (!selectedSlot || !name.trim() || !email.trim()) {
      setError("Choose a time and add your name and email.");
      return;
    }
    setIsBooking(true);
    setError(null);
    try {
      const data = await fetchJson<{ booking: BookingConfirmation }>(
        `/api/scheduling/public/${encodeURIComponent(username)}/${encodeURIComponent(eventSlug)}/book`,
        {
          method: "POST",
          body: JSON.stringify({
            startAt: selectedSlot.startAt,
            attendeeName: name.trim(),
            attendeeEmail: email.trim(),
            attendeeNote: note.trim(),
            attendeeTimeZone: timeZone,
          }),
        },
      );
      setConfirmation(data.booking);
      setSlots((current) =>
        current.filter((slot) => slot.startAt !== selectedSlot.startAt),
      );
    } catch (bookingError) {
      setError((bookingError as Error).message || "Could not confirm booking");
    } finally {
      setIsBooking(false);
    }
  }, [email, eventSlug, name, note, selectedSlot, timeZone, username]);

  if (status === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] text-[#fafafa]">
        <Loader2 className="h-5 w-5 animate-spin text-[#F95F4A]" />
      </main>
    );
  }

  if (!page) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 text-[#fafafa]">
        <section className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0e0e10] p-6 text-center">
          <h1 className="text-xl font-semibold">This booking link is unavailable</h1>
          <p className="mt-2 text-sm text-[#fafafa]/55">{error}</p>
        </section>
      </main>
    );
  }

  if (confirmation) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-8 text-[#fafafa]">
        <section className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0e0e10] p-7 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#2BA84A]/15 text-[#7BE495]">
            <Check className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-[24px] tracking-tight" style={DISPLAY_FONT}>
            You&apos;re booked
          </h1>
          <p className="mt-2 text-[13.5px] text-[#fafafa]/55">
            {formatLongDate(confirmation.startsAt, timeZone)} ·{" "}
            {formatTime(confirmation.startsAt, timeZone)}
          </p>
          {confirmation.syncStatus === "failed" ? (
            <p className="mt-3 rounded-xl border border-[#F95F4A]/25 bg-[#F95F4A]/[0.08] px-3 py-2 text-[12.5px] text-[#ffb2a8]">
              The Conclave room is booked. Calendar sync did not complete.
            </p>
          ) : null}
          {confirmation.emailNotificationStatus === "failed" ? (
            <p className="mt-3 rounded-xl border border-[#F95F4A]/25 bg-[#F95F4A]/[0.08] px-3 py-2 text-[12.5px] text-[#ffb2a8]">
              The Conclave room is booked. Confirmation email did not send.
            </p>
          ) : null}
          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#fafafa]/40">
              Conclave room
            </p>
            <a
              href={confirmation.meetingLink}
              className="mt-1.5 block break-all text-[14px] text-[#fafafa] transition-colors hover:text-[#F95F4A]"
            >
              {confirmation.meetingLink}
            </a>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            <a href={confirmation.meetingLink} className={PRIMARY}>
              <Video className="h-4 w-4" />
              Open room
            </a>
            <button
              type="button"
              className={GHOST}
              onClick={() => {
                void navigator.clipboard.writeText(confirmation.meetingLink);
                setCopied(true);
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              Copy
            </button>
            <a
              href={buildGoogleCalendarUrl(confirmation, timeZone)}
              className={GHOST}
              target="_blank"
              rel="noreferrer"
            >
              <CalendarPlus className="h-4 w-4" />
              Calendar
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-8 text-[#fafafa]">
      <div className="w-full max-w-[860px]">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0e0e10] md:grid md:grid-cols-[290px_minmax(0,1fr)]">
          {/* What you're booking */}
          <aside className="border-b border-white/10 p-6 md:border-b-0 md:border-r">
            <p className="text-[13px] text-[#fafafa]/45">{page.profile.name}</p>
            <h1
              className="mt-1.5 text-[22px] leading-tight tracking-tight"
              style={DISPLAY_FONT}
            >
              {page.eventType.title}
            </h1>
            {page.eventType.description ? (
              <p className="mt-3 text-[13px] leading-relaxed text-[#fafafa]/55">
                {page.eventType.description}
              </p>
            ) : null}
            <div className="mt-5 grid gap-2.5 text-[13px] text-[#fafafa]/60">
              <div className="flex items-center gap-2.5">
                <Clock3 className="h-4 w-4 shrink-0 text-[#fafafa]/35" />
                {page.eventType.durationMinutes} min
              </div>
              <div className="flex items-center gap-2.5">
                <Video className="h-4 w-4 shrink-0 text-[#fafafa]/35" />
                Conclave video room
              </div>
              <div className="flex items-center gap-2.5">
                <Mail className="h-4 w-4 shrink-0 text-[#fafafa]/35" />
                Email confirmation on booking
              </div>
            </div>
            <div className="mt-6 hidden md:block">
              <p className={`${LABEL} mb-1.5`}>Timezone</p>
              <TimeZoneSelect value={timeZone} onChange={setTimeZone} />
            </div>
          </aside>

          {/* When + who */}
          <section className="flex flex-col p-6 md:min-h-[508px]">
            {selectedSlot ? (
              <div className="flex flex-1 flex-col">
                <button
                  type="button"
                  onClick={() => setSelectedSlot(null)}
                  className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-[#fafafa]/50 transition-colors hover:text-[#fafafa]"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Change time
                </button>

                <div className="flex flex-1 flex-col justify-center">
                  <div className="flex items-center gap-2.5 rounded-xl border border-[#F95F4A]/25 bg-[#F95F4A]/[0.08] px-3.5 py-3 text-[13px] text-[#ffb2a8]">
                    <Clock3 className="h-4 w-4 shrink-0" />
                    <span>
                      {formatLongDate(selectedSlot.startAt, timeZone)} ·{" "}
                      {formatTime(selectedSlot.startAt, timeZone)}
                    </span>
                  </div>

                  <div className="mt-5 grid gap-3">
                    <label className="grid gap-1.5">
                      <span className={LABEL}>Name</span>
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Your name"
                        autoComplete="name"
                        className={FIELD}
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className={LABEL}>Email</span>
                      <input
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                        type="email"
                        autoComplete="email"
                        className={FIELD}
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className={LABEL}>Note (optional)</span>
                      <textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Anything the host should know?"
                        className={`${FIELD} min-h-[84px] resize-none py-2.5 leading-relaxed`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void confirmBooking()}
                      disabled={isBooking}
                      className={`${PRIMARY} mt-1`}
                    >
                      {isBooking ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Confirm booking
                    </button>
                    {error ? (
                      <p className="text-[13px] text-[#ff9a8c]" role="alert">
                        {error}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className={ICON_BTN}
                    aria-label="Previous month"
                    onClick={() =>
                      setVisibleMonth(addMonthsToMonthKey(visibleMonth, -1))
                    }
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <h2 className="text-[15px] font-semibold">{monthTitle(visibleMonth)}</h2>
                  <button
                    type="button"
                    className={ICON_BTN}
                    aria-label="Next month"
                    onClick={() =>
                      setVisibleMonth(addMonthsToMonthKey(visibleMonth, 1))
                    }
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] text-[#fafafa]/35">
                  {["S", "M", "T", "W", "T", "F", "S"].map((day, index) => (
                    <span key={`${day}-${index}`}>{day}</span>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-7 gap-1">
                  {monthDays.map((day) => {
                    const key = day.key;
                    const available = slotsByDate.get(key)?.length ?? 0;
                    const inMonth = day.inMonth;
                    const selected = key === selectedDate;
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={!available}
                        onClick={() => {
                          setSelectedDate(key);
                          setSelectedSlot(null);
                        }}
                        className={`relative h-9 rounded-lg text-[13px] transition-colors disabled:cursor-not-allowed ${
                          selected
                            ? "bg-[#F95F4A] font-medium text-white"
                            : available
                              ? "bg-white/[0.05] text-[#fafafa] hover:bg-white/[0.1]"
                              : "text-[#fafafa]/20"
                        } ${inMonth ? "" : "opacity-40"}`}
                      >
                        {day.day}
                        {available && !selected ? (
                          <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[#F95F4A]" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-5 min-h-[164px]">
                  {slotStatus === "loading" ? (
                    <p className="flex items-center gap-2 text-[13px] text-[#fafafa]/45">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading availability
                    </p>
                  ) : slotStatus === "error" ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-[#F95F4A]/30 bg-[#F95F4A]/10 px-3 py-2.5 text-[13px] text-[#ffb2a8]">
                      <span className="truncate">Could not load availability.</span>
                      <button
                        type="button"
                        onClick={() => void loadSlots()}
                        className="shrink-0 font-medium underline-offset-2 hover:underline"
                      >
                        Retry
                      </button>
                    </div>
                  ) : selectedDate ? (
                    <>
                      <p className={`${LABEL} mb-2.5`}>
                        {selectedSlots[0]
                          ? formatLongDate(selectedSlots[0].startAt, timeZone)
                          : formatDateKeyLong(selectedDate)}
                      </p>
                      {selectedSlots.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-white/12 px-3 py-4 text-[13px] text-[#fafafa]/45">
                          No times left for this day.
                        </p>
                      ) : (
                        <div className="grid max-h-[148px] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
                          {selectedSlots.map((slot) => (
                            <button
                              key={slot.startAt}
                              type="button"
                              onClick={() => setSelectedSlot(slot)}
                              className="h-10 rounded-lg border border-white/10 bg-white/[0.03] text-[13px] font-medium text-[#fafafa]/80 transition-colors hover:border-[#F95F4A]/60 hover:bg-[#F95F4A]/10 hover:text-[#fafafa]"
                            >
                              {formatTime(slot.startAt, timeZone)}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-[13px] text-[#fafafa]/40">
                      Pick a day to see available times.
                    </p>
                  )}
                </div>

                <div className="mt-5 md:hidden">
                  <p className={`${LABEL} mb-1.5`}>Timezone</p>
                  <TimeZoneSelect value={timeZone} onChange={setTimeZone} />
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

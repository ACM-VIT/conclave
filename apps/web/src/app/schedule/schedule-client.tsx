"use client";

import {
  ArrowLeft,
  CalendarCheck,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Switch } from "@conclave/ui-tokens/web";
import type {
  CalendarConnectionSummary,
  SchedulingDashboardResponse,
  SchedulingEventType,
  WeeklyAvailability,
} from "@/lib/scheduling";
import { buildMeetingPath } from "@/lib/meeting-links";

type Props = {
  user: {
    name: string;
    email: string;
  };
};

type Booking = {
  id: string;
  clientId?: string;
  roomCode: string;
  title: string;
  attendeeName?: string | null;
  attendeeEmail?: string | null;
  scheduledStartAt: number;
  scheduledEndAt: number;
  calendarSyncStatus?: string;
  emailNotificationStatus?: string;
};

const DAYS = [
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
  ["Sun", 0],
] as const;

const CONNECT_URL = "/api/scheduling/calendar/google/connect";

const NOTICE_OPTIONS = [
  [0, "No notice"],
  [60, "1 hour"],
  [120, "2 hours"],
  [240, "4 hours"],
  [1440, "1 day"],
] as const;
const WINDOW_OPTIONS = [
  [7, "1 week"],
  [14, "2 weeks"],
  [30, "30 days"],
  [60, "60 days"],
  [90, "90 days"],
] as const;
const BUFFER_OPTIONS = [
  [0, "None"],
  [5, "5 min"],
  [10, "10 min"],
  [15, "15 min"],
  [30, "30 min"],
] as const;

const FIELD =
  "h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 text-[14px] text-[#fafafa] outline-none transition-colors placeholder:text-[#fafafa]/30 focus:border-[#F95F4A]/55 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50";
const SELECT =
  "h-10 w-full appearance-none rounded-lg border border-white/10 bg-white/[0.03] pl-3 pr-8 text-[13px] text-[#fafafa] outline-none transition-colors focus:border-[#F95F4A]/55";
const PRIMARY =
  "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#F95F4A] px-4 text-[13.5px] font-semibold text-white transition hover:brightness-[1.07] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55";
const CHIP =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[12px] font-medium text-[#fafafa]/72 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BTN =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-[#fafafa]/70 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-50";
const LABEL = "text-[11px] font-semibold uppercase tracking-[0.1em] text-[#fafafa]/40";

const minutesToInput = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const inputToMinutes = (value: string): number => {
  const [h, m] = value.split(":").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.max(0, Math.min(24 * 60, h * 60 + m));
};

const formatShort = (minutes: number): string => {
  const h24 = Math.floor(minutes / 60);
  const min = minutes % 60;
  const suffix = h24 >= 12 ? "p" : "a";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min ? `${h12}:${String(min).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
};

const formatDateTime = (value: number): string =>
  new Date(value).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const emailStatusLabel = (status: string | undefined): string => {
  switch (status) {
    case "sent":
      return "Email sent";
    case "failed":
      return "Email failed";
    case "pending":
      return "Email pending";
    default:
      return "Email off";
  }
};

const emailStatusClass = (status: string | undefined): string => {
  switch (status) {
    case "sent":
      return "border-[#2BA84A]/25 bg-[#2BA84A]/10 text-[#7BE495]";
    case "failed":
      return "border-[#F95F4A]/25 bg-[#F95F4A]/10 text-[#ffb2a8]";
    default:
      return "border-white/10 bg-white/[0.04] text-[#fafafa]/55";
  }
};

const readError = async (response: Response): Promise<string> => {
  const data = await response.json().catch(() => null);
  return data && typeof data === "object" && "error" in data
    ? String((data as { error?: string }).error || "Request failed")
    : response.statusText || "Request failed";
};

const fetchJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
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

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

const isCalendarConnected = (calendar: CalendarConnectionSummary | null): boolean =>
  calendar?.status === "connected";

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

export default function ScheduleClient({ user }: Props) {
  const [dashboard, setDashboard] = useState<SchedulingDashboardResponse | null>(
    null,
  );
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<SchedulingEventType | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [profileData, bookingsData] = await Promise.all([
        fetchJson<SchedulingDashboardResponse>("/api/scheduling/profile"),
        fetchJson<{ bookings?: Booking[] }>("/api/scheduling/bookings"),
      ]);
      setDashboard(profileData);
      setBookings(bookingsData.bookings ?? []);
      setStatus("idle");
    } catch (loadError) {
      setError((loadError as Error).message || "Could not load scheduling");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const origin = useMemo(
    () => (typeof window === "undefined" ? "" : window.location.origin),
    [],
  );

  const updateProfile = useCallback(
    async (updates: { name?: string; username?: string; timeZone?: string }) => {
      setWorking("profile");
      setError(null);
      try {
        const data = await fetchJson<SchedulingDashboardResponse>(
          "/api/scheduling/profile",
          { method: "PUT", body: JSON.stringify(updates) },
        );
        setDashboard(data);
      } catch (updateError) {
        setError((updateError as Error).message || "Could not update profile");
      } finally {
        setWorking(null);
      }
    },
    [],
  );

  const saveAvailability = useCallback(
    async (availability: WeeklyAvailability) => {
      setWorking("availability");
      setError(null);
      try {
        const data = await fetchJson<{
          availability: WeeklyAvailability;
          profile: SchedulingDashboardResponse["profile"];
        }>("/api/scheduling/availability/default", {
          method: "PUT",
          body: JSON.stringify(availability),
        });
        setDashboard((current) =>
          current
            ? { ...current, profile: data.profile, availability: data.availability }
            : current,
        );
      } catch (saveError) {
        setError((saveError as Error).message || "Could not save availability");
      } finally {
        setWorking(null);
      }
    },
    [],
  );

  const createEventType = useCallback(async () => {
    const title = "New event type";
    setWorking("create-event");
    setError(null);
    try {
      const data = await fetchJson<{ eventType: SchedulingEventType }>(
        "/api/scheduling/event-types",
        {
          method: "POST",
          body: JSON.stringify({
            title,
            slug: slugify(title),
            durationMinutes: 30,
            isActive: false,
          }),
        },
      );
      setDashboard((current) =>
        current
          ? { ...current, eventTypes: [...current.eventTypes, data.eventType] }
          : current,
      );
      setEditing(data.eventType);
    } catch (createError) {
      setError((createError as Error).message || "Could not create event type");
    } finally {
      setWorking(null);
    }
  }, []);

  const patchEventType = useCallback(
    async (id: string, updates: Partial<SchedulingEventType>) => {
      setWorking(id);
      setError(null);
      try {
        const data = await fetchJson<{ eventType: SchedulingEventType }>(
          `/api/scheduling/event-types/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify(updates) },
        );
        setDashboard((current) =>
          current
            ? {
                ...current,
                eventTypes: current.eventTypes.map((eventType) =>
                  eventType.id === id ? data.eventType : eventType,
                ),
              }
            : current,
        );
        setEditing((current) => (current?.id === id ? data.eventType : current));
      } catch (patchError) {
        setError((patchError as Error).message || "Could not update event type");
      } finally {
        setWorking(null);
      }
    },
    [],
  );

  const copyLink = useCallback(
    async (eventType: SchedulingEventType) => {
      if (!dashboard || !origin) return;
      const link = `${origin}/book/${encodeURIComponent(
        dashboard.profile.username,
      )}/${encodeURIComponent(eventType.slug)}`;
      await navigator.clipboard.writeText(link).catch(() => null);
      setCopied(eventType.id);
      setTimeout(() => setCopied(null), 1500);
    },
    [dashboard, origin],
  );

  const disconnectCalendar = useCallback(async () => {
    setWorking("calendar");
    setError(null);
    try {
      const data = await fetchJson<{
        calendar: CalendarConnectionSummary;
        eventTypes: SchedulingEventType[];
      }>("/api/scheduling/calendar/google", { method: "DELETE" });
      setDashboard((current) =>
        current
          ? { ...current, calendar: data.calendar, eventTypes: data.eventTypes }
          : current,
      );
    } catch (disconnectError) {
      setError((disconnectError as Error).message || "Could not disconnect calendar");
    } finally {
      setWorking(null);
    }
  }, []);

  const changeTimeZone = useCallback(
    (timeZone: string) => {
      setDashboard((current) =>
        current
          ? {
              ...current,
              profile: { ...current.profile, timeZone },
              availability: { ...current.availability, timeZone },
            }
          : current,
      );
      void updateProfile({ timeZone });
    },
    [updateProfile],
  );

  if (status === "loading" && !dashboard) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] text-[#fafafa]">
        <Loader2 className="h-5 w-5 animate-spin text-[#F95F4A]" />
      </main>
    );
  }

  if (!dashboard) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 text-[#fafafa]">
        <section className="max-w-md rounded-2xl border border-white/10 bg-[#0e0e10] p-6 text-center">
          <h1 className="text-xl font-semibold">Scheduling did not load</h1>
          <p className="mt-2 text-sm text-[#fafafa]/55">{error}</p>
          <button type="button" onClick={() => void load()} className={`${PRIMARY} mx-auto mt-5`}>
            Retry
          </button>
        </section>
      </main>
    );
  }

  const calendarConnected = isCalendarConnected(dashboard.calendar);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-8 text-[#fafafa]">
      <div className="w-full max-w-[820px]">
        <a
          href="/"
          className="mb-3 inline-flex items-center gap-2 text-[12.5px] text-[#fafafa]/45 transition-colors hover:text-[#fafafa]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to meet
        </a>

        <div className="rounded-2xl border border-white/10 bg-[#0e0e10]">
          {/* Header — identity + the one primary action */}
          <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <input
                  defaultValue={dashboard.profile.name}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name && name !== dashboard.profile.name) void updateProfile({ name });
                  }}
                  className="w-full truncate rounded-md bg-transparent text-[15px] font-medium text-[#fafafa] outline-none focus:bg-white/[0.05] focus:px-1"
                />
                <div className="flex items-center text-[12.5px] text-[#F95F4A]/85">
                  <span className="text-[#fafafa]/30">/book/</span>
                  <input
                    defaultValue={dashboard.profile.username}
                    onChange={(event) => {
                      event.target.value = slugify(event.target.value);
                    }}
                    onBlur={(event) => {
                      const username = slugify(event.target.value);
                      if (username && username !== dashboard.profile.username)
                        void updateProfile({ username });
                    }}
                    className="min-w-0 flex-1 truncate bg-transparent outline-none"
                  />
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void createEventType()}
              disabled={working === "create-event"}
              className={PRIMARY}
            >
              {working === "create-event" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              New event type
            </button>
          </div>

          <div className="space-y-6 p-5 sm:p-6">
            {error ? (
              <p className="rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/10 px-4 py-2.5 text-[13px] text-[#ffb2a8]">
                {error}
              </p>
            ) : null}

            {/* Calendar — banner only when it needs attention */}
            {calendarConnected ? (
              <div className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="inline-flex min-w-0 items-center gap-2 text-[#fafafa]/55">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[#7BE495]" />
                  Calendar connected
                  {dashboard.calendar.email ? (
                    <span className="truncate text-[#fafafa]/35">· {dashboard.calendar.email}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => void disconnectCalendar()}
                  disabled={working === "calendar"}
                  className="shrink-0 text-[#fafafa]/45 transition-colors hover:text-[#fafafa] disabled:opacity-50"
                >
                  {working === "calendar" ? "…" : "Disconnect"}
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4 rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/[0.08] px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <CalendarCheck className="h-5 w-5 shrink-0 text-[#ff9a8c]" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[#ff9a8c]">Connect Google Calendar</p>
                    <p className="truncate text-[12px] text-[#fafafa]/50">
                      Optional busy checks and calendar invites.
                    </p>
                  </div>
                </div>
                <a href={CONNECT_URL} className={`${PRIMARY} h-9`}>
                  Connect
                </a>
              </div>
            )}

            {/* Booking links */}
            <section>
              <p className={`${LABEL} mb-3`}>Booking links</p>
              {dashboard.eventTypes.length === 0 ? (
                <button
                  type="button"
                  onClick={() => void createEventType()}
                  disabled={working === "create-event"}
                  className="group flex w-full items-center justify-between gap-4 rounded-xl border border-dashed border-white/12 px-4 py-4 text-left transition-colors hover:border-white/20 hover:bg-white/[0.02]"
                >
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">
                      Create your first booking link
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-[#fafafa]/40">
                      A shareable link that opens into a Conclave room.
                    </span>
                  </span>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F95F4A] text-white">
                    <Plus className="h-4 w-4" />
                  </span>
                </button>
              ) : (
                <div className="grid gap-2.5">
                  {dashboard.eventTypes.map((eventType) => (
                    <article
                      key={eventType.id}
                      className="group flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3.5 transition-colors hover:border-white/20 hover:bg-white/[0.035] sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <h3 className="truncate text-[14.5px] font-medium">
                            {eventType.title}
                          </h3>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                              eventType.isActive
                                ? "bg-[#2BA84A]/15 text-[#7BE495]"
                                : "bg-white/[0.07] text-[#fafafa]/45"
                            }`}
                          >
                            {eventType.isActive ? (
                              <span className="h-1.5 w-1.5 rounded-full bg-[#7BE495]" />
                            ) : null}
                            {eventType.isActive ? "Live" : "Draft"}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-[12px] text-[#fafafa]/40">
                          {eventType.durationMinutes} min · /book/{dashboard.profile.username}/{eventType.slug}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Switch
                          label={`Publish ${eventType.title}`}
                          checked={eventType.isActive}
                          disabled={working === eventType.id}
                          onChange={(checked) =>
                            void patchEventType(eventType.id, { isActive: checked })
                          }
                        />
                        <button
                          type="button"
                          onClick={() => void copyLink(eventType)}
                          className={ICON_BTN}
                          title="Copy booking link"
                          aria-label="Copy booking link"
                        >
                          {copied === eventType.id ? (
                            <Check className="h-4 w-4 text-[#7BE495]" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                        <a
                          href={`/book/${encodeURIComponent(
                            dashboard.profile.username,
                          )}/${encodeURIComponent(eventType.slug)}`}
                          target="_blank"
                          rel="noreferrer"
                          className={ICON_BTN}
                          title="Open booking page"
                          aria-label="Open booking page"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => setEditing(eventType)}
                          className={CHIP}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {/* Weekly hours */}
            <AvailabilitySection
              availability={dashboard.availability}
              timeZone={dashboard.profile.timeZone}
              working={working === "availability"}
              onSave={(availability) => void saveAvailability(availability)}
              onTimeZoneChange={changeTimeZone}
            />

            {/* Bookings — only when there are any */}
            {bookings.length > 0 ? (
              <section>
                <p className={`${LABEL} mb-3`}>Upcoming</p>
                <div className="grid gap-2">
                  {bookings.slice(0, 8).map((booking) => (
                    <a
                      key={booking.id}
                      href={buildMeetingPath(booking)}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 transition-colors hover:bg-white/[0.05]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-medium">
                          {booking.attendeeName || booking.attendeeEmail || booking.title}
                        </p>
                        <p className="mt-0.5 truncate text-[12px] text-[#fafafa]/40">
                          {formatDateTime(booking.scheduledStartAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`hidden h-8 items-center rounded-lg border px-2.5 text-[12px] font-medium sm:inline-flex ${emailStatusClass(
                            booking.emailNotificationStatus,
                          )}`}
                        >
                          {emailStatusLabel(booking.emailNotificationStatus)}
                        </span>
                        <span className={CHIP}>Open room</span>
                      </div>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>

      {editing ? (
        <EventEditor
          eventType={editing}
          username={dashboard.profile.username}
          calendarConnected={calendarConnected}
          working={working === editing.id}
          onClose={() => setEditing(null)}
          onDelete={async () => {
            setWorking(editing.id);
            setError(null);
            try {
              await fetchJson<{ success: boolean }>(
                `/api/scheduling/event-types/${encodeURIComponent(editing.id)}`,
                { method: "DELETE" },
              );
              setDashboard((current) =>
                current
                  ? {
                      ...current,
                      eventTypes: current.eventTypes.filter(
                        (eventType) => eventType.id !== editing.id,
                      ),
                    }
                  : current,
              );
              setEditing(null);
            } catch (deleteError) {
              setError((deleteError as Error).message || "Could not delete event type");
            } finally {
              setWorking(null);
            }
          }}
          onSave={(updates) => void patchEventType(editing.id, updates)}
        />
      ) : null}
    </div>
  );
}

function AvailabilitySection({
  availability,
  timeZone,
  working,
  onSave,
  onTimeZoneChange,
}: {
  availability: WeeklyAvailability;
  timeZone: string;
  working: boolean;
  onSave: (availability: WeeklyAvailability) => void;
  onTimeZoneChange: (timeZone: string) => void;
}) {
  const [draft, setDraft] = useState(availability);
  const [openDay, setOpenDay] = useState<number | null>(null);

  useEffect(() => {
    setDraft(availability);
  }, [availability]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenDay(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(draft.windows) !== JSON.stringify(availability.windows),
    [draft.windows, availability.windows],
  );

  const zones = useMemo(() => {
    const all = listTimeZones();
    return all.includes(timeZone) ? all : [timeZone, ...all];
  }, [timeZone]);

  const applyToEnabled = (day: number) => {
    setDraft((current) => {
      const source = current.windows.find((window) => window.day === day);
      if (!source) return current;
      return {
        ...current,
        windows: current.windows.map((window) => ({
          ...window,
          startMinutes: source.startMinutes,
          endMinutes: source.endMinutes,
        })),
      };
    });
  };

  const updateDay = (
    day: number,
    update: { enabled?: boolean; start?: string; end?: string },
  ) => {
    setDraft((current) => {
      const existing = current.windows.find((window) => window.day === day);
      const rest = current.windows.filter((window) => window.day !== day);
      const startMinutes =
        update.start !== undefined
          ? inputToMinutes(update.start)
          : existing?.startMinutes ?? 9 * 60;
      const endMinutes =
        update.end !== undefined
          ? inputToMinutes(update.end)
          : existing?.endMinutes ?? 17 * 60;
      const enabled = update.enabled ?? Boolean(existing);
      return {
        ...current,
        windows: enabled
          ? [
              ...rest,
              {
                day: day as 0 | 1 | 2 | 3 | 4 | 5 | 6,
                startMinutes,
                endMinutes: Math.max(endMinutes, startMinutes + 15),
              },
            ].sort((a, b) => a.day - b.day)
          : rest,
      };
    });
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className={LABEL}>Weekly hours</p>
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={timeZone}
              onChange={(event) => onTimeZoneChange(event.target.value)}
              className="h-8 max-w-[150px] appearance-none truncate rounded-lg border border-white/10 bg-white/[0.03] pl-2.5 pr-7 text-[12px] text-[#fafafa]/70 outline-none transition-colors hover:text-[#fafafa] focus:border-[#F95F4A]/55"
            >
              {zones.map((zone) => (
                <option key={zone} value={zone} className="bg-[#111114]">
                  {zone.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#fafafa]/35" />
          </div>
          <button
            type="button"
            onClick={() => onSave(draft)}
            disabled={working || !dirty}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors ${
              dirty
                ? "text-[#F95F4A] hover:text-[#ff7a66]"
                : "cursor-default text-[#fafafa]/30"
            }`}
          >
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {DAYS.map(([label, day], index) => {
          const window = draft.windows.find((entry) => entry.day === day);
          const enabled = Boolean(window);
          const open = openDay === day;
          return (
            <div key={day} className="relative">
              <button
                type="button"
                onClick={() => setOpenDay(open ? null : day)}
                className={`flex w-full flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                  open
                    ? "border-[#F95F4A]/60 bg-[#F95F4A]/10"
                    : enabled
                      ? "border-white/10 bg-white/[0.04] hover:border-white/20"
                      : "border-white/[0.06] hover:border-white/15"
                }`}
              >
                <span
                  className={`text-[12.5px] font-medium ${
                    enabled ? "text-[#fafafa]" : "text-[#fafafa]/40"
                  }`}
                >
                  {label}
                </span>
                <span
                  className={`text-[11px] tabular-nums ${
                    enabled ? "text-[#F95F4A]/85" : "text-[#fafafa]/30"
                  }`}
                >
                  {enabled
                    ? `${formatShort(window?.startMinutes ?? 9 * 60)}–${formatShort(
                        window?.endMinutes ?? 17 * 60,
                      )}`
                    : "Off"}
                </span>
              </button>

              {open ? (
                <>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setOpenDay(null)}
                    className="fixed inset-0 z-20 cursor-default"
                  />
                  <div
                    className={`absolute top-full z-30 mt-2 w-[228px] rounded-xl border border-white/10 bg-[#16161a] p-3 shadow-[0_18px_44px_rgba(0,0,0,0.55)] ${
                      index >= 4 ? "right-0" : "left-0"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] font-medium">{label}</span>
                      <Switch
                        label={`Available on ${label}`}
                        checked={enabled}
                        onChange={(checked) => updateDay(day, { enabled: checked })}
                      />
                    </div>
                    {enabled ? (
                      <div className="mt-3 space-y-2">
                        <input
                          type="time"
                          value={minutesToInput(window?.startMinutes ?? 9 * 60)}
                          onChange={(event) =>
                            updateDay(day, { start: event.target.value })
                          }
                          className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 text-[13px] text-[#fafafa] outline-none focus:border-[#F95F4A]/55"
                        />
                        <input
                          type="time"
                          value={minutesToInput(window?.endMinutes ?? 17 * 60)}
                          onChange={(event) => updateDay(day, { end: event.target.value })}
                          className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 text-[13px] text-[#fafafa] outline-none focus:border-[#F95F4A]/55"
                        />
                        <button
                          type="button"
                          onClick={() => applyToEnabled(day)}
                          className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-[12px] text-[#fafafa]/60 transition-colors hover:bg-white/[0.07] hover:text-[#fafafa]"
                        >
                          Apply to all active days
                        </button>
                      </div>
                    ) : (
                      <p className="mt-2.5 text-[12px] text-[#fafafa]/40">
                        Turn on to set hours for {label}.
                      </p>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EventEditor({
  eventType,
  username,
  calendarConnected,
  working,
  onClose,
  onSave,
  onDelete,
}: {
  eventType: SchedulingEventType;
  username: string;
  calendarConnected: boolean;
  working: boolean;
  onClose: () => void;
  onSave: (updates: Partial<SchedulingEventType>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(eventType);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setDraft(eventType);
  }, [eventType]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
      <button type="button" aria-label="Close" onClick={onClose} className="flex-1 cursor-default" />
      <section className="flex h-full w-full max-w-[420px] flex-col border-l border-white/10 bg-[#0c0c0e]">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold">Edit event type</h2>
            <p className="mt-0.5 truncate text-[12px] text-[#fafafa]/45">
              /book/{username}/{draft.slug || "…"}
            </p>
          </div>
          <button type="button" onClick={onClose} className={ICON_BTN} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-5">
            <label className="grid gap-1.5">
              <span className={LABEL}>Title</span>
              <input
                className={FIELD}
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1.5">
              <span className={LABEL}>Description</span>
              <textarea
                className={`${FIELD} min-h-[88px] resize-none py-2.5 leading-relaxed`}
                placeholder="What is this meeting about?"
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>

            <div className="grid gap-2">
              <span className={LABEL}>Duration</span>
              <div className="grid grid-cols-4 gap-2">
                {[15, 30, 45, 60].map((duration) => (
                  <button
                    key={duration}
                    type="button"
                    onClick={() =>
                      setDraft((current) => ({ ...current, durationMinutes: duration }))
                    }
                    className={`h-10 rounded-lg border text-[13px] font-medium transition-colors ${
                      draft.durationMinutes === duration
                        ? "border-[#F95F4A] bg-[#F95F4A]/15 text-[#ffb2a8]"
                        : "border-white/10 bg-white/[0.03] text-[#fafafa]/65 hover:bg-white/[0.06]"
                    }`}
                  >
                    {duration}m
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium">Accept bookings</p>
                <p className="mt-0.5 text-[12px] text-[#fafafa]/45">
                  {calendarConnected
                    ? "Publish this link so people can book with calendar sync."
                    : "Publish now; Google sync can be added later."}
                </p>
              </div>
              <Switch
                label="Accept bookings"
                checked={draft.isActive}
                onChange={(checked) =>
                  setDraft((current) => ({ ...current, isActive: checked }))
                }
              />
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((value) => !value)}
                className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-[13px] font-medium text-[#fafafa]/65 transition-colors hover:text-[#fafafa]"
              >
                Advanced
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                />
              </button>
              {showAdvanced ? (
                <div className="mt-3 grid gap-4">
                  <label className="grid gap-1.5">
                    <span className={LABEL}>Link slug</span>
                    <input
                      className={FIELD}
                      value={draft.slug}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          slug: slugify(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <EditorSelect
                      label="Min. notice"
                      value={draft.minimumNoticeMinutes}
                      options={NOTICE_OPTIONS}
                      onChange={(value) =>
                        setDraft((current) => ({ ...current, minimumNoticeMinutes: value }))
                      }
                    />
                    <EditorSelect
                      label="Booking window"
                      value={draft.bookingWindowDays}
                      options={WINDOW_OPTIONS}
                      onChange={(value) =>
                        setDraft((current) => ({ ...current, bookingWindowDays: value }))
                      }
                    />
                    <EditorSelect
                      label="Buffer before"
                      value={draft.bufferBeforeMinutes}
                      options={BUFFER_OPTIONS}
                      onChange={(value) =>
                        setDraft((current) => ({ ...current, bufferBeforeMinutes: value }))
                      }
                    />
                    <EditorSelect
                      label="Buffer after"
                      value={draft.bufferAfterMinutes}
                      options={BUFFER_OPTIONS}
                      onChange={(value) =>
                        setDraft((current) => ({ ...current, bufferAfterMinutes: value }))
                      }
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={() =>
              onSave({
                title: draft.title,
                slug: draft.slug,
                description: draft.description,
                durationMinutes: draft.durationMinutes,
                minimumNoticeMinutes: draft.minimumNoticeMinutes,
                bookingWindowDays: draft.bookingWindowDays,
                bufferBeforeMinutes: draft.bufferBeforeMinutes,
                bufferAfterMinutes: draft.bufferAfterMinutes,
                isActive: draft.isActive,
              })
            }
            disabled={working}
            className={`${PRIMARY} h-11 flex-1`}
          >
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save changes
          </button>
          <button
            type="button"
            onClick={onDelete}
            className={`${ICON_BTN} h-11 w-11`}
            aria-label="Delete event type"
            title="Delete event type"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </section>
    </div>
  );
}

function EditorSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: ReadonlyArray<readonly [number, string]>;
  onChange: (value: number) => void;
}) {
  const known = options.some(([option]) => option === value);
  return (
    <label className="grid gap-1.5">
      <span className={LABEL}>{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className={SELECT}
        >
          {!known ? (
            <option value={value} className="bg-[#111114]">
              {value}
            </option>
          ) : null}
          {options.map(([option, optionLabel]) => (
            <option key={option} value={option} className="bg-[#111114]">
              {optionLabel}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#fafafa]/35" />
      </div>
    </label>
  );
}

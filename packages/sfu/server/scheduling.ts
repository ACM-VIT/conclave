import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type {
  AvailabilityOverride,
  AvailabilityWindow,
  AvailableSlot,
  CalendarConnectionSummary,
  ScheduledMeeting,
  SchedulingCalendarConnection,
  SchedulingEventType,
  SchedulingProfile,
  WeeklyAvailability,
} from "../types.js";
import { asArray, asRecord } from "../utilities/untrusted.js";
import { InvalidInput } from "./controlPlane/model.js";
import { canonicalizeClientId, clientNamespaceIncludes, CONCLAVE_CLIENT_ID, servedClientId } from "./clientIds.js";
import { storedTimestampOrNull } from "./storedValues.js";

const USERNAME_MAX_LENGTH = 48;
const SLUG_MAX_LENGTH = 80;
const TITLE_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 1000;
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_MINIMUM_NOTICE_MINUTES = 120;
const DEFAULT_BOOKING_WINDOW_DAYS = 60;
const MIN_EVENT_DURATION_MINUTES = 15;
const MAX_EVENT_DURATION_MINUTES = 240;
const MAX_BUFFER_MINUTES = 240;
const MAX_BOOKING_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const GOOGLE_PROVIDER = "google" as const;

export type BusyInterval = {
  startAt: number;
  endAt: number;
};

export type GenerateAvailableSlotsOptions = {
  eventType: SchedulingEventType;
  availability: WeeklyAvailability;
  busyIntervals: BusyInterval[];
  from: number;
  to: number;
  now?: number;
  timeZone?: string;
};

export type ProfileIdentity = {
  clientId: string;
  userId: string;
  email: string;
  name?: string | null;
  timeZone?: string;
};

export type ProfileUpdate = { name?: string; username?: string; timeZone?: string };

export type CalendarGrantInput = {
  email?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: number | null;
  scopes?: string[];
};

export type CalendarTokenPatch = {
  accessToken?: string | null;
  accessTokenExpiresAt?: number | null;
  status?: SchedulingCalendarConnection["status"];
  error?: string | null;
};

const sanitizeSlug = (value: string, fallback = ""): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
  return normalized || fallback;
};

export const isValidSchedulingSlug = (value: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value);

const sanitizeUsername = (
  value: string | undefined,
  fallbackEmail: string,
  fallbackUserId: string,
): string => {
  const emailStem = fallbackEmail.split("@")[0] || fallbackUserId;
  const candidate = value?.trim() || emailStem || fallbackUserId;
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, USERNAME_MAX_LENGTH);
  return normalized || `host-${fallbackUserId.slice(0, 10).toLowerCase()}`;
};

const sanitizeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
};

const clampInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const finiteOr = (value: unknown, fallback: number): number => storedTimestampOrNull(value) ?? fallback;

const getDefaultTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const normalizeTimeZone = (value: unknown, fallback = getDefaultTimeZone()): string => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).format();
    return value.trim();
  } catch {
    return fallback;
  }
};

export const defaultWeeklyAvailability = (
  timeZone: string,
  updatedAt: number,
): WeeklyAvailability => ({
  timeZone,
  windows: [1, 2, 3, 4, 5].map((day) => ({
    day: day as AvailabilityWindow["day"],
    startMinutes: 9 * 60,
    endMinutes: 17 * 60,
  })),
  overrides: [],
  updatedAt,
});

const normalizeAvailabilityWindow = (
  window: unknown,
): AvailabilityWindow | null => {
  const record = asRecord(window);
  const day = Number(record.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  const startMinutes = clampInteger(record.startMinutes, 9 * 60, 0, 24 * 60);
  const endMinutes = clampInteger(record.endMinutes, 17 * 60, 0, 24 * 60);
  if (endMinutes <= startMinutes) return null;
  return {
    day: day as AvailabilityWindow["day"],
    startMinutes,
    endMinutes,
  };
};

const normalizeAvailabilityOverride = (
  override: unknown,
): AvailabilityOverride | null => {
  const record = asRecord(override);
  const date = sanitizeText(record.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const unavailable = Boolean(record.unavailable);
  const windows = (asArray(record.windows) ?? [])
    .map((entry) => {
      const window = asRecord(entry);
      const normalized = normalizeAvailabilityWindow({
        day: 1,
        startMinutes: window.startMinutes,
        endMinutes: window.endMinutes,
      });
      return normalized
        ? {
            startMinutes: normalized.startMinutes,
            endMinutes: normalized.endMinutes,
          }
        : null;
    })
    .filter(
      (window): window is { startMinutes: number; endMinutes: number } =>
        Boolean(window),
    );
  return { date, windows, unavailable };
};

export const normalizeWeeklyAvailability = (
  value: unknown,
  fallbackTimeZone: string,
  fallbackUpdatedAt: number,
): WeeklyAvailability => {
  const record = asRecord(value);
  const timeZone = normalizeTimeZone(record.timeZone, fallbackTimeZone);
  const windows = (asArray(record.windows) ?? [])
    .map((window) => normalizeAvailabilityWindow(window))
    .filter((window): window is AvailabilityWindow => Boolean(window));
  const overrides = (asArray(record.overrides) ?? [])
    .map((override) => normalizeAvailabilityOverride(override))
    .filter((override): override is AvailabilityOverride => Boolean(override));
  return {
    timeZone,
    windows: windows.length
      ? windows
      : defaultWeeklyAvailability(timeZone, fallbackUpdatedAt).windows,
    overrides,
    updatedAt: finiteOr(record.updatedAt, fallbackUpdatedAt),
  };
};

export const firstFreeCandidate = (
  requested: string,
  maxLength: number,
  isTaken: (candidate: string) => boolean,
): string => {
  let candidate = requested;
  let suffix = 2;
  while (isTaken(candidate)) {
    const base = requested.slice(0, Math.max(1, maxLength - 4));
    candidate = `${base}-${suffix}`.slice(0, maxLength);
    suffix += 1;
  }
  return candidate;
};

export const requestedUsername = (
  username: string | undefined,
  email: string,
  userId: string,
): string => sanitizeUsername(username, email, userId);

export const uniqueUsername = (
  requested: string,
  isTaken: (candidate: string) => boolean,
): string => firstFreeCandidate(requested, USERNAME_MAX_LENGTH, isTaken);

export const uniqueEventSlug = (
  requested: string,
  isTaken: (candidate: string) => boolean,
): string => firstFreeCandidate(requested, SLUG_MAX_LENGTH, isTaken);

export const newSchedulingProfile = (
  identity: ProfileIdentity,
  options: { id: string; username: string; now: number },
): SchedulingProfile => ({
  id: options.id,
  clientId: canonicalizeClientId(identity.clientId),
  userId: identity.userId,
  email: identity.email.trim().toLowerCase(),
  name: sanitizeText(identity.name ?? "", TITLE_MAX_LENGTH) || identity.email,
  username: options.username,
  timeZone: normalizeTimeZone(identity.timeZone),
  createdAt: options.now,
  updatedAt: options.now,
});

export const syncProfileIdentity = (
  profile: SchedulingProfile,
  identity: ProfileIdentity,
  now: number,
): SchedulingProfile | null => {
  const email = identity.email.trim().toLowerCase();
  if (email === profile.email) return null;
  return { ...profile, email, updatedAt: now };
};

export const applyProfileUpdate = (
  profile: SchedulingProfile,
  updates: ProfileUpdate,
  options: { now: number; isUsernameTaken: (candidate: string) => boolean },
): SchedulingProfile => {
  const next = { ...profile };
  if (updates.name !== undefined) {
    const name = sanitizeText(updates.name, TITLE_MAX_LENGTH);
    if (!name) throw new InvalidInput("Name is required.");
    next.name = name;
  }
  if (updates.username !== undefined) {
    const requested = sanitizeUsername(updates.username, profile.email, profile.userId);
    if (requested !== profile.username) {
      next.username = uniqueUsername(requested, options.isUsernameTaken);
    }
  }
  if (updates.timeZone !== undefined) {
    next.timeZone = normalizeTimeZone(updates.timeZone, profile.timeZone);
  }
  next.updatedAt = options.now;
  return next;
};

export const parseWeeklyAvailability = (
  input: unknown,
  profile: SchedulingProfile,
  now: number,
): WeeklyAvailability => ({
  ...normalizeWeeklyAvailability(input, profile.timeZone, now),
  updatedAt: now,
});

export const newEventType = (
  profile: SchedulingProfile,
  input: Partial<SchedulingEventType>,
  options: { id: string; now: number; isSlugTaken: (candidate: string) => boolean },
): SchedulingEventType => {
  const title = sanitizeText(input.title, TITLE_MAX_LENGTH) || "30 min intro";
  const requestedSlug = sanitizeSlug(String(input.slug || title), "30-min-intro");
  return {
    id: options.id,
    clientId: profile.clientId,
    profileId: profile.id,
    userId: profile.userId,
    slug: uniqueEventSlug(requestedSlug, options.isSlugTaken),
    title,
    description: sanitizeText(input.description, DESCRIPTION_MAX_LENGTH),
    durationMinutes: clampInteger(
      input.durationMinutes,
      DEFAULT_DURATION_MINUTES,
      MIN_EVENT_DURATION_MINUTES,
      MAX_EVENT_DURATION_MINUTES,
    ),
    minimumNoticeMinutes: clampInteger(
      input.minimumNoticeMinutes,
      DEFAULT_MINIMUM_NOTICE_MINUTES,
      0,
      60 * 24 * 30,
    ),
    bookingWindowDays: clampInteger(
      input.bookingWindowDays,
      DEFAULT_BOOKING_WINDOW_DAYS,
      1,
      MAX_BOOKING_WINDOW_DAYS,
    ),
    bufferBeforeMinutes: clampInteger(input.bufferBeforeMinutes, 0, 0, MAX_BUFFER_MINUTES),
    bufferAfterMinutes: clampInteger(input.bufferAfterMinutes, 0, 0, MAX_BUFFER_MINUTES),
    isActive: Boolean(input.isActive),
    requiresCalendar: Boolean(input.requiresCalendar),
    createdAt: options.now,
    updatedAt: options.now,
  };
};

export const applyEventTypeInput = (
  eventType: SchedulingEventType,
  input: Partial<SchedulingEventType>,
  options: { now: number; isSlugTaken: (candidate: string) => boolean },
): SchedulingEventType => {
  const next = { ...eventType };
  if (input.title !== undefined) {
    const title = sanitizeText(input.title, TITLE_MAX_LENGTH);
    if (!title) throw new InvalidInput("Title is required.");
    next.title = title;
  }
  if (input.slug !== undefined) {
    const slug = sanitizeSlug(String(input.slug), eventType.slug);
    if (!isValidSchedulingSlug(slug)) throw new InvalidInput("Invalid event slug.");
    if (slug !== eventType.slug) {
      next.slug = uniqueEventSlug(slug, options.isSlugTaken);
    }
  }
  if (input.description !== undefined) {
    next.description = sanitizeText(input.description, DESCRIPTION_MAX_LENGTH);
  }
  if (input.durationMinutes !== undefined) {
    next.durationMinutes = clampInteger(
      input.durationMinutes,
      eventType.durationMinutes,
      MIN_EVENT_DURATION_MINUTES,
      MAX_EVENT_DURATION_MINUTES,
    );
  }
  if (input.minimumNoticeMinutes !== undefined) {
    next.minimumNoticeMinutes = clampInteger(
      input.minimumNoticeMinutes,
      eventType.minimumNoticeMinutes,
      0,
      60 * 24 * 30,
    );
  }
  if (input.bookingWindowDays !== undefined) {
    next.bookingWindowDays = clampInteger(
      input.bookingWindowDays,
      eventType.bookingWindowDays,
      1,
      MAX_BOOKING_WINDOW_DAYS,
    );
  }
  if (input.bufferBeforeMinutes !== undefined) {
    next.bufferBeforeMinutes = clampInteger(
      input.bufferBeforeMinutes,
      eventType.bufferBeforeMinutes,
      0,
      MAX_BUFFER_MINUTES,
    );
  }
  if (input.bufferAfterMinutes !== undefined) {
    next.bufferAfterMinutes = clampInteger(
      input.bufferAfterMinutes,
      eventType.bufferAfterMinutes,
      0,
      MAX_BUFFER_MINUTES,
    );
  }
  if (input.isActive !== undefined) {
    next.isActive = Boolean(input.isActive);
  }
  if (input.requiresCalendar !== undefined) {
    next.requiresCalendar = Boolean(input.requiresCalendar);
  }
  next.updatedAt = options.now;
  return next;
};

export const calendarSummary = (
  connection: SchedulingCalendarConnection | null,
): CalendarConnectionSummary => {
  if (!connection) {
    return {
      provider: GOOGLE_PROVIDER,
      status: "not_connected",
      email: null,
      calendarId: "primary",
      connectedAt: null,
      updatedAt: null,
      error: null,
    };
  }
  const status =
    connection.status === "connected" && !connection.refreshToken
      ? "needs_reconnect"
      : connection.status;
  return {
    provider: GOOGLE_PROVIDER,
    status,
    email: connection.email,
    calendarId: connection.calendarId,
    connectedAt: connection.connectedAt,
    updatedAt: connection.updatedAt,
    error: connection.error,
  };
};

export const isCalendarUsable = (
  connection: SchedulingCalendarConnection | null,
): connection is SchedulingCalendarConnection =>
  Boolean(connection?.grantId && connection.status === "connected" && connection.refreshToken);

export const connectGoogleCalendar = (
  profile: SchedulingProfile,
  existing: SchedulingCalendarConnection | null,
  input: CalendarGrantInput,
  options: { id: string; grantId: string; now: number },
): SchedulingCalendarConnection => ({
  id: existing?.id ?? options.id,
  grantId: options.grantId,
  clientId: profile.clientId,
  profileId: profile.id,
  userId: profile.userId,
  provider: GOOGLE_PROVIDER,
  status: "connected",
  email: input.email?.trim().toLowerCase() || existing?.email || profile.email,
  calendarId: existing?.calendarId ?? "primary",
  accessToken: input.accessToken ?? existing?.accessToken ?? null,
  refreshToken: input.refreshToken ?? existing?.refreshToken ?? null,
  accessTokenExpiresAt:
    input.accessTokenExpiresAt ?? existing?.accessTokenExpiresAt ?? null,
  scopes: input.scopes ?? existing?.scopes ?? [],
  connectedAt: existing?.connectedAt ?? options.now,
  updatedAt: options.now,
  error: null,
});

export const patchCalendarConnection = (
  connection: SchedulingCalendarConnection,
  patch: CalendarTokenPatch,
  now: number,
): SchedulingCalendarConnection => ({
  ...connection,
  ...(patch.accessToken !== undefined ? { accessToken: patch.accessToken } : {}),
  ...(patch.accessTokenExpiresAt !== undefined
    ? { accessTokenExpiresAt: patch.accessTokenExpiresAt }
    : {}),
  ...(patch.status !== undefined ? { status: patch.status } : {}),
  ...(patch.error !== undefined
    ? { error: patch.error ? sanitizeText(patch.error, 512) : null }
    : {}),
  updatedAt: now,
});

const meetingHasHost = (
  meeting: ScheduledMeeting,
  profile: SchedulingProfile,
): boolean => {
  if (meeting.hostUserId && profile.userId) {
    return meeting.hostUserId === profile.userId;
  }
  return meeting.hostEmail.trim().toLowerCase() === profile.email.trim().toLowerCase();
};

export const meetingMatchesProfile = (
  meeting: ScheduledMeeting,
  profile: SchedulingProfile,
  eventType?: SchedulingEventType | null,
): boolean =>
  clientNamespaceIncludes(profile.clientId, meeting.clientId) &&
  (eventType?.profileId === profile.id || meetingHasHost(meeting, profile));

export const internalBusyIntervals = (
  meetings: readonly ScheduledMeeting[],
  eventTypeOf: (id: string) => SchedulingEventType | null,
  profile: SchedulingProfile,
  from: number,
  to: number,
): BusyInterval[] => {
  const hostNamespace = servedClientId(profile.clientId);
  return meetings
    .filter((meeting) =>
      meeting.status !== "cancelled" &&
      meeting.status !== "ended" &&
      servedClientId(meeting.clientId) === hostNamespace &&
      meetingHasHost(meeting, profile),
    )
    .map((meeting) => {
      const candidate = meeting.eventTypeId ? eventTypeOf(meeting.eventTypeId) : null;
      const eventType = candidate && servedClientId(candidate.clientId) === hostNamespace ? candidate : null;
      return {
        startAt:
          meeting.scheduledStartAt - (eventType?.bufferBeforeMinutes ?? 0) * MINUTE_MS,
        endAt: meeting.scheduledEndAt + (eventType?.bufferAfterMinutes ?? 0) * MINUTE_MS,
      };
    })
    .filter(({ startAt, endAt }) => startAt < to && from < endAt);
};

export const bookingBlocksInterval = (
  eventType: SchedulingEventType,
  startAt: number,
  endAt: number,
): BusyInterval => ({
  startAt: startAt - eventType.bufferBeforeMinutes * MINUTE_MS,
  endAt: endAt + eventType.bufferAfterMinutes * MINUTE_MS,
});

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

const getDateFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = dateFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  dateFormatterCache.set(timeZone, formatter);
  return formatter;
};

const getZonedParts = (
  timestamp: number,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} => {
  const parts = getDateFormatter(timeZone).formatToParts(new Date(timestamp));
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = value("hour");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: hour === 24 ? 0 : hour,
    minute: value("minute"),
    second: value("second"),
  };
};

const getTimeZoneOffsetMs = (timestamp: number, timeZone: string): number => {
  const parts = getZonedParts(timestamp, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - timestamp;
};

export const zonedTimeToUtc = (
  date: string,
  minutes: number,
  timeZone: string,
): number => {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const localTimestamp = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const target = new Date(localTimestamp);
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth() + 1;
  const targetDay = target.getUTCDate();
  const targetHour = target.getUTCHours();
  const targetMinute = target.getUTCMinutes();
  const matchesTarget = (timestamp: number): boolean => {
    const parts = getZonedParts(timestamp, timeZone);
    return (
      parts.year === targetYear &&
      parts.month === targetMonth &&
      parts.day === targetDay &&
      parts.hour === targetHour &&
      parts.minute === targetMinute &&
      parts.second === 0
    );
  };
  const sampleOffsets = [-36, -24, -12, 0, 12, 24, 36].map((hours) =>
    getTimeZoneOffsetMs(localTimestamp + hours * 60 * 60 * 1000, timeZone),
  );
  const matches = Array.from(new Set(sampleOffsets))
    .map((offset) => localTimestamp - offset)
    .filter(matchesTarget)
    .sort((a, b) => a - b);

  // Fold policy: choose the later occurrence of repeated fall-back wall times.
  return matches.at(-1) ?? Number.NaN;
};

const localDateKey = (timestamp: number, timeZone: string): string => {
  const parts = getZonedParts(timestamp, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
};

const addDaysToDateKey = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(next.getUTCDate()).padStart(2, "0")}`;
};

const weekdayForDateKey = (date: string): AvailabilityWindow["day"] => {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as AvailabilityWindow["day"];
};

const overlaps = (a: BusyInterval, b: BusyInterval): boolean =>
  a.startAt < b.endAt && b.startAt < a.endAt;

const windowsForDate = (
  availability: WeeklyAvailability,
  date: string,
): Array<{ startMinutes: number; endMinutes: number }> => {
  const override = availability.overrides.find((entry) => entry.date === date);
  if (override) return override.unavailable ? [] : override.windows;
  const weekday = weekdayForDateKey(date);
  return availability.windows
    .filter((window) => window.day === weekday)
    .map((window) => ({
      startMinutes: window.startMinutes,
      endMinutes: window.endMinutes,
    }));
};

export const generateAvailableSlots = ({
  eventType,
  availability,
  busyIntervals,
  from,
  to,
  now = Date.now(),
  timeZone = availability.timeZone,
}: GenerateAvailableSlotsOptions): AvailableSlot[] => {
  const durationMs = eventType.durationMinutes * MINUTE_MS;
  const bufferBeforeMs = eventType.bufferBeforeMinutes * MINUTE_MS;
  const bufferAfterMs = eventType.bufferAfterMinutes * MINUTE_MS;
  const minStart = Math.max(from, now + eventType.minimumNoticeMinutes * MINUTE_MS);
  const maxEnd = Math.min(to, now + eventType.bookingWindowDays * DAY_MS);
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) {
    return [];
  }

  const slots: AvailableSlot[] = [];
  let date = localDateKey(minStart, timeZone);
  const endDate = localDateKey(maxEnd, timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });

  while (date <= endDate) {
    for (const window of windowsForDate(availability, date)) {
      const windowStart = zonedTimeToUtc(date, window.startMinutes, timeZone);
      const windowEnd = zonedTimeToUtc(date, window.endMinutes, timeZone);
      if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) continue;
      for (
        let startMinutes = window.startMinutes;
        startMinutes + eventType.durationMinutes <= window.endMinutes;
        startMinutes += eventType.durationMinutes
      ) {
        const startAt = zonedTimeToUtc(date, startMinutes, timeZone);
        const endAt = zonedTimeToUtc(
          date,
          startMinutes + eventType.durationMinutes,
          timeZone,
        );
        if (
          !Number.isFinite(startAt) ||
          !Number.isFinite(endAt) ||
          endAt - startAt !== durationMs
        ) {
          continue;
        }
        if (startAt < minStart || endAt > maxEnd) continue;
        const blockedInterval = {
          startAt: startAt - bufferBeforeMs,
          endAt: endAt + bufferAfterMs,
        };
        const isBusy = busyIntervals.some((busy) =>
          overlaps(blockedInterval, busy),
        );
        if (!isBusy) {
          slots.push({
            startAt,
            endAt,
            label: formatter.format(new Date(startAt)),
          });
        }
      }
    }
    date = addDaysToDateKey(date, 1);
  }

  return slots.sort((a, b) => a.startAt - b.startAt);
};

const encryptionKey = (): Buffer =>
  createHash("sha256")
    .update(
      process.env.SCHEDULING_TOKEN_SECRET ||
        process.env.SFU_SECRET ||
        "development-scheduling-token-secret",
    )
    .digest();

const encryptToken = (token: string | null): string | null => {
  if (!token) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
};

const decryptToken = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  if (!value.startsWith("v1:")) return value;
  const [, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivRaw, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};

const storedClientId = (clientId: unknown): string =>
  typeof clientId === "string" && clientId.trim()
    ? canonicalizeClientId(clientId)
    : CONCLAVE_CLIENT_ID;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const stamps = (
  record: Readonly<Record<string, unknown>>,
  fallback: number,
): { createdAt: number; updatedAt: number } => {
  const updatedAt = finiteOr(record.updatedAt, Number.NaN);
  const createdAt = finiteOr(record.createdAt, Number.isFinite(updatedAt) ? updatedAt : fallback);
  return { createdAt, updatedAt: Number.isFinite(updatedAt) ? updatedAt : createdAt };
};

export const normalizeStoredProfile = (raw: unknown): SchedulingProfile | null => {
  const record = asRecord(raw);
  const id = nonEmptyString(record.id);
  const userId = nonEmptyString(record.userId);
  if (!id || !userId) return null;
  const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
  const username =
    typeof record.username === "string" && record.username
      ? record.username
      : sanitizeUsername(undefined, email, userId);
  return {
    id,
    clientId: storedClientId(record.clientId),
    userId,
    email,
    name: typeof record.name === "string" ? record.name : email,
    username,
    timeZone: normalizeTimeZone(record.timeZone, "UTC"),
    ...stamps(record, 0),
  };
};

export const normalizeStoredHours = (
  raw: unknown,
  fallback: { timeZone: string; updatedAt: number } = { timeZone: "UTC", updatedAt: 0 },
): { profileId: string; availability: WeeklyAvailability } | null => {
  const record = asRecord(raw);
  const profileId = nonEmptyString(record.profileId);
  if (!profileId) return null;
  return {
    profileId,
    availability: normalizeWeeklyAvailability(
      record.availability,
      fallback.timeZone,
      fallback.updatedAt,
    ),
  };
};

export const normalizeStoredEventType = (raw: unknown): SchedulingEventType | null => {
  const record = asRecord(raw);
  const id = nonEmptyString(record.id);
  const profileId = nonEmptyString(record.profileId);
  const slug = nonEmptyString(record.slug);
  if (!id || !profileId || !slug) return null;
  return {
    id,
    clientId: storedClientId(record.clientId),
    profileId,
    userId: typeof record.userId === "string" ? record.userId : "",
    slug,
    title: typeof record.title === "string" && record.title ? record.title : "30 min intro",
    description: typeof record.description === "string" ? record.description : "",
    durationMinutes: clampInteger(
      record.durationMinutes,
      DEFAULT_DURATION_MINUTES,
      MIN_EVENT_DURATION_MINUTES,
      MAX_EVENT_DURATION_MINUTES,
    ),
    minimumNoticeMinutes: clampInteger(
      record.minimumNoticeMinutes,
      DEFAULT_MINIMUM_NOTICE_MINUTES,
      0,
      60 * 24 * 30,
    ),
    bookingWindowDays: clampInteger(
      record.bookingWindowDays,
      DEFAULT_BOOKING_WINDOW_DAYS,
      1,
      MAX_BOOKING_WINDOW_DAYS,
    ),
    bufferBeforeMinutes: clampInteger(record.bufferBeforeMinutes, 0, 0, MAX_BUFFER_MINUTES),
    bufferAfterMinutes: clampInteger(record.bufferAfterMinutes, 0, 0, MAX_BUFFER_MINUTES),
    isActive: record.isActive === true,
    requiresCalendar: record.requiresCalendar === true,
    ...stamps(record, 0),
  };
};

const CALENDAR_STATUSES: ReadonlySet<string> = new Set([
  "not_connected",
  "connected",
  "needs_reconnect",
  "error",
]);

const LEGACY_GRANT_PREFIX = "legacy-grant:";

export const usesImportedCalendarGrant = (connection: SchedulingCalendarConnection): boolean =>
  connection.grantId.startsWith(LEGACY_GRANT_PREFIX);

export const normalizeStoredCalendar = (
  raw: unknown,
): SchedulingCalendarConnection | null => {
  const record = asRecord(raw);
  const id = nonEmptyString(record.id);
  const profileId = nonEmptyString(record.profileId);
  if (!id || !profileId) return null;
  const connectedAt = finiteOr(record.connectedAt, finiteOr(record.updatedAt, 0));
  const status =
    typeof record.status === "string" && CALENDAR_STATUSES.has(record.status)
      ? (record.status as SchedulingCalendarConnection["status"])
      : "needs_reconnect";
  const clientId = storedClientId(record.clientId);
  const email = nonEmptyString(record.email)?.trim().toLowerCase() || null;
  const calendarId = nonEmptyString(record.calendarId) ?? "primary";
  const refreshToken = decryptToken(record.refreshToken);
  const grantId = nonEmptyString(record.grantId) ?? (refreshToken
    ? LEGACY_GRANT_PREFIX + createHmac("sha256", encryptionKey())
      .update(JSON.stringify([LEGACY_GRANT_PREFIX, clientId, profileId, id, email, calendarId, refreshToken]))
      .digest("base64url")
    : "");
  return {
    id,
    grantId,
    clientId,
    profileId,
    userId: typeof record.userId === "string" ? record.userId : "",
    provider: GOOGLE_PROVIDER,
    status,
    email,
    calendarId,
    accessToken: decryptToken(record.accessToken),
    refreshToken,
    accessTokenExpiresAt: storedTimestampOrNull(record.accessTokenExpiresAt),
    scopes: (asArray(record.scopes) ?? []).filter(
      (scope): scope is string => typeof scope === "string",
    ),
    connectedAt,
    updatedAt: finiteOr(record.updatedAt, connectedAt),
    error: typeof record.error === "string" ? record.error : null,
  };
};

export const encodeStoredCalendar = (
  calendar: SchedulingCalendarConnection,
): SchedulingCalendarConnection => ({
  ...calendar,
  accessToken: encryptToken(calendar.accessToken),
  refreshToken: encryptToken(calendar.refreshToken),
});

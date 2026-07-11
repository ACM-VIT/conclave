import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type {
  AvailabilityOverride,
  AvailabilityWindow,
  AvailableSlot,
  CalendarConnectionSummary,
  SchedulingCalendarConnection,
  SchedulingEventType,
  SchedulingProfile,
  WeeklyAvailability,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import { asArray, asRecord } from "../utilities/untrusted.js";
import {
  createRedisPersistenceClient,
  resolveRedisPersistenceKeyPrefix,
  resolveRedisPersistenceUrl,
  shouldUseRedisPersistence,
  type RedisPersistenceClient,
} from "./redisPersistence.js";
import {
  canonicalizeClientId,
  CONCLAVE_CLIENT_ID,
} from "./clientIds.js";

type MaybePromise<T> = T | Promise<T>;

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

export type SchedulingStore = {
  profilesById: Map<string, SchedulingProfile>;
  profileIdByUserKey: Map<string, string>;
  profileIdByUsername: Map<string, string>;
  availabilityByProfileId: Map<string, WeeklyAvailability>;
  eventTypesById: Map<string, SchedulingEventType>;
  eventTypeIdByProfileSlug: Map<string, string>;
  calendarByProfileId: Map<string, SchedulingCalendarConnection>;
};

type SchedulingSnapshot = {
  profiles: SchedulingProfile[];
  availability: Array<{ profileId: string; availability: WeeklyAvailability }>;
  eventTypes: SchedulingEventType[];
  calendars: SchedulingCalendarConnection[];
};

export type SchedulingPersistence = {
  save: (snapshot: SchedulingSnapshot) => MaybePromise<void>;
  load: () => MaybePromise<SchedulingSnapshot>;
  close?: () => MaybePromise<void>;
  flush?: () => Promise<void>;
};

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

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

export const createSchedulingStore = (): SchedulingStore => ({
  profilesById: new Map(),
  profileIdByUserKey: new Map(),
  profileIdByUsername: new Map(),
  availabilityByProfileId: new Map(),
  eventTypesById: new Map(),
  eventTypeIdByProfileSlug: new Map(),
  calendarByProfileId: new Map(),
});

const userKey = (clientId: string, userId: string): string =>
  `${clientId}:${userId}`;

const profileSlugKey = (profileId: string, slug: string): string =>
  `${profileId}:${slug}`;

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

const defaultWeeklyAvailability = (
  timeZone = getDefaultTimeZone(),
): WeeklyAvailability => ({
  timeZone,
  windows: [1, 2, 3, 4, 5].map((day) => ({
    day: day as AvailabilityWindow["day"],
    startMinutes: 9 * 60,
    endMinutes: 17 * 60,
  })),
  overrides: [],
  updatedAt: Date.now(),
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

const normalizeWeeklyAvailability = (
  value: unknown,
  fallbackTimeZone = getDefaultTimeZone(),
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
    windows: windows.length ? windows : defaultWeeklyAvailability(timeZone).windows,
    overrides,
    updatedAt: Number.isFinite(Number(record.updatedAt))
      ? Number(record.updatedAt)
      : Date.now(),
  };
};

const registerProfile = (
  store: SchedulingStore,
  profile: SchedulingProfile,
): void => {
  store.profilesById.set(profile.id, profile);
  store.profileIdByUserKey.set(userKey(profile.clientId, profile.userId), profile.id);
  store.profileIdByUsername.set(
    `${profile.clientId}:${profile.username.toLowerCase()}`,
    profile.id,
  );
};

const registerEventType = (
  store: SchedulingStore,
  eventType: SchedulingEventType,
): void => {
  store.eventTypesById.set(eventType.id, eventType);
  store.eventTypeIdByProfileSlug.set(
    profileSlugKey(eventType.profileId, eventType.slug),
    eventType.id,
  );
};

const uniqueUsername = (
  store: SchedulingStore,
  clientId: string,
  requested: string,
  excludeProfileId?: string,
): string => {
  let candidate = requested;
  let suffix = 2;
  while (true) {
    const owner = store.profileIdByUsername.get(`${clientId}:${candidate}`);
    if (!owner || owner === excludeProfileId) return candidate;
    const base = requested.slice(0, Math.max(1, USERNAME_MAX_LENGTH - 4));
    candidate = `${base}-${suffix}`.slice(0, USERNAME_MAX_LENGTH);
    suffix += 1;
  }
};

const uniqueEventSlug = (
  store: SchedulingStore,
  profileId: string,
  requested: string,
  excludeEventTypeId?: string,
): string => {
  let candidate = requested;
  let suffix = 2;
  while (true) {
    const owner = store.eventTypeIdByProfileSlug.get(
      profileSlugKey(profileId, candidate),
    );
    if (!owner || owner === excludeEventTypeId) return candidate;
    const base = requested.slice(0, Math.max(1, SLUG_MAX_LENGTH - 4));
    candidate = `${base}-${suffix}`.slice(0, SLUG_MAX_LENGTH);
    suffix += 1;
  }
};

export const ensureSchedulingProfile = (
  store: SchedulingStore,
  input: {
    clientId: string;
    userId: string;
    email: string;
    name?: string | null;
    username?: string;
    timeZone?: string;
  },
): SchedulingProfile => {
  const clientId = canonicalizeClientId(input.clientId);
  const key = userKey(clientId, input.userId);
  const existingId = store.profileIdByUserKey.get(key);
  const existing = existingId ? store.profilesById.get(existingId) : undefined;
  const now = Date.now();
  if (existing) {
    existing.email = input.email.trim().toLowerCase();
    existing.name = sanitizeText(input.name ?? "", TITLE_MAX_LENGTH) || existing.name;
    if (input.username) {
      const requested = sanitizeUsername(input.username, input.email, input.userId);
      if (requested !== existing.username) {
        store.profileIdByUsername.delete(
          `${existing.clientId}:${existing.username.toLowerCase()}`,
        );
        existing.username = uniqueUsername(
          store,
          existing.clientId,
          requested,
          existing.id,
        );
      }
    }
    if (input.timeZone) {
      existing.timeZone = normalizeTimeZone(input.timeZone, existing.timeZone);
    }
    existing.updatedAt = now;
    registerProfile(store, existing);
    if (!store.availabilityByProfileId.has(existing.id)) {
      store.availabilityByProfileId.set(
        existing.id,
        defaultWeeklyAvailability(existing.timeZone),
      );
    }
    return existing;
  }

  const baseUsername = sanitizeUsername(
    input.username,
    input.email,
    input.userId,
  );
  const profile: SchedulingProfile = {
    id: randomUUID(),
    clientId,
    userId: input.userId,
    email: input.email.trim().toLowerCase(),
    name: sanitizeText(input.name ?? "", TITLE_MAX_LENGTH) || input.email,
    username: uniqueUsername(store, clientId, baseUsername),
    timeZone: normalizeTimeZone(input.timeZone),
    createdAt: now,
    updatedAt: now,
  };
  registerProfile(store, profile);
  store.availabilityByProfileId.set(
    profile.id,
    defaultWeeklyAvailability(profile.timeZone),
  );
  return profile;
};

export const updateSchedulingProfile = (
  store: SchedulingStore,
  profileId: string,
  updates: { name?: string; username?: string; timeZone?: string },
): SchedulingProfile => {
  const profile = store.profilesById.get(profileId);
  if (!profile) throw new Error("Scheduling profile not found.");
  if (updates.name !== undefined) {
    const name = sanitizeText(updates.name, TITLE_MAX_LENGTH);
    if (!name) throw new Error("Name is required.");
    profile.name = name;
  }
  if (updates.username !== undefined) {
    const nextUsername = sanitizeUsername(
      updates.username,
      profile.email,
      profile.userId,
    );
    if (nextUsername !== profile.username) {
      store.profileIdByUsername.delete(
        `${profile.clientId}:${profile.username.toLowerCase()}`,
      );
      profile.username = uniqueUsername(
        store,
        profile.clientId,
        nextUsername,
        profile.id,
      );
    }
  }
  if (updates.timeZone !== undefined) {
    profile.timeZone = normalizeTimeZone(updates.timeZone, profile.timeZone);
  }
  profile.updatedAt = Date.now();
  registerProfile(store, profile);
  return profile;
};

export const getProfileByUser = (
  store: SchedulingStore,
  clientId: string,
  userId: string,
): SchedulingProfile | null => {
  const id = store.profileIdByUserKey.get(
    userKey(canonicalizeClientId(clientId), userId),
  );
  return id ? store.profilesById.get(id) ?? null : null;
};

export const moveSchedulingProfileToClient = (
  store: SchedulingStore,
  profile: SchedulingProfile,
  clientId: string,
): SchedulingProfile => {
  const nextClientId = canonicalizeClientId(clientId);
  if (!nextClientId || profile.clientId === nextClientId) return profile;

  store.profileIdByUserKey.delete(userKey(profile.clientId, profile.userId));
  store.profileIdByUsername.delete(
    `${profile.clientId}:${profile.username.toLowerCase()}`,
  );

  profile.clientId = nextClientId;
  profile.username = uniqueUsername(store, nextClientId, profile.username, profile.id);
  profile.updatedAt = Date.now();
  registerProfile(store, profile);

  for (const eventType of store.eventTypesById.values()) {
    if (eventType.profileId !== profile.id) continue;
    eventType.clientId = nextClientId;
    eventType.updatedAt = profile.updatedAt;
    registerEventType(store, eventType);
  }

  const calendar = store.calendarByProfileId.get(profile.id);
  if (calendar) {
    calendar.clientId = nextClientId;
    calendar.updatedAt = profile.updatedAt;
  }

  return profile;
};

export const getPublicProfile = (
  store: SchedulingStore,
  clientId: string,
  username: string,
): SchedulingProfile | null => {
  const id = store.profileIdByUsername.get(
    `${canonicalizeClientId(clientId)}:${username.trim().toLowerCase()}`,
  );
  return id ? store.profilesById.get(id) ?? null : null;
};

export const getProfileAvailability = (
  store: SchedulingStore,
  profile: SchedulingProfile,
): WeeklyAvailability =>
  store.availabilityByProfileId.get(profile.id) ??
  defaultWeeklyAvailability(profile.timeZone);

export const setProfileAvailability = (
  store: SchedulingStore,
  profile: SchedulingProfile,
  availability: unknown,
): WeeklyAvailability => {
  const normalized = normalizeWeeklyAvailability(
    availability,
    profile.timeZone,
  );
  normalized.updatedAt = Date.now();
  store.availabilityByProfileId.set(profile.id, normalized);
  profile.timeZone = normalized.timeZone;
  profile.updatedAt = Date.now();
  registerProfile(store, profile);
  return normalized;
};

export const listEventTypes = (
  store: SchedulingStore,
  profileId: string,
): SchedulingEventType[] =>
  Array.from(store.eventTypesById.values())
    .filter((eventType) => eventType.profileId === profileId)
    .sort((a, b) => a.createdAt - b.createdAt);

export const createEventType = (
  store: SchedulingStore,
  profile: SchedulingProfile,
  input: Partial<SchedulingEventType>,
): SchedulingEventType => {
  const title = sanitizeText(input.title, TITLE_MAX_LENGTH) || "30 min intro";
  const requestedSlug = sanitizeSlug(String(input.slug || title), "30-min-intro");
  const now = Date.now();
  const eventType: SchedulingEventType = {
    id: randomUUID(),
    clientId: profile.clientId,
    profileId: profile.id,
    userId: profile.userId,
    slug: uniqueEventSlug(store, profile.id, requestedSlug),
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
    createdAt: now,
    updatedAt: now,
  };
  registerEventType(store, eventType);
  return eventType;
};

export const updateEventType = (
  store: SchedulingStore,
  profile: SchedulingProfile,
  id: string,
  input: Partial<SchedulingEventType>,
): SchedulingEventType => {
  const eventType = store.eventTypesById.get(id);
  if (!eventType || eventType.profileId !== profile.id) {
    throw new Error("Event type not found.");
  }
  if (input.title !== undefined) {
    const title = sanitizeText(input.title, TITLE_MAX_LENGTH);
    if (!title) throw new Error("Title is required.");
    eventType.title = title;
  }
  if (input.slug !== undefined) {
    const slug = sanitizeSlug(String(input.slug), eventType.slug);
    if (!isValidSchedulingSlug(slug)) throw new Error("Invalid event slug.");
    if (slug !== eventType.slug) {
      store.eventTypeIdByProfileSlug.delete(
        profileSlugKey(eventType.profileId, eventType.slug),
      );
      eventType.slug = uniqueEventSlug(store, eventType.profileId, slug, eventType.id);
    }
  }
  if (input.description !== undefined) {
    eventType.description = sanitizeText(input.description, DESCRIPTION_MAX_LENGTH);
  }
  if (input.durationMinutes !== undefined) {
    eventType.durationMinutes = clampInteger(
      input.durationMinutes,
      eventType.durationMinutes,
      MIN_EVENT_DURATION_MINUTES,
      MAX_EVENT_DURATION_MINUTES,
    );
  }
  if (input.minimumNoticeMinutes !== undefined) {
    eventType.minimumNoticeMinutes = clampInteger(
      input.minimumNoticeMinutes,
      eventType.minimumNoticeMinutes,
      0,
      60 * 24 * 30,
    );
  }
  if (input.bookingWindowDays !== undefined) {
    eventType.bookingWindowDays = clampInteger(
      input.bookingWindowDays,
      eventType.bookingWindowDays,
      1,
      MAX_BOOKING_WINDOW_DAYS,
    );
  }
  if (input.bufferBeforeMinutes !== undefined) {
    eventType.bufferBeforeMinutes = clampInteger(
      input.bufferBeforeMinutes,
      eventType.bufferBeforeMinutes,
      0,
      MAX_BUFFER_MINUTES,
    );
  }
  if (input.bufferAfterMinutes !== undefined) {
    eventType.bufferAfterMinutes = clampInteger(
      input.bufferAfterMinutes,
      eventType.bufferAfterMinutes,
      0,
      MAX_BUFFER_MINUTES,
    );
  }
  if (input.isActive !== undefined) {
    eventType.isActive = Boolean(input.isActive);
  }
  if (input.requiresCalendar !== undefined) {
    eventType.requiresCalendar = Boolean(input.requiresCalendar);
  }
  eventType.updatedAt = Date.now();
  registerEventType(store, eventType);
  return eventType;
};

export const deleteEventType = (
  store: SchedulingStore,
  profile: SchedulingProfile,
  id: string,
): SchedulingEventType | null => {
  const eventType = store.eventTypesById.get(id);
  if (!eventType || eventType.profileId !== profile.id) return null;
  store.eventTypesById.delete(id);
  store.eventTypeIdByProfileSlug.delete(profileSlugKey(profile.id, eventType.slug));
  return eventType;
};

export const getPublicEventType = (
  store: SchedulingStore,
  profile: SchedulingProfile,
  slug: string,
): SchedulingEventType | null => {
  const id = store.eventTypeIdByProfileSlug.get(
    profileSlugKey(profile.id, slug.trim().toLowerCase()),
  );
  return id ? store.eventTypesById.get(id) ?? null : null;
};

export const getCalendarSummary = (
  store: SchedulingStore,
  profileId: string,
): CalendarConnectionSummary => {
  const connection = store.calendarByProfileId.get(profileId);
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

export const setGoogleCalendarConnection = (
  store: SchedulingStore,
  profile: SchedulingProfile,
  input: {
    email?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    accessTokenExpiresAt?: number | null;
    scopes?: string[];
    status?: SchedulingCalendarConnection["status"];
    error?: string | null;
  },
): SchedulingCalendarConnection => {
  const existing = store.calendarByProfileId.get(profile.id);
  const now = Date.now();
  const connection: SchedulingCalendarConnection = {
    id: existing?.id ?? randomUUID(),
    clientId: profile.clientId,
    profileId: profile.id,
    userId: profile.userId,
    provider: GOOGLE_PROVIDER,
    status: input.status ?? "connected",
    email: input.email?.trim().toLowerCase() || existing?.email || profile.email,
    calendarId: existing?.calendarId ?? "primary",
    accessToken: input.accessToken ?? existing?.accessToken ?? null,
    refreshToken: input.refreshToken ?? existing?.refreshToken ?? null,
    accessTokenExpiresAt:
      input.accessTokenExpiresAt ?? existing?.accessTokenExpiresAt ?? null,
    scopes: input.scopes ?? existing?.scopes ?? [],
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now,
    error:
      input.error === undefined
        ? existing?.error ?? null
        : input.error
          ? sanitizeText(input.error, 512)
          : null,
  };
  store.calendarByProfileId.set(profile.id, connection);
  return connection;
};

export const clearGoogleCalendarConnection = (
  store: SchedulingStore,
  profile: SchedulingProfile,
): void => {
  store.calendarByProfileId.delete(profile.id);
};

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

const getSchedulingSqlitePath = (): string => {
  const configured =
    process.env.SCHEDULING_SQLITE_PATH?.trim() ||
    process.env.CONCLAVE_SQLITE_PATH?.trim();
  if (configured) return resolve(configured);
  const recordingStoragePath = process.env.RECORDING_STORAGE_PATH?.trim();
  if (recordingStoragePath) return resolve(recordingStoragePath, "conclave.sqlite");
  return resolve(process.cwd(), "data", "conclave.sqlite");
};

const getSchedulingJsonPath = (): string => {
  const configured = process.env.SCHEDULING_PATH?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd(), "data", "scheduling.json");
};

const writeJsonAtomic = (path: string, data: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
};

const loadNodeSqlite = (): {
  DatabaseSync: new (path: string) => SqliteDatabase;
} => {
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
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

const decryptToken = (value: string | null): string | null => {
  if (!value) return null;
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

const serializeCalendar = (
  calendar: SchedulingCalendarConnection,
): SchedulingCalendarConnection => ({
  ...calendar,
  accessToken: encryptToken(calendar.accessToken),
  refreshToken: encryptToken(calendar.refreshToken),
});

const deserializeCalendar = (
  calendar: SchedulingCalendarConnection,
): SchedulingCalendarConnection => ({
  ...calendar,
  accessToken: decryptToken(calendar.accessToken),
  refreshToken: decryptToken(calendar.refreshToken),
});

const normalizeSnapshotClientId = (clientId: unknown): string =>
  typeof clientId === "string" && clientId.trim()
    ? canonicalizeClientId(clientId)
    : CONCLAVE_CLIENT_ID;

const normalizeSnapshot = (
  snapshot: Partial<SchedulingSnapshot>,
): SchedulingSnapshot => ({
  profiles: Array.isArray(snapshot.profiles)
    ? snapshot.profiles.map((profile) => ({
        ...profile,
        clientId: normalizeSnapshotClientId(profile.clientId),
      }))
    : [],
  availability: Array.isArray(snapshot.availability) ? snapshot.availability : [],
  eventTypes: Array.isArray(snapshot.eventTypes)
    ? snapshot.eventTypes.map((eventType) => ({
        ...eventType,
        clientId: normalizeSnapshotClientId(eventType.clientId),
      }))
    : [],
  calendars: Array.isArray(snapshot.calendars)
    ? snapshot.calendars.map((calendar) => {
        const deserialized = deserializeCalendar(calendar);
        return {
          ...deserialized,
          clientId: normalizeSnapshotClientId(deserialized.clientId),
        };
      })
    : [],
});

const createSqliteSchedulingPersistence = (
  path: string = getSchedulingSqlitePath(),
): SchedulingPersistence => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduling_records (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS scheduling_records_kind_client_idx
      ON scheduling_records(kind, client_id);
  `);

  const upsert = db.prepare(`
    INSERT INTO scheduling_records (kind, id, client_id, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET
      client_id = excluded.client_id,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
    WHERE excluded.updated_at >= scheduling_records.updated_at
  `);
  const deleteAll = db.prepare("DELETE FROM scheduling_records");
  const loadRows = db.prepare(`
    SELECT kind, payload_json
    FROM scheduling_records
    ORDER BY kind ASC, updated_at ASC
  `);

  return {
    save: (snapshot) => {
      try {
        db.exec("BEGIN IMMEDIATE");
        deleteAll.run();
        for (const profile of snapshot.profiles) {
          upsert.run(
            "profile",
            profile.id,
            profile.clientId,
            profile.updatedAt,
            JSON.stringify(profile),
          );
        }
        for (const entry of snapshot.availability) {
          const profile = snapshot.profiles.find((p) => p.id === entry.profileId);
          upsert.run(
            "availability",
            entry.profileId,
            profile?.clientId ?? "conclave",
            Date.now(),
            JSON.stringify(entry),
          );
        }
        for (const eventType of snapshot.eventTypes) {
          upsert.run(
            "event_type",
            eventType.id,
            eventType.clientId,
            eventType.updatedAt,
            JSON.stringify(eventType),
          );
        }
        for (const calendar of snapshot.calendars) {
          const serialized = serializeCalendar(calendar);
          upsert.run(
            "calendar",
            calendar.profileId,
            calendar.clientId,
            calendar.updatedAt,
            JSON.stringify(serialized),
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to persist scheduling records", error);
      }
    },
    load: () => {
      const snapshot: SchedulingSnapshot = {
        profiles: [],
        availability: [],
        eventTypes: [],
        calendars: [],
      };
      try {
        for (const row of loadRows.all()) {
          const kind =
            row && typeof row === "object" && "kind" in row
              ? String((row).kind)
              : "";
          const payload =
            row && typeof row === "object" && "payload_json" in row
              ? String((row).payload_json)
              : "";
          if (!payload) continue;
          // Persistence payloads are this module's own serialized writes, so
          // the element shape is trusted here; JSON.parse stays `unknown` and
          // the snapshot-level checks in normalizeSnapshot still apply.
          const parsed: unknown = JSON.parse(payload);
          if (kind === "profile") {
            snapshot.profiles.push(parsed as SchedulingProfile);
          }
          if (kind === "availability") {
            snapshot.availability.push(
              parsed as SchedulingSnapshot["availability"][number],
            );
          }
          if (kind === "event_type") {
            snapshot.eventTypes.push(parsed as SchedulingEventType);
          }
          if (kind === "calendar") {
            snapshot.calendars.push(
              deserializeCalendar(parsed as SchedulingCalendarConnection),
            );
          }
        }
      } catch (error) {
        Logger.error("Failed to load scheduling records", error);
      }
      return normalizeSnapshot(snapshot);
    },
    close: () => db.close(),
  };
};

const createFileSchedulingPersistence = (
  path: string = getSchedulingJsonPath(),
): SchedulingPersistence => ({
  save: (snapshot) => {
    try {
      writeJsonAtomic(
        path,
        JSON.stringify(
          {
            ...snapshot,
            calendars: snapshot.calendars.map(serializeCalendar),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      Logger.error("Failed to persist scheduling records to JSON", error);
    }
  },
  load: () => {
    try {
      if (!existsSync(path)) return normalizeSnapshot({});
      // Own serialized writes; normalizeSnapshot re-checks the array shape.
      return normalizeSnapshot(
        JSON.parse(readFileSync(path, "utf8")) as Partial<SchedulingSnapshot>,
      );
    } catch (error) {
      Logger.error("Failed to load scheduling records from JSON", error);
      return normalizeSnapshot({});
    }
  },
});

const UPSERT_SCHEDULING_RECORD_SCRIPT = `
local recordKey = KEYS[1]
local tombstonesKey = KEYS[2]
local id = ARGV[1]
local tombstoneId = ARGV[2]
local incomingUpdatedAt = tonumber(ARGV[3]) or 0
local payload = ARGV[4]

local deletedAt = tonumber(redis.call("HGET", tombstonesKey, tombstoneId) or "0") or 0
if deletedAt > incomingUpdatedAt then
  return 0
end

local current = redis.call("HGET", recordKey, id)
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and decoded then
    local currentUpdatedAt = tonumber(decoded.updatedAt or 0) or 0
    if currentUpdatedAt > incomingUpdatedAt then
      return 0
    end
  end
end

redis.call("HSET", recordKey, id, payload)
return 1
`;

const isPresent = <T>(value: T | null): value is T => value !== null;

const parseRedisRecord = <T>(value: string): T | null => {
  try {
    const parsed = JSON.parse(value) as { payload?: T };
    return parsed && typeof parsed === "object" && "payload" in parsed
      ? parsed.payload ?? null
      : (parsed as T);
  } catch {
    return null;
  }
};

const missingIds = <T extends { id: string }>(
  knownIds: Set<string>,
  records: T[],
): string[] => {
  const currentIds = new Set(records.map((record) => record.id));
  return Array.from(knownIds).filter((id) => !currentIds.has(id));
};

class RedisSchedulingPersistence implements SchedulingPersistence {
  private client: RedisPersistenceClient;
  private fallback: SchedulingPersistence;
  private snapshotKey: string;
  private profilesKey: string;
  private availabilityKey: string;
  private eventTypesKey: string;
  private calendarsKey: string;
  private tombstonesKey: string;
  private startPromise: Promise<void> | null = null;
  private started = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  private knownProfileIds = new Set<string>();
  private knownAvailabilityIds = new Set<string>();
  private knownEventTypeIds = new Set<string>();
  private knownCalendarIds = new Set<string>();

  constructor(options: {
    redisUrl: string;
    keyPrefix: string;
    fallback: SchedulingPersistence;
  }) {
    this.client = createRedisPersistenceClient("Scheduling", options.redisUrl);
    this.fallback = options.fallback;
    this.snapshotKey = `${options.keyPrefix}:scheduling:snapshot`;
    this.profilesKey = `${options.keyPrefix}:scheduling:profiles`;
    this.availabilityKey = `${options.keyPrefix}:scheduling:availability`;
    this.eventTypesKey = `${options.keyPrefix}:scheduling:event-types`;
    this.calendarsKey = `${options.keyPrefix}:scheduling:calendars`;
    this.tombstonesKey = `${options.keyPrefix}:scheduling:tombstones`;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      await this.client.connect();
      this.started = true;
      Logger.success("[Scheduling] Redis persistence connected");
    })();

    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  save(snapshot: SchedulingSnapshot): void {
    void this.fallback.save(snapshot);
    const profileRecords = snapshot.profiles.map((profile) => ({
      id: profile.id,
      updatedAt: profile.updatedAt,
      payload: profile,
    }));
    const profileUpdatedAt = new Map(
      snapshot.profiles.map((profile) => [profile.id, profile.updatedAt]),
    );
    const availabilityRecords = snapshot.availability.map((entry) => ({
      id: entry.profileId,
      updatedAt:
        entry.availability.updatedAt ??
        profileUpdatedAt.get(entry.profileId) ??
        Date.now(),
      payload: entry,
    }));
    const eventTypeRecords = snapshot.eventTypes.map((eventType) => ({
      id: eventType.id,
      updatedAt: eventType.updatedAt,
      payload: eventType,
    }));
    const calendarRecords = snapshot.calendars.map((calendar) => ({
      id: calendar.profileId,
      updatedAt: calendar.updatedAt,
      payload: serializeCalendar(calendar),
    }));
    const deletedProfileIds = missingIds(this.knownProfileIds, profileRecords);
    const deletedAvailabilityIds = missingIds(
      this.knownAvailabilityIds,
      availabilityRecords,
    );
    const deletedEventTypeIds = missingIds(
      this.knownEventTypeIds,
      eventTypeRecords,
    );
    const deletedCalendarIds = missingIds(this.knownCalendarIds, calendarRecords);

    this.knownProfileIds = new Set(profileRecords.map((record) => record.id));
    this.knownAvailabilityIds = new Set(
      availabilityRecords.map((record) => record.id),
    );
    this.knownEventTypeIds = new Set(
      eventTypeRecords.map((record) => record.id),
    );
    this.knownCalendarIds = new Set(calendarRecords.map((record) => record.id));

    this.queueWrite("save snapshot", async () => {
      await Promise.all([
        this.upsertRecords(this.profilesKey, "profile", profileRecords),
        this.upsertRecords(
          this.availabilityKey,
          "availability",
          availabilityRecords,
        ),
        this.upsertRecords(this.eventTypesKey, "event_type", eventTypeRecords),
        this.upsertRecords(this.calendarsKey, "calendar", calendarRecords),
        this.deleteRecords(this.profilesKey, "profile", deletedProfileIds),
        this.deleteRecords(
          this.availabilityKey,
          "availability",
          deletedAvailabilityIds,
        ),
        this.deleteRecords(this.eventTypesKey, "event_type", deletedEventTypeIds),
        this.deleteRecords(this.calendarsKey, "calendar", deletedCalendarIds),
      ]);
    });
  }

  async load(): Promise<SchedulingSnapshot> {
    try {
      await this.start();
      const redisSnapshot = await this.loadHashes();
      const redisTotal =
        redisSnapshot.profiles.length +
        redisSnapshot.availability.length +
        redisSnapshot.eventTypes.length +
        redisSnapshot.calendars.length;
      if (redisTotal > 0) {
        this.rememberKnownIds(redisSnapshot);
        return redisSnapshot;
      }

      const legacySnapshot = await this.loadLegacySnapshot();
      const legacyTotal =
        legacySnapshot.profiles.length +
        legacySnapshot.availability.length +
        legacySnapshot.eventTypes.length +
        legacySnapshot.calendars.length;
      if (legacyTotal > 0) {
        this.rememberKnownIds(legacySnapshot);
        this.save(legacySnapshot);
        await this.flush();
        Logger.info(
          `Migrated ${legacyTotal} legacy scheduling record(s) into Redis hashes`,
        );
        return legacySnapshot;
      }

      const fallbackSnapshot = await this.fallback.load();
      const total =
        fallbackSnapshot.profiles.length +
        fallbackSnapshot.availability.length +
        fallbackSnapshot.eventTypes.length +
        fallbackSnapshot.calendars.length;
      if (total > 0) {
        this.rememberKnownIds(fallbackSnapshot);
        this.save(fallbackSnapshot);
        await this.flush();
        Logger.info(`Migrated ${total} scheduling record(s) into Redis persistence`);
      }
      return fallbackSnapshot;
    } catch (error) {
      Logger.error(
        "Failed to load scheduling records from Redis; falling back to local persistence",
        error,
      );
      return this.fallback.load();
    }
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.fallback.close?.();
    if (!this.started) return;
    this.started = false;
    await this.client.quit();
  }

  private queueWrite(label: string, write: () => Promise<void>): void {
    const writePromise = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        await this.start();
        await write();
      });
    this.pendingWrite = writePromise.catch((error) => {
      Logger.error(`Failed to persist scheduling records to Redis (${label})`, error);
      throw error;
    });
  }

  private async upsertRecords<T>(
    key: string,
    kind: string,
    records: Array<{ id: string; updatedAt: number; payload: T }>,
  ): Promise<void> {
    for (const record of records) {
      await this.client.sendCommand([
        "EVAL",
        UPSERT_SCHEDULING_RECORD_SCRIPT,
        "2",
        key,
        this.tombstonesKey,
        record.id,
        `${kind}:${record.id}`,
        String(record.updatedAt),
        JSON.stringify({
          updatedAt: record.updatedAt,
          payload: record.payload,
        }),
      ]);
    }
  }

  private async deleteRecords(
    key: string,
    kind: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const deletedAt = String(Date.now());
    const transaction = this.client.multi();
    transaction.hDel(key, ids);
    transaction.hSet(
      this.tombstonesKey,
      Object.fromEntries(ids.map((id) => [`${kind}:${id}`, deletedAt])),
    );
    await transaction.exec();
  }

  private async loadHashes(): Promise<SchedulingSnapshot> {
    const [profiles, availability, eventTypes, calendars] = await Promise.all([
      this.client.hVals(this.profilesKey),
      this.client.hVals(this.availabilityKey),
      this.client.hVals(this.eventTypesKey),
      this.client.hVals(this.calendarsKey),
    ]);
    return normalizeSnapshot({
      profiles: profiles
        .map((value) => parseRedisRecord<SchedulingProfile>(value))
        .filter(isPresent),
      availability: availability
        .map((value) =>
          parseRedisRecord<{ profileId: string; availability: WeeklyAvailability }>(
            value,
          ),
        )
        .filter(isPresent),
      eventTypes: eventTypes
        .map((value) => parseRedisRecord<SchedulingEventType>(value))
        .filter(isPresent),
      calendars: calendars
        .map((value) => parseRedisRecord<SchedulingCalendarConnection>(value))
        .filter(isPresent)
        .map(deserializeCalendar),
    });
  }

  private async loadLegacySnapshot(): Promise<SchedulingSnapshot> {
    const value = await this.client.get(this.snapshotKey);
    if (!value) return normalizeSnapshot({});
    // Own serialized writes; normalizeSnapshot re-checks the array shape.
    return normalizeSnapshot(JSON.parse(value) as Partial<SchedulingSnapshot>);
  }

  private rememberKnownIds(snapshot: SchedulingSnapshot): void {
    this.knownProfileIds = new Set(snapshot.profiles.map((profile) => profile.id));
    this.knownAvailabilityIds = new Set(
      snapshot.availability.map((entry) => entry.profileId),
    );
    this.knownEventTypeIds = new Set(
      snapshot.eventTypes.map((eventType) => eventType.id),
    );
    this.knownCalendarIds = new Set(
      snapshot.calendars.map((calendar) => calendar.profileId),
    );
  }
}

const createRedisSchedulingPersistence = (
  redisUrl: string = resolveRedisPersistenceUrl(),
  keyPrefix: string = resolveRedisPersistenceKeyPrefix(),
  fallback: SchedulingPersistence = createSqliteSchedulingPersistence(),
): SchedulingPersistence =>
  new RedisSchedulingPersistence({ redisUrl, keyPrefix, fallback });

export const createSchedulingPersistence = (): SchedulingPersistence => {
  const mode = process.env.SCHEDULING_PERSISTENCE?.trim().toLowerCase();
  if (mode === "json" || mode === "file") return createFileSchedulingPersistence();
  const redisUrl = resolveRedisPersistenceUrl();
  try {
    const sqlitePersistence = createSqliteSchedulingPersistence();
    if (shouldUseRedisPersistence(mode, redisUrl)) {
      if (!redisUrl) {
        throw new Error(
          "SCHEDULING_PERSISTENCE=redis requires SFU_PERSISTENCE_REDIS_URL, SFU_REDIS_URL, or REDIS_URL.",
        );
      }
      return createRedisSchedulingPersistence(
        redisUrl,
        resolveRedisPersistenceKeyPrefix(),
        sqlitePersistence,
      );
    }
    return sqlitePersistence;
  } catch (error) {
    if (mode === "sqlite") throw error;
    Logger.warn(
      `SQLite scheduling persistence unavailable; falling back to JSON: ${(error as Error).message}`,
    );
    const filePersistence = createFileSchedulingPersistence();
    if (shouldUseRedisPersistence(mode, redisUrl)) {
      if (!redisUrl) {
        throw new Error(
          "SCHEDULING_PERSISTENCE=redis requires SFU_PERSISTENCE_REDIS_URL, SFU_REDIS_URL, or REDIS_URL.",
        );
      }
      return createRedisSchedulingPersistence(
        redisUrl,
        resolveRedisPersistenceKeyPrefix(),
        filePersistence,
      );
    }
    return filePersistence;
  }
};

const snapshotSchedulingStore = (
  store: SchedulingStore,
): SchedulingSnapshot => ({
  profiles: Array.from(store.profilesById.values()),
  availability: Array.from(store.availabilityByProfileId.entries()).map(
    ([profileId, availability]) => ({ profileId, availability }),
  ),
  eventTypes: Array.from(store.eventTypesById.values()),
  calendars: Array.from(store.calendarByProfileId.values()),
});

export const persistScheduling = (
  store: SchedulingStore,
  persistence: SchedulingPersistence | null,
): Promise<void> => {
  if (!persistence) return Promise.resolve();
  return Promise.resolve(persistence.save(snapshotSchedulingStore(store))).then(() =>
    persistence.flush?.(),
  );
};

export const loadPersistedScheduling = (
  store: SchedulingStore,
  persistence: SchedulingPersistence,
): Promise<number> => Promise.resolve(persistence.load()).then((snapshot) => {
  for (const profile of snapshot.profiles) {
    registerProfile(store, profile);
  }
  for (const entry of snapshot.availability) {
    const profile = store.profilesById.get(entry.profileId);
    if (!profile) continue;
    store.availabilityByProfileId.set(
      entry.profileId,
      normalizeWeeklyAvailability(entry.availability, profile.timeZone),
    );
  }
  for (const eventType of snapshot.eventTypes) {
    registerEventType(store, eventType);
  }
  for (const calendar of snapshot.calendars) {
    store.calendarByProfileId.set(calendar.profileId, calendar);
  }
  return (
    snapshot.profiles.length +
    snapshot.eventTypes.length +
    snapshot.calendars.length
  );
});

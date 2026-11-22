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
import { assertSqliteWritable } from "./sqliteWriteCheck.js";
import { finiteNumber, importFallbackFiles, readJsonStore, replaceIfNewer, requireArray } from "./fallbackImport.js";
import { mergeNewestStamp } from "./stampedMerge.js";

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
  tombstones: Record<SchedulingRecordKind, Map<string, number>>;
};

type SchedulingRecordKind = "profile" | "availability" | "event_type" | "calendar";

type SchedulingDeletion = { kind: SchedulingRecordKind; id: string; deletedAt: number };

type SchedulingSnapshot = {
  profiles: SchedulingProfile[];
  availability: Array<{ profileId: string; availability: WeeklyAvailability }>;
  eventTypes: SchedulingEventType[];
  calendars: SchedulingCalendarConnection[];
  deleted?: SchedulingDeletion[];
};

const SCHEDULING_KINDS: SchedulingRecordKind[] = ["profile", "availability", "event_type", "calendar"];

export type SchedulingRecordWrite = {
  kind: SchedulingRecordKind;
  id: string;
  clientId: string;
  updatedAt: number;
  payload: unknown;
};

export type SchedulingPersistence = {
  save: (snapshot: SchedulingSnapshot) => MaybePromise<void>;
  importIfNewer: (record: SchedulingRecordWrite) => MaybePromise<boolean>;
  load: (options?: { strict?: boolean }) => MaybePromise<SchedulingSnapshot>;
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
  tombstones: { profile: new Map(), availability: new Map(), event_type: new Map(), calendar: new Map() },
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
  store.tombstones.event_type.set(id, Math.max(Date.now(), eventType.updatedAt + 1));
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
  const connection = store.calendarByProfileId.get(profile.id);
  if (!connection) return;
  store.calendarByProfileId.delete(profile.id);
  store.tombstones.calendar.set(profile.id, Math.max(Date.now(), (connection.updatedAt ?? 0) + 1));
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

const normalizeDeletions = (deleted: unknown): SchedulingDeletion[] =>
  (Array.isArray(deleted) ? deleted : []).flatMap((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const kind = SCHEDULING_KINDS.find((candidate) => candidate === record.kind);
    const deletedAt = finiteNumber(record.deletedAt);
    return kind && typeof record.id === "string" && deletedAt !== null ? [{ kind, id: record.id, deletedAt }] : [];
  });

const normalizeSnapshot = (
  snapshot: Partial<SchedulingSnapshot>,
): SchedulingSnapshot => ({
  deleted: normalizeDeletions(snapshot.deleted),
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

/**
 * Hours saved before they carried their own updatedAt take their profile's,
 * which every hours edit bumps, else 0 so they only fill a gap. Imported hours
 * are stamped with that time, so they never need the fallback again.
 */
const hoursUpdatedAt = (hours: unknown, profile: unknown): number =>
  finiteNumber((hours as { updatedAt?: unknown } | null)?.updatedAt) ??
  finiteNumber((profile as { updatedAt?: unknown } | null)?.updatedAt) ??
  0;

const schedulingRecordsOf = (snapshot: SchedulingSnapshot): SchedulingRecordWrite[] => {
  const profilesById = new Map(snapshot.profiles.map((profile) => [profile.id, profile]));
  return [
    ...snapshot.profiles.map((profile): SchedulingRecordWrite => ({
      kind: "profile",
      id: profile.id,
      clientId: profile.clientId,
      updatedAt: profile.updatedAt,
      payload: profile,
    })),
    ...snapshot.availability.map((entry): SchedulingRecordWrite => {
      const profile = profilesById.get(entry.profileId);
      return {
        kind: "availability",
        id: entry.profileId,
        clientId: profile?.clientId ?? CONCLAVE_CLIENT_ID,
        updatedAt: hoursUpdatedAt(entry.availability, profile),
        payload: entry,
      };
    }),
    ...snapshot.eventTypes.map((eventType): SchedulingRecordWrite => ({
      kind: "event_type",
      id: eventType.id,
      clientId: eventType.clientId,
      updatedAt: eventType.updatedAt,
      payload: eventType,
    })),
    ...snapshot.calendars.map((calendar): SchedulingRecordWrite => ({
      kind: "calendar",
      id: calendar.profileId,
      clientId: calendar.clientId,
      updatedAt: calendar.updatedAt,
      payload: serializeCalendar(calendar),
    })),
  ];
};

const createSqliteSchedulingPersistence = (
  path: string = getSchedulingSqlitePath(),
): SchedulingPersistence => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  assertSqliteWritable(db, path);
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduling_tombstones (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (kind, id)
    );
  `);

  const storedAt = `CASE scheduling_records.kind
    WHEN 'availability' THEN COALESCE(
      json_extract(scheduling_records.payload_json, '$.availability.updatedAt'),
      scheduling_records.updated_at
    )
    ELSE scheduling_records.updated_at
  END`;
  const upsertSql = (guard: ">=" | ">") => `
    INSERT INTO scheduling_records (kind, id, client_id, updated_at, payload_json)
    SELECT ?1, ?2, ?3, ?4, ?5
    WHERE NOT EXISTS (
      SELECT 1 FROM scheduling_tombstones
      WHERE kind = ?1 AND id = ?2 AND NOT (?4 ${guard} deleted_at)
    )
    ON CONFLICT(kind, id) DO UPDATE SET
      client_id = excluded.client_id,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
    WHERE excluded.updated_at ${guard} ${storedAt}
  `;
  const upsert = db.prepare(upsertSql(">="));
  const upsertIfNewer = db.prepare(upsertSql(">"));
  const deleteOlder = db.prepare("DELETE FROM scheduling_records WHERE kind = ? AND id = ? AND updated_at < ?");
  const loadTombstones = db.prepare("SELECT kind, id, deleted_at FROM scheduling_tombstones");
  const markDeleted = db.prepare(`
    INSERT INTO scheduling_tombstones (kind, id, deleted_at) VALUES (?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET
      deleted_at = MAX(scheduling_tombstones.deleted_at, excluded.deleted_at)
  `);
  const loadRows = db.prepare(`
    SELECT kind, id, payload_json
    FROM scheduling_records
    ORDER BY kind ASC, updated_at ASC
  `);
  const write = (statement: SqliteStatement, record: SchedulingRecordWrite): boolean => {
    const result = statement.run(
      record.kind,
      record.id,
      record.clientId,
      record.updatedAt,
      JSON.stringify(record.payload),
    ) as { changes: number | bigint };
    return Number(result.changes) > 0;
  };
  return {
    save: (snapshot) => {
      try {
        db.exec("BEGIN IMMEDIATE");
        for (const record of schedulingRecordsOf(snapshot)) write(upsert, record);
        for (const { kind, id, deletedAt } of snapshot.deleted ?? []) {
          deleteOlder.run(kind, id, deletedAt);
          markDeleted.run(kind, id, deletedAt);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
    importIfNewer: (record) => write(upsertIfNewer, record),
    load: (options) => {
      const snapshot: SchedulingSnapshot = {
        profiles: [],
        availability: [],
        eventTypes: [],
        calendars: [],
      };
      try {
        db.exec("BEGIN");
        const rows = loadRows.all();
        const tombstones = loadTombstones.all() as Array<{ kind: unknown; id: unknown; deleted_at: unknown }>;
        db.exec("COMMIT");
        snapshot.deleted = normalizeDeletions(
          tombstones.map((row) => ({ kind: row.kind, id: row.id, deletedAt: Number(row.deleted_at) })),
        );
        for (const row of rows) {
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
        try {
          db.exec("ROLLBACK");
        } catch {}
        if (options?.strict) throw error;
        Logger.error("Failed to load scheduling records", error);
      }
      return normalizeSnapshot(snapshot);
    },
    close: () => db.close(),
  };
};

const SNAPSHOT_FIELD: Record<SchedulingRecordKind, keyof SchedulingSnapshot> = {
  profile: "profiles",
  availability: "availability",
  event_type: "eventTypes",
  calendar: "calendars",
};

const readJsonSnapshot = (path: string): Record<string, unknown> => {
  const stored = readJsonStore(path) ?? {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`${path} is not a scheduling snapshot`);
  }
  return stored as Record<string, unknown>;
};

const snapshotList = (snapshot: Record<string, unknown>, field: string): unknown[] =>
  snapshot[field] === undefined ? [] : requireArray(snapshot[field], field);

const storedProfilesById = (snapshot: Record<string, unknown>): Map<unknown, unknown> =>
  new Map(
    snapshotList(snapshot, "profiles").map((profile) => [(profile as { id?: unknown } | null)?.id, profile]),
  );

const importIntoJsonSnapshot = (
  path: string,
  record: SchedulingRecordWrite,
  profilesBeforeImport: Map<unknown, unknown>,
): boolean => {
  const snapshot = readJsonSnapshot(path);
  const field = SNAPSHOT_FIELD[record.kind];
  const entries = snapshotList(snapshot, field);
  const keyField = record.kind === "profile" || record.kind === "event_type" ? "id" : "profileId";
  const replaced = replaceIfNewer(
    entries,
    (entry) => entry[keyField] === record.id,
    record.payload,
    record.updatedAt,
    record.kind === "availability"
      ? (entry) => hoursUpdatedAt(entry.availability, profilesBeforeImport.get(entry.profileId))
      : undefined,
  );
  if (replaced) writeJsonAtomic(path, JSON.stringify({ ...snapshot, [field]: entries }, null, 2));
  return replaced;
};

const createFileSchedulingPersistence = (
  path: string = getSchedulingJsonPath(),
): SchedulingPersistence => {
  let profilesBeforeImport: Map<unknown, unknown> | null = null;
  return {
    importIfNewer: (record) => {
      profilesBeforeImport ??= storedProfilesById(readJsonSnapshot(path));
      return importIntoJsonSnapshot(path, record, profilesBeforeImport);
    },
    save: (snapshot) => {
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
    },
    load: (options) => {
      try {
        if (!existsSync(path)) return normalizeSnapshot({});
        // Own serialized writes; normalizeSnapshot re-checks the array shape.
        return normalizeSnapshot(
          JSON.parse(readFileSync(path, "utf8")) as Partial<SchedulingSnapshot>,
        );
      } catch (error) {
        if (options?.strict) throw error;
        Logger.error("Failed to load scheduling records from JSON", error);
        return normalizeSnapshot({});
      }
    },
  };
};

const SCHEDULING_LUA = `
local function storedAt(hash, id)
  local current = redis.call("HGET", hash, id)
  if not current then return nil end
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == "table" then return tonumber(decoded.updatedAt or 0) or 0 end
  return 0
end

local function setIfNewer(hash, tombstones, tombstoneId, id, updatedAt, payload, strict)
  local deletedAt = tonumber(redis.call("HGET", tombstones, tombstoneId) or "")
  if deletedAt and (deletedAt > updatedAt or (strict and deletedAt == updatedAt)) then return 0 end
  local currentAt = storedAt(hash, id)
  if currentAt and (currentAt > updatedAt or (strict and currentAt == updatedAt)) then return 0 end
  redis.call("HSET", hash, id, payload)
  return 1
end

local function markDeleted(hash, tombstones, tombstoneId, id, deletedAt)
  local currentAt = storedAt(hash, id)
  if currentAt and currentAt < deletedAt then redis.call("HDEL", hash, id) end
  local previous = tonumber(redis.call("HGET", tombstones, tombstoneId) or "")
  if not previous or previous < deletedAt then redis.call("HSET", tombstones, tombstoneId, deletedAt) end
end
`;

const UPSERT_SCHEDULING_RECORD_SCRIPT = `${SCHEDULING_LUA}
return setIfNewer(KEYS[1], KEYS[2], ARGV[2], ARGV[1], tonumber(ARGV[3]) or 0, ARGV[4], ARGV[5] == "newer")
`;

const DELETE_SCHEDULING_RECORDS_SCRIPT = `${SCHEDULING_LUA}
for index = 1, #ARGV, 4 do
  local kindIndex, kind, id = tonumber(ARGV[index]), ARGV[index + 1], ARGV[index + 2]
  markDeleted(KEYS[kindIndex], KEYS[5], kind .. ":" .. id, id, tonumber(ARGV[index + 3]) or 0)
end
return 1
`;

/**
 * Seeds an empty Redis from the legacy snapshot and SQLite and marks it
 * seeded, in one step. A Redis that already holds scheduling records is the
 * authority: it is only marked, never topped up from rows that may be stale.
 */
const SEED_SCHEDULING_SCRIPT = `${SCHEDULING_LUA}
if redis.call("EXISTS", KEYS[6]) == 1 then return 0 end
for keyIndex = 1, 5 do
  if redis.call("HLEN", KEYS[keyIndex]) > 0 then
    redis.call("SET", KEYS[6], "1")
    return 0
  end
end
local count = tonumber(ARGV[1]) or 0
local index = 2
for _ = 1, count do
  local kindIndex, kind, id = tonumber(ARGV[index]), ARGV[index + 1], ARGV[index + 2]
  setIfNewer(KEYS[kindIndex], KEYS[5], kind .. ":" .. id, id, tonumber(ARGV[index + 3]) or 0, ARGV[index + 4], false)
  index = index + 5
end
while index <= #ARGV do
  local kindIndex, kind, id = tonumber(ARGV[index]), ARGV[index + 1], ARGV[index + 2]
  markDeleted(KEYS[kindIndex], KEYS[5], kind .. ":" .. id, id, tonumber(ARGV[index + 3]) or 0)
  index = index + 4
end
redis.call("SET", KEYS[6], "1")
return 1
`;

const kindIndex = (kind: SchedulingRecordKind): string => String(SCHEDULING_KINDS.indexOf(kind) + 1);

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

class RedisSchedulingPersistence implements SchedulingPersistence {
  private client: RedisPersistenceClient;
  private fallback: SchedulingPersistence;
  private snapshotKey: string;
  private profilesKey: string;
  private availabilityKey: string;
  private eventTypesKey: string;
  private calendarsKey: string;
  private tombstonesKey: string;
  private seededKey: string;
  private startPromise: Promise<void> | null = null;
  private started = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  private seeded: Promise<void> | null = null;

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
    this.seededKey = `${options.keyPrefix}:scheduling:seeded`;
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

  save(snapshot: SchedulingSnapshot): Promise<void> {
    const records = schedulingRecordsOf(snapshot);
    const deleted = snapshot.deleted ?? [];
    return this.queueWrite(async () => {
      await this.fallback.save(snapshot);
      for (const record of records) await this.upsertRecord(record, "save");
      if (deleted.length > 0) {
        await this.client.sendCommand([
          "EVAL",
          DELETE_SCHEDULING_RECORDS_SCRIPT,
          "5",
          ...this.hashKeys,
          this.tombstonesKey,
          ...deleted.flatMap(({ kind, id, deletedAt }) => [kindIndex(kind), kind, id, String(deletedAt)]),
        ]);
      }
    });
  }

  async importIfNewer(record: SchedulingRecordWrite): Promise<boolean> {
    await this.start();
    await this.ensureSeeded();
    const applied = await this.upsertRecord(record, "newer");
    await this.fallback.importIfNewer(record);
    return Number(applied) === 1;
  }

  async load(options?: { strict?: boolean }): Promise<SchedulingSnapshot> {
    try {
      await this.start();
      await this.ensureSeeded();
      return await this.loadHashes();
    } catch (error) {
      if (options?.strict) throw error;
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

  private get hashKeys(): string[] {
    return [this.profilesKey, this.availabilityKey, this.eventTypesKey, this.calendarsKey];
  }

  /** Runs before the first read or write, so nothing this SFU writes can make an empty Redis look established. */
  private ensureSeeded(): Promise<void> {
    this.seeded ??= this.seed().catch((error: unknown) => {
      this.seeded = null;
      throw error;
    });
    return this.seeded;
  }

  private async seed(): Promise<void> {
    if (await this.client.exists(this.seededKey)) return;
    const legacy = await this.loadLegacySnapshot();
    const local = await this.fallback.load({ strict: true });
    const records = [...schedulingRecordsOf(legacy), ...schedulingRecordsOf(local)];
    const deleted = [...(legacy.deleted ?? []), ...(local.deleted ?? [])];
    const seeded = await this.client.sendCommand([
      "EVAL",
      SEED_SCHEDULING_SCRIPT,
      "6",
      ...this.hashKeys,
      this.tombstonesKey,
      this.seededKey,
      String(records.length),
      ...records.flatMap((record) => [
        kindIndex(record.kind),
        record.kind,
        record.id,
        String(record.updatedAt),
        JSON.stringify({ updatedAt: record.updatedAt, payload: record.payload }),
      ]),
      ...deleted.flatMap(({ kind, id, deletedAt }) => [kindIndex(kind), kind, id, String(deletedAt)]),
    ]);
    if (Number(seeded) === 1 && records.length > 0) {
      Logger.info(`Seeded Redis with ${records.length} scheduling record(s) from local persistence`);
    }
  }

  private upsertRecord(record: SchedulingRecordWrite, mode: "save" | "newer"): Promise<unknown> {
    return this.client.sendCommand([
      "EVAL",
      UPSERT_SCHEDULING_RECORD_SCRIPT,
      "2",
      this.hashKeys[SCHEDULING_KINDS.indexOf(record.kind)],
      this.tombstonesKey,
      record.id,
      `${record.kind}:${record.id}`,
      String(record.updatedAt),
      JSON.stringify({ updatedAt: record.updatedAt, payload: record.payload }),
      mode,
    ]);
  }

  /** Writes in order; each caller gets its own write's result, mirror included. */
  private queueWrite(write: () => Promise<void>): Promise<void> {
    const writePromise = this.pendingWrite.then(async () => {
      await this.start();
      await this.ensureSeeded();
      await write();
    });
    this.pendingWrite = writePromise.catch(() => undefined);
    return writePromise;
  }

  private async loadHashes(): Promise<SchedulingSnapshot> {
    const [profiles, availability, eventTypes, calendars, tombstones] = (await this.client
      .multi()
      .hVals(this.profilesKey)
      .hVals(this.availabilityKey)
      .hVals(this.eventTypesKey)
      .hVals(this.calendarsKey)
      .hGetAll(this.tombstonesKey)
      .exec()) as unknown as [string[], string[], string[], string[], Record<string, string>];
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
      deleted: Object.entries(tombstones).map(([key, deletedAt]) => {
        const split = key.indexOf(":");
        return { kind: key.slice(0, split), id: key.slice(split + 1), deletedAt: Number(deletedAt) };
      }) as SchedulingDeletion[],
    });
  }

  private async loadLegacySnapshot(): Promise<SchedulingSnapshot> {
    const value = await this.client.get(this.snapshotKey);
    if (!value) return normalizeSnapshot({});
    // Own serialized writes; normalizeSnapshot re-checks the array shape.
    return normalizeSnapshot(JSON.parse(value) as Partial<SchedulingSnapshot>);
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
  deleted: SCHEDULING_KINDS.flatMap((kind) =>
    [...store.tombstones[kind]].map(([id, deletedAt]) => ({ kind, id, deletedAt })),
  ),
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

type SchedulingFallbackEntry = {
  kind: SchedulingRecordKind;
  entry: unknown;
  profilesById: Map<unknown, Record<string, unknown>>;
};

const requireString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== "string" || !value) throw new Error(`${field} is missing`);
  return value;
};

const requireUpdatedAt = (record: Record<string, unknown>): number => {
  const updatedAt = finiteNumber(record.updatedAt);
  if (updatedAt === null) throw new Error("updatedAt is missing");
  return updatedAt;
};

const schedulingFallbackEntries = (data: unknown): SchedulingFallbackEntry[] => {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("expected a scheduling snapshot object");
  }
  const file = data as Record<string, unknown>;
  const listOf = (field: string): unknown[] =>
    file[field] === undefined ? [] : requireArray(file[field], field);
  const profiles = listOf("profiles");
  const profilesById = new Map(
    profiles.map((profile) => {
      const record = (profile ?? {}) as Record<string, unknown>;
      return [record.id, record];
    }),
  );
  const tag = (kind: SchedulingRecordKind, entries: unknown[]) =>
    entries.map((entry) => ({ kind, entry, profilesById }));
  return [
    ...tag("profile", profiles),
    ...tag("availability", listOf("availability")),
    ...tag("event_type", listOf("eventTypes")),
    ...tag("calendar", listOf("calendars")),
  ];
};

const schedulingRecordFromFallback = ({
  kind,
  entry,
  profilesById,
}: SchedulingFallbackEntry): SchedulingRecordWrite => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("not an object");
  }
  const record = entry as Record<string, unknown>;
  if (kind === "availability") {
    const profileId = requireString(record, "profileId");
    const hours = record.availability;
    if (!hours || typeof hours !== "object") throw new Error("availability is missing");
    const profile = profilesById.get(profileId);
    const updatedAt = hoursUpdatedAt(hours, profile);
    return {
      kind,
      id: profileId,
      clientId: normalizeSnapshotClientId(profile?.clientId),
      updatedAt,
      payload: { profileId, availability: { ...hours, updatedAt } },
    };
  }
  const clientId = normalizeSnapshotClientId(record.clientId);
  const updatedAt = requireUpdatedAt(record);
  if (kind === "calendar") {
    return { kind, id: requireString(record, "profileId"), clientId, updatedAt, payload: { ...record, clientId } };
  }
  if (kind === "event_type") {
    requireString(record, "profileId");
    requireString(record, "slug");
  } else {
    requireString(record, "userId");
    requireString(record, "username");
  }
  return { kind, id: requireString(record, "id"), clientId, updatedAt, payload: { ...record, clientId } };
};

export const importFallbackScheduling = (
  persistence: SchedulingPersistence,
): Promise<number> => {
  return importFallbackFiles({
    fileName: "scheduling.json",
    noun: "scheduling record",
    records: schedulingFallbackEntries,
    describe: ({ kind, entry }, index) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const id = record.id ?? record.profileId;
      return typeof id === "string" ? `${kind} ${id}` : `${kind} #${index + 1}`;
    },
    importIfNewer: (entry) => persistence.importIfNewer(schedulingRecordFromFallback(entry)),
  });
};

const unindexProfile = (store: SchedulingStore, profile: SchedulingProfile): void => {
  const byUser = userKey(profile.clientId, profile.userId);
  if (store.profileIdByUserKey.get(byUser) === profile.id) store.profileIdByUserKey.delete(byUser);
  const byUsername = `${profile.clientId}:${profile.username.toLowerCase()}`;
  if (store.profileIdByUsername.get(byUsername) === profile.id) store.profileIdByUsername.delete(byUsername);
};

const unindexEventType = (store: SchedulingStore, eventType: SchedulingEventType): void => {
  const bySlug = profileSlugKey(eventType.profileId, eventType.slug);
  if (store.eventTypeIdByProfileSlug.get(bySlug) === eventType.id) store.eventTypeIdByProfileSlug.delete(bySlug);
};

const deletionsOf = (snapshot: SchedulingSnapshot, kind: SchedulingRecordKind): Map<string, number> =>
  new Map((snapshot.deleted ?? []).filter((entry) => entry.kind === kind).map((entry) => [entry.id, entry.deletedAt]));

export const mergePersistedScheduling = async (
  store: SchedulingStore,
  persistence: SchedulingPersistence,
  options?: { strict?: boolean },
): Promise<number> => {
  const snapshot = await persistence.load(options);
  const drop = (kind: SchedulingRecordKind, id: string, deletedAt: number) => store.tombstones[kind].set(id, deletedAt);
  let merged = mergeNewestStamp(
    { values: store.profilesById, deletedAt: store.tombstones.profile },
    { values: new Map(snapshot.profiles.map((profile) => [profile.id, profile])), deletedAt: deletionsOf(snapshot, "profile") },
    (profile) => profile.updatedAt,
    {
      set: (id, profile) => {
        const held = store.profilesById.get(id);
        if (held) {
          unindexProfile(store, held);
          Object.assign(held, profile);
        }
        registerProfile(store, held ?? profile);
        store.tombstones.profile.delete(id);
      },
      remove: (id, deletedAt) => {
        const held = store.profilesById.get(id);
        if (held) unindexProfile(store, held);
        store.profilesById.delete(id);
        drop("profile", id, deletedAt);
      },
    },
  );
  const storedProfiles = new Map(snapshot.profiles.map((profile) => [profile.id, profile]));
  const storedHours = new Map(
    snapshot.availability.flatMap((entry): Array<[string, WeeklyAvailability]> => {
      const profile = store.profilesById.get(entry.profileId);
      if (!profile) return [];
      const hours = normalizeWeeklyAvailability(entry.availability, profile.timeZone);
      hours.updatedAt = hoursUpdatedAt(entry.availability, storedProfiles.get(entry.profileId));
      return [[entry.profileId, hours]];
    }),
  );
  merged += mergeNewestStamp(
    { values: store.availabilityByProfileId, deletedAt: store.tombstones.availability },
    { values: storedHours, deletedAt: deletionsOf(snapshot, "availability") },
    (hours) => hours.updatedAt ?? 0,
    {
      set: (id, hours) => {
        store.availabilityByProfileId.set(id, hours);
        store.tombstones.availability.delete(id);
      },
      remove: (id, deletedAt) => {
        store.availabilityByProfileId.delete(id);
        drop("availability", id, deletedAt);
      },
    },
  );
  merged += mergeNewestStamp(
    { values: store.eventTypesById, deletedAt: store.tombstones.event_type },
    { values: new Map(snapshot.eventTypes.map((eventType) => [eventType.id, eventType])), deletedAt: deletionsOf(snapshot, "event_type") },
    (eventType) => eventType.updatedAt,
    {
      set: (id, eventType) => {
        const held = store.eventTypesById.get(id);
        if (held) {
          unindexEventType(store, held);
          Object.assign(held, eventType);
        }
        registerEventType(store, held ?? eventType);
        store.tombstones.event_type.delete(id);
      },
      remove: (id, deletedAt) => {
        const held = store.eventTypesById.get(id);
        if (held) unindexEventType(store, held);
        store.eventTypesById.delete(id);
        drop("event_type", id, deletedAt);
      },
    },
  );
  merged += mergeNewestStamp(
    { values: store.calendarByProfileId, deletedAt: store.tombstones.calendar },
    { values: new Map(snapshot.calendars.map((calendar) => [calendar.profileId, calendar])), deletedAt: deletionsOf(snapshot, "calendar") },
    (calendar) => calendar.updatedAt ?? 0,
    {
      set: (id, calendar) => {
        const held = store.calendarByProfileId.get(id);
        if (held) Object.assign(held, calendar);
        else store.calendarByProfileId.set(id, calendar);
        store.tombstones.calendar.delete(id);
      },
      remove: (id, deletedAt) => {
        store.calendarByProfileId.delete(id);
        drop("calendar", id, deletedAt);
      },
    },
  );
  return merged;
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
  for (const { kind, id, deletedAt } of snapshot.deleted ?? []) {
    store.tombstones[kind].set(id, deletedAt);
  }
  return (
    snapshot.profiles.length +
    snapshot.eventTypes.length +
    snapshot.calendars.length
  );
});

import { randomBytes, randomUUID } from "node:crypto";
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
  CreateScheduledMeetingRequest,
  ScheduledMeeting,
  ScheduledMeetingEmailNotificationStatus,
  ScheduledMeetingStatus,
  UpdateScheduledMeetingRequest,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import {
  createRedisPersistenceClient,
  resolveRedisPersistenceKeyPrefix,
  resolveRedisPersistenceUrl,
  shouldUseRedisPersistence,
  type RedisPersistenceClient,
} from "./redisPersistence.js";
import { canonicalizeClientId } from "./clientIds.js";
import { generateMeetingCode } from "./meetingCodes.js";

type MaybePromise<T> = T | Promise<T>;

const MAX_TITLE_LENGTH = 140;
const MIN_TITLE_LENGTH = 1;
const ROOM_CODE_MIN_LENGTH = 3;
const ROOM_CODE_MAX_LENGTH = 64;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

const sanitizeTitle = (value: string | undefined): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, MAX_TITLE_LENGTH);
};

const sanitizeRoomCode = (value: string | undefined): string => {
  if (typeof value !== "string") return "";
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.slice(0, ROOM_CODE_MAX_LENGTH);
};

const normalizeHostEmail = (value: string | undefined): string =>
  (value || "").trim().toLowerCase();

const sanitizeOptionalText = (
  value: string | undefined,
  maxLength: number,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized || null;
};

const sanitizeOptionalEmail = (value: string | undefined): string | null => {
  const normalized = normalizeHostEmail(value);
  if (!normalized || !normalized.includes("@")) return null;
  return normalized.slice(0, 320);
};

const normalizeEmailNotificationStatus = (
  value: unknown,
): ScheduledMeetingEmailNotificationStatus =>
  value === "pending" || value === "sent" || value === "failed"
    ? value
    : "not_configured";

export type ScheduledMeetingStore = {
  byId: Map<string, ScheduledMeeting>;
  byRoomCode: Map<string, string>;
};

export const createScheduledMeetingStore = (): ScheduledMeetingStore => ({
  byId: new Map(),
  byRoomCode: new Map(),
});

const roomCodeKey = (clientId: string, roomCode: string): string =>
  `${clientId}:${roomCode}`;

const isActiveMeeting = (meeting: ScheduledMeeting): boolean =>
  meeting.status === "scheduled" || meeting.status === "live";

/**
 * Point the room-code index at `meeting`. A code can be reused once its
 * earlier meeting has ended or been cancelled, so several meetings can share
 * a code; the index keeps pointing at the active one.
 */
const claimRoomCode = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  const key = roomCodeKey(meeting.clientId, meeting.roomCode);
  const ownerId = store.byRoomCode.get(key);
  const owner = ownerId ? store.byId.get(ownerId) : undefined;
  if (
    owner &&
    owner.id !== meeting.id &&
    isActiveMeeting(owner) &&
    !isActiveMeeting(meeting)
  ) {
    return;
  }
  store.byRoomCode.set(key, meeting.id);
};

/** Drop `meeting`'s room-code entry, but never another meeting's. */
const releaseRoomCode = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  const key = roomCodeKey(meeting.clientId, meeting.roomCode);
  if (store.byRoomCode.get(key) === meeting.id) {
    store.byRoomCode.delete(key);
  }
};

const registerStore = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  store.byId.set(meeting.id, meeting);
  claimRoomCode(store, meeting);
};

const unregisterStore = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  store.byId.delete(meeting.id);
  releaseRoomCode(store, meeting);
};

const isCodeTaken = (
  store: ScheduledMeetingStore,
  clientId: string,
  roomCode: string,
  excludeId?: string,
): boolean => {
  const owner = store.byRoomCode.get(roomCodeKey(clientId, roomCode));
  if (!owner) return false;
  if (excludeId && owner === excludeId) return false;
  const existing = store.byId.get(owner);
  if (!existing) return false;
  return existing.status === "scheduled" || existing.status === "live";
};

type CreateScheduledMeetingOptions = {
  clientId: string;
  createdBy: string;
  defaultHostEmail: string;
  defaultHostName?: string;
  defaultHostUserId: string | null;
};

export const createScheduledMeeting = (
  store: ScheduledMeetingStore,
  request: CreateScheduledMeetingRequest,
  options: CreateScheduledMeetingOptions,
): ScheduledMeeting => {
  const clientId = canonicalizeClientId(options.clientId);
  const title = sanitizeTitle(request.title);
  if (!title || title.length < MIN_TITLE_LENGTH) {
    throw new Error("Title is required.");
  }

  const scheduledStartAt = Number(request.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt) || scheduledStartAt <= 0) {
    throw new Error("Invalid scheduled start time.");
  }
  const scheduledEndAt =
    Number.isFinite(Number(request.scheduledEndAt)) &&
    Number(request.scheduledEndAt) > scheduledStartAt
      ? Number(request.scheduledEndAt)
      : scheduledStartAt + DEFAULT_DURATION_MS;

  const requestedHostEmail = normalizeHostEmail(request.hostEmail);
  const requestHostEmailIsValid =
    requestedHostEmail.length > 0 && requestedHostEmail.includes("@");
  const fallbackHostEmail = normalizeHostEmail(options.defaultHostEmail);
  const hostEmail = requestHostEmailIsValid
    ? requestedHostEmail
    : fallbackHostEmail;
  if (!hostEmail || !hostEmail.includes("@")) {
    throw new Error("Host email is required.");
  }

  const hostName =
    sanitizeTitle(request.hostName) ||
    sanitizeTitle(options.defaultHostName) ||
    "";

  const requestedRoomCode = sanitizeRoomCode(request.roomCode);
  let roomCode = requestedRoomCode;
  if (!roomCode) {
    do {
      roomCode = generateMeetingCode();
    } while (isCodeTaken(store, clientId, roomCode));
  } else {
    if (roomCode.length < ROOM_CODE_MIN_LENGTH) {
      throw new Error("Custom code must be at least 3 characters.");
    }
    if (isCodeTaken(store, clientId, roomCode)) {
      throw new Error(
        "That meeting code is already booked for another scheduled meeting.",
      );
    }
  }

  const now = Date.now();
  const meeting: ScheduledMeeting = {
    id: randomUUID(),
    clientId,
    roomCode,
    title,
    hostEmail,
    hostName,
    hostUserId: options.defaultHostUserId,
    scheduledStartAt,
    scheduledEndAt,
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    createdAt: now,
    createdBy: options.createdBy,
    updatedAt: now,
    source: request.source === "booking_link" ? "booking_link" : "manual",
    eventTypeId: sanitizeOptionalText(request.eventTypeId, 128),
    attendeeName: sanitizeOptionalText(request.attendeeName, 120),
    attendeeEmail: sanitizeOptionalEmail(request.attendeeEmail),
    attendeeNote: sanitizeOptionalText(request.attendeeNote, 2000),
    attendeeTimeZone: sanitizeOptionalText(request.attendeeTimeZone, 80),
    googleCalendarEventId: sanitizeOptionalText(
      request.googleCalendarEventId,
      512,
    ),
    calendarSyncStatus: request.calendarSyncStatus ?? "not_required",
    calendarSyncError: sanitizeOptionalText(
      request.calendarSyncError ?? undefined,
      512,
    ),
    emailNotificationStatus: normalizeEmailNotificationStatus(
      request.emailNotificationStatus,
    ),
    emailNotificationError: sanitizeOptionalText(
      request.emailNotificationError ?? undefined,
      512,
    ),
    emailNotificationSentAt:
      Number.isFinite(Number(request.emailNotificationSentAt)) &&
      Number(request.emailNotificationSentAt) > 0
        ? Number(request.emailNotificationSentAt)
        : null,
    emailReminderStatus: normalizeEmailNotificationStatus(
      request.emailReminderStatus,
    ),
    emailReminderError: sanitizeOptionalText(
      request.emailReminderError ?? undefined,
      512,
    ),
    emailReminderSentAt:
      Number.isFinite(Number(request.emailReminderSentAt)) &&
      Number(request.emailReminderSentAt) > 0
        ? Number(request.emailReminderSentAt)
        : null,
  };

  registerStore(store, meeting);
  return meeting;
};

export const updateScheduledMeeting = (
  store: ScheduledMeetingStore,
  id: string,
  request: UpdateScheduledMeetingRequest,
): ScheduledMeeting => {
  const meeting = store.byId.get(id);
  if (!meeting) {
    throw new Error("Scheduled meeting not found.");
  }
  const now = Date.now();

  // Reactivating a meeting (scheduled or live) must not give a code two
  // active meetings. Checked before anything changes, against the code the
  // meeting will have after this update.
  if (request.status === "scheduled" || request.status === "live") {
    const requestedCode =
      typeof request.roomCode === "string"
        ? sanitizeRoomCode(request.roomCode)
        : "";
    const targetCode = requestedCode || meeting.roomCode;
    if (isCodeTaken(store, meeting.clientId, targetCode, meeting.id)) {
      throw new Error("That meeting code is already booked.");
    }
  }

  if (typeof request.title === "string") {
    const next = sanitizeTitle(request.title);
    if (!next) throw new Error("Title is required.");
    meeting.title = next;
  }
  if (
    typeof request.scheduledStartAt === "number" &&
    Number.isFinite(request.scheduledStartAt) &&
    request.scheduledStartAt > 0
  ) {
    meeting.scheduledStartAt = request.scheduledStartAt;
    if (meeting.scheduledEndAt <= meeting.scheduledStartAt) {
      meeting.scheduledEndAt = meeting.scheduledStartAt + DEFAULT_DURATION_MS;
    }
  }
  if (
    typeof request.scheduledEndAt === "number" &&
    Number.isFinite(request.scheduledEndAt) &&
    request.scheduledEndAt > meeting.scheduledStartAt
  ) {
    meeting.scheduledEndAt = request.scheduledEndAt;
  }
  if (typeof request.roomCode === "string") {
    const nextCode = sanitizeRoomCode(request.roomCode);
    if (nextCode && nextCode !== meeting.roomCode) {
      if (nextCode.length < ROOM_CODE_MIN_LENGTH) {
        throw new Error("Custom code must be at least 3 characters.");
      }
      if (isCodeTaken(store, meeting.clientId, nextCode, meeting.id)) {
        throw new Error("That meeting code is already booked.");
      }
      releaseRoomCode(store, meeting);
      meeting.roomCode = nextCode;
      claimRoomCode(store, meeting);
    }
  }
  if (request.status) {
    meeting.status = request.status;
    if (request.status === "live" && !meeting.startedAt) {
      meeting.startedAt = now;
    }
    if (request.status === "ended" && !meeting.endedAt) {
      meeting.endedAt = now;
    }
    // A reactivated meeting takes its code back from an inactive one.
    claimRoomCode(store, meeting);
  }
  if (request.googleCalendarEventId !== undefined) {
    meeting.googleCalendarEventId =
      request.googleCalendarEventId === null
        ? null
        : sanitizeOptionalText(request.googleCalendarEventId, 512);
  }
  if (request.calendarSyncStatus) {
    meeting.calendarSyncStatus = request.calendarSyncStatus;
  }
  if (request.calendarSyncError !== undefined) {
    meeting.calendarSyncError =
      request.calendarSyncError === null
        ? null
        : sanitizeOptionalText(request.calendarSyncError, 512);
  }
  if (request.emailNotificationStatus) {
    meeting.emailNotificationStatus = normalizeEmailNotificationStatus(
      request.emailNotificationStatus,
    );
  }
  if (request.emailNotificationError !== undefined) {
    meeting.emailNotificationError =
      request.emailNotificationError === null
        ? null
        : sanitizeOptionalText(request.emailNotificationError, 512);
  }
  if (request.emailNotificationSentAt !== undefined) {
    meeting.emailNotificationSentAt =
      request.emailNotificationSentAt === null
        ? null
        : Number.isFinite(Number(request.emailNotificationSentAt)) &&
            Number(request.emailNotificationSentAt) > 0
          ? Number(request.emailNotificationSentAt)
          : null;
  }
  if (request.emailReminderStatus) {
    meeting.emailReminderStatus = normalizeEmailNotificationStatus(
      request.emailReminderStatus,
    );
  }
  if (request.emailReminderError !== undefined) {
    meeting.emailReminderError =
      request.emailReminderError === null
        ? null
        : sanitizeOptionalText(request.emailReminderError, 512);
  }
  if (request.emailReminderSentAt !== undefined) {
    meeting.emailReminderSentAt =
      request.emailReminderSentAt === null
        ? null
        : Number.isFinite(Number(request.emailReminderSentAt)) &&
            Number(request.emailReminderSentAt) > 0
          ? Number(request.emailReminderSentAt)
          : null;
  }

  meeting.updatedAt = now;
  return meeting;
};

export const deleteScheduledMeeting = (
  store: ScheduledMeetingStore,
  id: string,
): ScheduledMeeting | null => {
  const meeting = store.byId.get(id);
  if (!meeting) return null;
  unregisterStore(store, meeting);
  return meeting;
};

export const getScheduledMeetingById = (
  store: ScheduledMeetingStore,
  id: string,
): ScheduledMeeting | null => store.byId.get(id) ?? null;

export const getScheduledMeetingByRoomCode = (
  store: ScheduledMeetingStore,
  clientId: string,
  roomCode: string,
): ScheduledMeeting | null => {
  const owner = store.byRoomCode.get(roomCodeKey(clientId, roomCode));
  return owner ? store.byId.get(owner) ?? null : null;
};

/**
 * Whether `email` (verified, lower case) was invited to the scheduled meeting
 * at this room code, as its host or its booked attendee. Invitees skip the
 * knock, like people on a calendar invite.
 */
export const isScheduledMeetingInvitee = (
  store: ScheduledMeetingStore,
  clientId: string,
  roomCode: string,
  email: string,
): boolean => {
  if (!email) return false;
  const meeting = getScheduledMeetingByRoomCode(store, clientId, roomCode);
  if (!meeting || meeting.status === "cancelled") return false;
  if (meeting.readmissionRequiredEmails?.includes(email)) return false;
  return meeting.hostEmail === email || meeting.attendeeEmail === email;
};

const FRESH_READ_DEADLINE_MS = 1000;

/**
 * Brings this SFU's copy of the meeting at a room code up to date with the
 * store. Each SFU loads meetings when it starts, so without this an SFU that
 * takes over a room would grant entry on invitations another SFU has since
 * changed, such as a removed invitee's. The store's list of removed invitees
 * is taken as it is, whichever copy of the meeting is newer: SFUs change
 * that list in the store one person at a time, never by saving a copy.
 * A store that cannot be read one meeting at a time, or does not answer in
 * a second, leaves the copy as it is: a room must not wait on it.
 */
export const refreshScheduledMeeting = async (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence | null,
  clientId: string,
  roomCode: string,
): Promise<void> => {
  const known = getScheduledMeetingByRoomCode(store, clientId, roomCode);
  if (!known || !persistence?.loadOne) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    const stored = await Promise.race([
      Promise.resolve(persistence.loadOne(known.id)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FRESH_READ_DEADLINE_MS);
      }),
    ]);
    if (!stored) return;
    if (stored.updatedAt > known.updatedAt) {
      unregisterStore(store, known);
      registerStore(store, stored);
    } else {
      known.readmissionRequiredEmails = stored.readmissionRequiredEmails;
    }
  } catch (error) {
    Logger.warn(`Failed to refresh scheduled meeting ${known.id}`, error);
  } finally {
    clearTimeout(timer);
  }
};

// A list of removed invitees with one person added to it, or taken off it.
const withInvitee = (
  removed: string[] | undefined,
  email: string,
  required: boolean,
): string[] => {
  const others = (removed ?? []).filter((candidate) => candidate !== email);
  return required ? [...others, email] : others;
};

/**
 * Records that a host removed an invited person from the meeting at this room
 * code (`required`), or let them in again. Returns the meeting when that
 * changed it, for the caller to persist; null for anyone who was not invited.
 */
export const setScheduledInviteeReadmission = (
  store: ScheduledMeetingStore,
  clientId: string,
  roomCode: string,
  email: string,
  required: boolean,
): ScheduledMeeting | null => {
  const meeting = getScheduledMeetingByRoomCode(store, clientId, roomCode);
  if (!meeting) return null;
  if (meeting.hostEmail !== email && meeting.attendeeEmail !== email) return null;
  const marked = meeting.readmissionRequiredEmails ?? [];
  if (marked.includes(email) === required) return null;
  meeting.readmissionRequiredEmails = withInvitee(marked, email, required);
  return meeting;
};

export const moveScheduledMeetingToClient = (
  store: ScheduledMeetingStore,
  meetingId: string,
  clientId: string,
): ScheduledMeeting | null => {
  const meeting = store.byId.get(meetingId);
  const nextClientId = canonicalizeClientId(clientId);
  if (!meeting || !nextClientId || meeting.clientId === nextClientId) {
    return meeting ?? null;
  }
  if (isCodeTaken(store, nextClientId, meeting.roomCode, meeting.id)) {
    throw new Error("That meeting code already exists in the target client.");
  }
  releaseRoomCode(store, meeting);
  meeting.clientId = nextClientId;
  meeting.updatedAt = Date.now();
  claimRoomCode(store, meeting);
  return meeting;
};

export const listScheduledMeetings = (
  store: ScheduledMeetingStore,
  filter: {
    clientId?: string;
    ownerEmail?: string;
    includeAll?: boolean;
    status?: ScheduledMeetingStatus[];
  },
): ScheduledMeeting[] => {
  const ownerEmail = filter.ownerEmail
    ? filter.ownerEmail.trim().toLowerCase()
    : undefined;
  const result: ScheduledMeeting[] = [];
  for (const meeting of store.byId.values()) {
    if (filter.clientId && meeting.clientId !== filter.clientId) continue;
    if (!filter.includeAll && ownerEmail && meeting.hostEmail !== ownerEmail) {
      continue;
    }
    if (filter.status && !filter.status.includes(meeting.status)) continue;
    result.push(meeting);
  }
  return result.sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
};

export type ScheduledMeetingPersistence = {
  save: (snapshot: ScheduledMeeting[]) => MaybePromise<void>;
  saveChanged?: (meetings: ScheduledMeeting[]) => MaybePromise<void>;
  deleteIds?: (ids: string[]) => MaybePromise<void>;
  reserveBookingSlot?: (
    reservation: BookingSlotReservation,
  ) => MaybePromise<BookingSlotLease | null>;
  claimEmailReminder?: (
    claim: EmailReminderClaim,
  ) => MaybePromise<ScheduledMeeting | null>;
  load: () => MaybePromise<ScheduledMeeting[]>;
  // One meeting as the store holds it now, or null if it holds none by that
  // id. SFUs that share a store read each other's changes through this.
  loadOne?: (id: string) => MaybePromise<ScheduledMeeting | null>;
  // Adds one person to the meeting's removed invitees as the store holds
  // them now, or takes them off. Saves never write that list: they carry an
  // SFU's whole copy of a meeting, and a copy from before a removal would
  // undo it.
  // `at` is when the host acted. Each invitee keeps only the newest decision,
  // a removal or a readmission, so writes land in any order and end at the
  // newest; on a tie the removal stands. A write that is not newer changes
  // nothing.
  setInviteeReadmission?: (
    meetingId: string,
    email: string,
    required: boolean,
    at: number,
  ) => MaybePromise<void>;
  // Takes back the removals of a meeting that is over: those made at or
  // before `endedAt`, also any that arrive after this does. One made for the
  // next meeting, after this end, stays even if this lands later.
  endRemovals?: (meetingId: string, endedAt: number) => MaybePromise<void>;
  close?: () => MaybePromise<void>;
  flush?: () => Promise<void>;
};

type BookingSlotReservation = {
  clientId: string;
  hostEmail: string;
  startAt: number;
  endAt: number;
};

export type BookingSlotLease = {
  release: () => MaybePromise<void>;
};

type EmailReminderClaim = {
  meetingId: string;
  now: number;
  leadMs: number;
};

const scheduledMeetingsSqlitePath = (): string => {
  const configured =
    process.env.SCHEDULED_MEETINGS_SQLITE_PATH?.trim() ||
    process.env.CONCLAVE_SQLITE_PATH?.trim();
  if (configured) return resolve(configured);
  const recordingStoragePath = process.env.RECORDING_STORAGE_PATH?.trim();
  if (recordingStoragePath) {
    return resolve(recordingStoragePath, "conclave.sqlite");
  }
  return resolve(process.cwd(), "data", "conclave.sqlite");
};

const scheduledMeetingsPath = (): string => {
  const configured = process.env.SCHEDULED_MEETINGS_PATH?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd(), "data", "scheduled-meetings.json");
};

const writeJsonAtomic = (path: string, data: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
};

type SqliteStatement = {
  run: (...params: unknown[]) => { changes: number | bigint };
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

const loadNodeSqlite = (): {
  DatabaseSync: new (path: string) => SqliteDatabase;
} => {
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
};

const normalizeStoredMeeting = (raw: unknown): ScheduledMeeting | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.clientId !== "string" || !record.clientId) return null;
  if (typeof record.roomCode !== "string" || !record.roomCode) return null;
  if (typeof record.hostEmail !== "string" || !record.hostEmail) return null;
  const scheduledStartAt = Number(record.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt)) return null;
  const scheduledEndAt = Number.isFinite(Number(record.scheduledEndAt))
    ? Number(record.scheduledEndAt)
    : scheduledStartAt + DEFAULT_DURATION_MS;
  const rawStatus = record.status;
  const status: ScheduledMeetingStatus =
    rawStatus === "live" ||
    rawStatus === "ended" ||
    rawStatus === "cancelled"
      ? rawStatus
      : "scheduled";
  const now = Date.now();
  return {
    id: record.id,
    clientId: canonicalizeClientId(record.clientId),
    roomCode: record.roomCode,
    title: typeof record.title === "string" ? record.title : "Scheduled meeting",
    hostEmail: record.hostEmail,
    hostName: typeof record.hostName === "string" ? record.hostName : "",
    hostUserId: typeof record.hostUserId === "string" ? record.hostUserId : null,
    scheduledStartAt,
    scheduledEndAt,
    status,
    startedAt: Number.isFinite(Number(record.startedAt))
      ? Number(record.startedAt)
      : null,
    endedAt: Number.isFinite(Number(record.endedAt)) ? Number(record.endedAt) : null,
    createdAt: Number.isFinite(Number(record.createdAt))
      ? Number(record.createdAt)
      : now,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : record.hostEmail,
    updatedAt: Number.isFinite(Number(record.updatedAt))
      ? Number(record.updatedAt)
      : now,
    source: record.source === "booking_link" ? "booking_link" : "manual",
    eventTypeId:
      typeof record.eventTypeId === "string" ? record.eventTypeId : null,
    attendeeName:
      typeof record.attendeeName === "string" ? record.attendeeName : null,
    attendeeEmail:
      typeof record.attendeeEmail === "string" ? record.attendeeEmail : null,
    attendeeNote:
      typeof record.attendeeNote === "string" ? record.attendeeNote : null,
    attendeeTimeZone:
      typeof record.attendeeTimeZone === "string"
        ? record.attendeeTimeZone
        : null,
    readmissionRequiredEmails: Array.isArray(record.readmissionRequiredEmails)
      ? record.readmissionRequiredEmails.filter(
          (email): email is string => typeof email === "string",
        )
      : [],
    googleCalendarEventId:
      typeof record.googleCalendarEventId === "string"
        ? record.googleCalendarEventId
        : null,
    calendarSyncStatus:
      record.calendarSyncStatus === "pending" ||
      record.calendarSyncStatus === "synced" ||
      record.calendarSyncStatus === "failed"
        ? record.calendarSyncStatus
        : "not_required",
    calendarSyncError:
      typeof record.calendarSyncError === "string"
        ? record.calendarSyncError
        : null,
    emailNotificationStatus: normalizeEmailNotificationStatus(
      record.emailNotificationStatus,
    ),
    emailNotificationError:
      typeof record.emailNotificationError === "string"
        ? record.emailNotificationError
        : null,
    emailNotificationSentAt: Number.isFinite(
      Number(record.emailNotificationSentAt),
    )
      ? Number(record.emailNotificationSentAt)
      : null,
    emailReminderStatus: normalizeEmailNotificationStatus(
      record.emailReminderStatus,
    ),
    emailReminderError:
      typeof record.emailReminderError === "string"
        ? record.emailReminderError
        : null,
    emailReminderSentAt: Number.isFinite(Number(record.emailReminderSentAt))
      ? Number(record.emailReminderSentAt)
      : null,
  };
};

// A host's decision about an invitee: removed, or let back in.
type InviteeDecision = { removed: boolean; at: number };

// When a removal found inside a meeting's record was made, at the latest:
// before that record was last saved.
const carriedRemovalAt = (meeting: Pick<ScheduledMeeting, "updatedAt">): number =>
  meeting.updatedAt - 1;

// Whether `next` replaces `current`: a newer decision does, and on a tie a
// removal does. So any order of the same decisions ends in the same place.
const replacesDecision = (
  current: InviteeDecision | undefined,
  next: InviteeDecision,
): boolean =>
  !current ||
  next.at > current.at ||
  (next.at === current.at && next.removed && !current.removed);

// A meeting as a save writes it, without its removed invitees (see
// setInviteeReadmission). An SFU from before that list existed writes the
// same, and so cannot undo a removal either.
const meetingRecord = (meeting: object): string =>
  JSON.stringify({ ...meeting, readmissionRequiredEmails: undefined });

// Hands a store the meetings read from another one. Their removed invitees
// go with them: a save alone leaves those behind. They are written first and
// the meetings last, because a store that holds meetings is taken as moved
// already: one cut off half way holds no meetings yet, and is moved again
// the next time the SFU starts.
const handOver = (
  store: ScheduledMeetingPersistence,
  meetings: ScheduledMeeting[],
): void => {
  for (const meeting of meetings) {
    for (const email of meeting.readmissionRequiredEmails ?? []) {
      void store.setInviteeReadmission?.(meeting.id, email, true, carriedRemovalAt(meeting));
    }
  }
  void store.save(meetings);
};

// Removed invitees as a store lists them, one (meeting, email) pair at a
// time, gathered by meeting.
const removedInviteesByMeeting = (
  pairs: Array<[meetingId: string, email: string]>,
): Map<string, string[]> => {
  const removed = new Map<string, string[]>();
  for (const [meetingId, email] of pairs) {
    removed.set(meetingId, [...(removed.get(meetingId) ?? []), email]);
  }
  return removed;
};

const textColumn = (row: unknown, column: string): string =>
  row && typeof row === "object" && column in row
    ? String((row as Record<string, unknown>)[column])
    : "";

const createSqliteScheduledMeetingPersistence = (
  path: string = scheduledMeetingsSqlitePath(),
): ScheduledMeetingPersistence => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_meetings (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      room_code TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_start_at INTEGER NOT NULL,
      scheduled_end_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    -- Not unique: a code is reused once its earlier meeting has ended or
    -- been cancelled, and the store keeps both. The unique index made every
    -- save that held both fail, silently, for good.
    DROP INDEX IF EXISTS scheduled_meetings_code_idx;
    CREATE INDEX IF NOT EXISTS scheduled_meetings_client_code_idx
      ON scheduled_meetings(client_id, room_code);
    CREATE INDEX IF NOT EXISTS scheduled_meetings_status_start_idx
      ON scheduled_meetings(status, scheduled_start_at);
    -- Each invitee's newest decision: removed_at is when the host made it,
    -- readmitted whether it let them back in.
    CREATE TABLE IF NOT EXISTS scheduled_meeting_removed_invitees (
      meeting_id TEXT NOT NULL,
      email TEXT NOT NULL,
      removed_at INTEGER NOT NULL DEFAULT 0,
      readmitted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (meeting_id, email)
    );
    -- When a meeting was last over: removals made up to then count for nothing.
    CREATE TABLE IF NOT EXISTS scheduled_meeting_removals_ended (
      meeting_id TEXT PRIMARY KEY,
      ended_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_meeting_removals_moved (
      meeting_id TEXT PRIMARY KEY
    );
  `);

  // A table made before decisions were stamped lacks these columns.
  for (const column of ["removed_at", "readmitted"]) {
    try {
      db.exec(
        `ALTER TABLE scheduled_meeting_removed_invitees ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // It has it already.
    }
  }

  const insert = db.prepare(`
    INSERT INTO scheduled_meetings (
      id, client_id, room_code, status, scheduled_start_at,
      scheduled_end_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      client_id = excluded.client_id,
      room_code = excluded.room_code,
      status = excluded.status,
      scheduled_start_at = excluded.scheduled_start_at,
      scheduled_end_at = excluded.scheduled_end_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
    WHERE excluded.updated_at >= scheduled_meetings.updated_at
  `);
  const loadRows = db.prepare(`
    SELECT payload_json
    FROM scheduled_meetings
    ORDER BY scheduled_start_at ASC, id ASC
  `);
  const deleteById = db.prepare("DELETE FROM scheduled_meetings WHERE id = ?");
  const loadRowById = db.prepare(
    "SELECT payload_json FROM scheduled_meetings WHERE id = ?",
  );
  // Lands only if newer than the decision stored (see replacesDecision).
  const decide = db.prepare(
    `INSERT INTO scheduled_meeting_removed_invitees (meeting_id, email, removed_at, readmitted)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(meeting_id, email) DO UPDATE
       SET removed_at = excluded.removed_at, readmitted = excluded.readmitted
       WHERE excluded.removed_at > scheduled_meeting_removed_invitees.removed_at
          OR (excluded.removed_at = scheduled_meeting_removed_invitees.removed_at
              AND excluded.readmitted < scheduled_meeting_removed_invitees.readmitted)`,
  );
  const markEnded = db.prepare(
    `INSERT INTO scheduled_meeting_removals_ended (meeting_id, ended_at) VALUES (?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET ended_at = MAX(ended_at, excluded.ended_at)`,
  );
  const clearEndedDecisions = db.prepare(
    `DELETE FROM scheduled_meeting_removed_invitees
     WHERE meeting_id = ? AND removed_at <= (
       SELECT ended_at FROM scheduled_meeting_removals_ended WHERE meeting_id = ?
     )`,
  );
  const forgetRemovedInvitees = db.prepare(
    "DELETE FROM scheduled_meeting_removed_invitees WHERE meeting_id = ?",
  );
  const forgetEnded = db.prepare(
    "DELETE FROM scheduled_meeting_removals_ended WHERE meeting_id = ?",
  );
  // The invitees whose newest decision removed them, after the meeting was
  // last over.
  const stillRemoved = `
    SELECT r.meeting_id AS meeting_id, r.email AS email
    FROM scheduled_meeting_removed_invitees r
    LEFT JOIN scheduled_meeting_removals_ended e ON e.meeting_id = r.meeting_id
    WHERE r.readmitted = 0 AND r.removed_at > COALESCE(e.ended_at, -1)`;
  const loadRemovedInvitees = db.prepare(stillRemoved);
  const loadRemovedInviteesOf = db.prepare(`${stillRemoved} AND r.meeting_id = ?`);
  const takeCarriedRemovals = db.prepare(
    "UPDATE scheduled_meetings SET payload_json = ? WHERE id = ? AND payload_json = ?",
  );
  const markRemovalsMoved = db.prepare(
    "INSERT OR IGNORE INTO scheduled_meeting_removals_moved (meeting_id) VALUES (?)",
  );
  const removalsMoved = db.prepare(
    "SELECT 1 AS moved FROM scheduled_meeting_removals_moved WHERE meeting_id = ?",
  );
  const forgetRemovalsMoved = db.prepare(
    "DELETE FROM scheduled_meeting_removals_moved WHERE meeting_id = ?",
  );
  let knownIds = new Set<string>();

  const upsertMeeting = (meeting: ScheduledMeeting): void => {
    insert.run(
      meeting.id,
      meeting.clientId,
      meeting.roomCode,
      meeting.status,
      meeting.scheduledStartAt,
      meeting.scheduledEndAt,
      meeting.updatedAt,
      meetingRecord(meeting),
    );
  };
  const deleteMeeting = (id: string): void => {
    deleteById.run(id);
    forgetRemovedInvitees.run(id);
    forgetEnded.run(id);
    forgetRemovalsMoved.run(id);
  };
  // A row written before removed invitees had a table of their own carries
  // them inside the meeting. Reading such a row moves them to the table and
  // takes them out of the row, in one step. Left in the row they would come
  // back at every read, also after a host had let the person in again.
  //
  // Once a meeting's removed invitees live in the table it is marked so, and
  // a list found inside its row after that is ignored: it can only be an old
  // copy saved by an earlier build, which would block people a host has let
  // back in since. The mark is kept beside the table, where no save of a
  // meeting reaches it.
  const readRow = (row: unknown): ScheduledMeeting | null => {
    const payload = textColumn(row, "payload_json");
    const meeting = payload ? normalizeStoredMeeting(JSON.parse(payload)) : null;
    const carried = meeting?.readmissionRequiredEmails ?? [];
    if (!meeting || carried.length === 0) return meeting;
    try {
      db.exec("BEGIN IMMEDIATE");
      const alreadyMoved = removalsMoved.get(meeting.id) !== undefined;
      const taken = takeCarriedRemovals.run(
        meetingRecord(JSON.parse(payload) as object),
        meeting.id,
        payload,
      );
      if (Number(taken.changes) > 0 && !alreadyMoved) {
        for (const email of carried) {
          decide.run(meeting.id, email, carriedRemovalAt(meeting), 0);
        }
        markRemovalsMoved.run(meeting.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      Logger.error("Failed to move a meeting's removed invitees to their table", error);
    }
    return meeting;
  };

  return {
    save: (snapshot) => {
      try {
        const snapshotIds = new Set(snapshot.map((meeting) => meeting.id));
        db.exec("BEGIN IMMEDIATE");
        for (const meeting of snapshot) {
          upsertMeeting(meeting);
        }
        for (const id of knownIds) {
          if (!snapshotIds.has(id)) {
            deleteMeeting(id);
          }
        }
        db.exec("COMMIT");
        knownIds = snapshotIds;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to persist scheduled meetings", error);
      }
    },
    saveChanged: (meetings) => {
      if (meetings.length === 0) return;
      try {
        db.exec("BEGIN IMMEDIATE");
        for (const meeting of meetings) {
          upsertMeeting(meeting);
          knownIds.add(meeting.id);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to persist changed scheduled meetings", error);
      }
    },
    deleteIds: (ids) => {
      if (ids.length === 0) return;
      try {
        db.exec("BEGIN IMMEDIATE");
        for (const id of ids) {
          deleteMeeting(id);
          knownIds.delete(id);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to delete scheduled meetings", error);
      }
    },
    load: () => {
      try {
        const meetings = loadRows
          .all()
          .map(readRow)
          .filter((entry): entry is ScheduledMeeting => Boolean(entry));
        const removed = removedInviteesByMeeting(
          loadRemovedInvitees
            .all()
            .map((row) => [textColumn(row, "meeting_id"), textColumn(row, "email")]),
        );
        for (const meeting of meetings) {
          meeting.readmissionRequiredEmails = removed.get(meeting.id) ?? [];
        }
        knownIds = new Set(meetings.map((meeting) => meeting.id));
        return meetings;
      } catch (error) {
        Logger.error("Failed to load scheduled meetings", error);
        return [];
      }
    },
    loadOne: (id) => {
      const meeting = readRow(loadRowById.get(id));
      if (meeting) {
        meeting.readmissionRequiredEmails = loadRemovedInviteesOf
          .all(id)
          .map((row) => textColumn(row, "email"));
      }
      return meeting;
    },
    setInviteeReadmission: (meetingId, email, required, at) => {
      try {
        db.exec("BEGIN IMMEDIATE");
        decide.run(meetingId, email, at, required ? 0 : 1);
        markRemovalsMoved.run(meetingId);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to persist a removed invitee", error);
      }
    },
    endRemovals: (meetingId, endedAt) => {
      try {
        db.exec("BEGIN IMMEDIATE");
        markEnded.run(meetingId, endedAt);
        clearEndedDecisions.run(meetingId, meetingId);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to take back a meeting's removals", error);
      }
    },
    close: () => db.close(),
  };
};

const readStoredMeetings = (path: string): ScheduledMeeting[] => {
  if (!existsSync(path)) return [];
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => normalizeStoredMeeting(entry))
    .filter((entry): entry is ScheduledMeeting => Boolean(entry));
};

// The meetings in the file as stored, every field kept. A file that cannot
// be read holds none, and the write about to replace it goes ahead.
const readRawMeetings = (path: string): Record<string, unknown>[] => {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data)
      ? data.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
        )
      : [];
  } catch {
    return [];
  }
};

type StoredDecisions = {
  decisions: Record<string, InviteeDecision>;
  // When the meeting was last over, if it was.
  endedAt: number | null;
};

// A stored meeting's decisions about its invitees. A file written before
// decisions were kept lists the removed invitees only: each was removed, at
// a time before anything stamped.
const storedDecisionsOf = (raw: Record<string, unknown>): StoredDecisions => {
  const decisions: Record<string, InviteeDecision> = {};
  const stored =
    raw.readmissionDecisions && typeof raw.readmissionDecisions === "object"
      ? (raw.readmissionDecisions as Record<string, unknown>)
      : null;
  if (stored) {
    for (const [email, value] of Object.entries(stored)) {
      const decision = value as { removed?: unknown; at?: unknown } | null;
      if (typeof decision?.removed === "boolean" && typeof decision.at === "number") {
        decisions[email] = { removed: decision.removed, at: decision.at };
      }
    }
  } else if (Array.isArray(raw.readmissionRequiredEmails)) {
    for (const email of raw.readmissionRequiredEmails) {
      if (typeof email !== "string") continue;
      const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 1;
      decisions[email] = { removed: true, at: carriedRemovalAt({ updatedAt }) };
    }
  }
  return {
    decisions,
    endedAt: typeof raw.readmissionEndedAt === "number" ? raw.readmissionEndedAt : null,
  };
};

const stillRemovedIn = ({ decisions, endedAt }: StoredDecisions): string[] =>
  Object.entries(decisions)
    .filter(([, decision]) => decision.removed && decision.at > (endedAt ?? -1))
    .map(([email]) => email);

const withDecisions = (
  meeting: object,
  stored: StoredDecisions,
): Record<string, unknown> => ({
  ...meeting,
  readmissionRequiredEmails: stillRemovedIn(stored),
  readmissionDecisions: stored.decisions,
  readmissionEndedAt: stored.endedAt,
});

// One file holding every meeting, rewritten whole. A save keeps the
// decisions about invitees the file already has. Two SFUs writing it at once
// can still lose each other's whole write, as they always could: this store
// is for one SFU.
const createFileScheduledMeetingPersistence = (
  path: string = scheduledMeetingsPath(),
): ScheduledMeetingPersistence => {
  const rewriteDecisions = (
    meetingId: string,
    change: (stored: StoredDecisions) => StoredDecisions,
  ) => {
    writeJsonAtomic(
      path,
      JSON.stringify(
        readRawMeetings(path).map((raw) =>
          raw.id === meetingId ? withDecisions(raw, change(storedDecisionsOf(raw))) : raw,
        ),
        null,
        2,
      ),
    );
  };
  return {
    save: (snapshot) => {
      try {
        const stored = new Map(
          readRawMeetings(path).map((raw) => [raw.id, storedDecisionsOf(raw)]),
        );
        writeJsonAtomic(
          path,
          JSON.stringify(
            snapshot.map((meeting) =>
              withDecisions(
                meeting,
                stored.get(meeting.id) ?? storedDecisionsOf({ ...meeting }),
              ),
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        Logger.error("Failed to persist scheduled meetings to JSON", error);
      }
    },
    setInviteeReadmission: (meetingId, email, required, at) => {
      try {
        rewriteDecisions(meetingId, (stored) => {
          const next = { removed: required, at };
          if (!replacesDecision(stored.decisions[email], next)) return stored;
          return { ...stored, decisions: { ...stored.decisions, [email]: next } };
        });
      } catch (error) {
        Logger.error("Failed to persist a removed invitee to JSON", error);
      }
    },
    endRemovals: (meetingId, endedAt) => {
      try {
        rewriteDecisions(meetingId, ({ decisions, endedAt: before }) => {
          const over = Math.max(before ?? -1, endedAt);
          return {
            decisions: Object.fromEntries(
              Object.entries(decisions).filter(([, decision]) => decision.at > over),
            ),
            endedAt: over,
          };
        });
      } catch (error) {
        Logger.error("Failed to take back a meeting's removals in JSON", error);
      }
    },
  load: () => {
    try {
      return readStoredMeetings(path);
    } catch (error) {
      Logger.error("Failed to load scheduled meetings from JSON", error);
      return [];
    }
  },
  loadOne: (id) =>
    readStoredMeetings(path).find((meeting) => meeting.id === id) ?? null,
  };
};

const RELEASE_BOOKING_SLOT_LOCK_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]
if redis.call("GET", key) == token then
  return redis.call("DEL", key)
end
return 0
`;

const CLAIM_EMAIL_REMINDER_SCRIPT = `
local key = KEYS[1]
local meetingId = ARGV[1]
local now = tonumber(ARGV[2]) or 0
local leadMs = tonumber(ARGV[3]) or 0

if leadMs <= 0 then
  return nil
end

local payload = redis.call("HGET", key, meetingId)
if not payload then
  return nil
end

local ok, meeting = pcall(cjson.decode, payload)
if not ok or type(meeting) ~= "table" then
  return nil
end

if meeting["source"] ~= "booking_link" then
  return nil
end
if meeting["status"] ~= "scheduled" then
  return nil
end
if type(meeting["attendeeEmail"]) ~= "string" or meeting["attendeeEmail"] == "" then
  return nil
end

local reminderStatus = meeting["emailReminderStatus"]
if reminderStatus == "pending" or reminderStatus == "sent" or reminderStatus == "failed" then
  return nil
end

local scheduledStartAt = tonumber(meeting["scheduledStartAt"]) or 0
local createdAt = tonumber(meeting["createdAt"]) or 0
local reminderDueAt = scheduledStartAt - leadMs
if createdAt > reminderDueAt then
  return nil
end
if now < reminderDueAt or now >= scheduledStartAt then
  return nil
end

meeting["emailReminderStatus"] = "pending"
meeting["emailReminderError"] = cjson.null
meeting["emailReminderSentAt"] = cjson.null
meeting["updatedAt"] = now

local nextPayload = cjson.encode(meeting)
redis.call("HSET", key, meetingId, nextPayload)
return nextPayload
`;

// Moves the removed invitees a meeting's record still carries into their
// set, and takes them out of the record, only if the record still is the one
// that was read. Otherwise another SFU has moved them already, and a host may
// have let someone back in since. A meeting already marked as moved keeps
// its set as it is: a list inside its record then is an old copy.
//
// Redis does not undo a script's earlier writes when a later one fails, so
// everything that could fail is checked first and the record is rewritten
// last. A failure leaves the record with its list, for the next read.
const MOVE_CARRIED_REMOVALS_SCRIPT = `
local function holds(key, kind)
  local found = redis.call("TYPE", key).ok
  return found == kind or found == "none"
end
if not holds(KEYS[1], "hash") or not holds(KEYS[2], "hash") or not holds(KEYS[3], "set") then
  return redis.error_reply("WRONGTYPE removed invitees cannot be moved")
end
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then
  return 0
end
if redis.call("SISMEMBER", KEYS[3], ARGV[1]) == 0 then
  for i = 5, #ARGV do
    redis.call("HSETNX", KEYS[2], ARGV[i], ARGV[4] .. ":removed")
  end
  redis.call("SADD", KEYS[3], ARGV[1])
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])
return 1
`;

// An invitee's decision is "<when>:removed" or "<when>:readmitted". A write
// lands only if newer than the one stored (see replacesDecision).
const DECIDE_SCRIPT = `
local stored = redis.call("HGET", KEYS[1], ARGV[1])
local at = tonumber(ARGV[2])
local replaces = true
if stored then
  local storedAt, storedState = string.match(stored, "^(%d+):(%a+)$")
  storedAt = tonumber(storedAt)
  if storedAt ~= nil then
    replaces = at > storedAt or (at == storedAt and ARGV[3] == "removed" and storedState ~= "removed")
  end
end
if replaces then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2] .. ":" .. ARGV[3])
end
redis.call("SADD", KEYS[2], ARGV[4])
return replaces and 1 or 0
`;

// Marks a meeting over at the latest end it has had, and clears the
// decisions made up to then. A removal made up to then that arrives later
// still counts for nothing; one made after stays.
const END_REMOVALS_SCRIPT = `
local endedAt = tonumber(ARGV[2])
local before = tonumber(redis.call("HGET", KEYS[2], ARGV[1]))
if before ~= nil and before > endedAt then
  endedAt = before
end
redis.call("HSET", KEYS[2], ARGV[1], string.format("%.0f", endedAt))
local decided = redis.call("HGETALL", KEYS[1])
local prefix = ARGV[1] .. " "
for i = 1, #decided, 2 do
  if string.sub(decided[i], 1, #prefix) == prefix then
    local at = tonumber(string.match(decided[i + 1], "^(%d+)"))
    if at == nil or at <= endedAt then
      redis.call("HDEL", KEYS[1], decided[i])
    end
  end
end
return 1
`;

const bookingSlotLockTtlMs = (): number => {
  const parsed = Number(process.env.SFU_BOOKING_SLOT_LOCK_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 30000;
};

const bookingSlotLockKey = (
  keyPrefix: string,
  reservation: BookingSlotReservation,
): string => {
  const raw = [reservation.clientId, reservation.hostEmail.toLowerCase()].join("|");
  return `${keyPrefix}:booking-slot-lock:${Buffer.from(raw).toString("base64url")}`;
};

class RedisScheduledMeetingPersistence implements ScheduledMeetingPersistence {
  private client: RedisPersistenceClient;
  private fallback: ScheduledMeetingPersistence;
  private key: string;
  private keyPrefix: string;
  private startPromise: Promise<void> | null = null;
  private started = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  private knownMeetings = new Map<string, ScheduledMeeting>();

  constructor(options: {
    redisUrl: string;
    keyPrefix: string;
    fallback: ScheduledMeetingPersistence;
  }) {
    this.client = createRedisPersistenceClient(
      "ScheduledMeetings",
      options.redisUrl,
    );
    this.fallback = options.fallback;
    this.keyPrefix = options.keyPrefix;
    this.key = `${options.keyPrefix}:scheduled-meetings`;
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
      Logger.success("[ScheduledMeetings] Redis persistence connected");
    })();

    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  // Each invitee's newest decision is a field of one hash, "<meeting id>
  // <email>" (see DECIDE_SCRIPT). No save of a meeting touches it.
  private get removedInviteesKey(): string {
    return `${this.key}:removed-invitees`;
  }

  // When each meeting was last over (see END_REMOVALS_SCRIPT).
  private get removalsEndedKey(): string {
    return `${this.key}:removed-invitees-ended`;
  }

  // Meetings whose removed invitees live in that set, so a list found inside
  // their record is an old copy (see MOVE_CARRIED_REMOVALS_SCRIPT).
  private get removalsMovedKey(): string {
    return `${this.key}:removed-invitees-moved`;
  }

  private removedInvitee(meetingId: string, email: string): string {
    return `${meetingId} ${email}`;
  }

  // Every decision stored, by "<meeting id> <email>".
  private async decisions(): Promise<Map<string, InviteeDecision>> {
    const decided = await this.client.hGetAll(this.removedInviteesKey);
    return new Map(
      Object.entries(decided).map(([member, value]) => {
        const [at, state] = value.split(":");
        return [member, { removed: state !== "readmitted", at: Number(at) || 0 }];
      }),
    );
  }

  // The invitees whose newest decision removed them after their meeting was
  // last over.
  private async removedInvitees(): Promise<Map<string, string[]>> {
    const [decisions, ended] = await Promise.all([
      this.decisions(),
      this.client.hGetAll(this.removalsEndedKey),
    ]);
    const removed: Array<[meetingId: string, email: string]> = [];
    for (const [member, decision] of decisions) {
      const split = member.indexOf(" ");
      const meetingId = member.slice(0, split);
      const endedAt = Number(ended[meetingId] ?? -1);
      if (decision.removed && decision.at > endedAt) {
        removed.push([meetingId, member.slice(split + 1)]);
      }
    }
    return removedInviteesByMeeting(removed);
  }

  // A record written before removed invitees had a set of their own carries
  // them inside the meeting. Reading one moves them to the set and takes them
  // out of the record, in one step. Left there they would come back at every
  // read, also after a host had let the person in again. Callers take the
  // meeting's removed invitees from the set.
  private async readRecord(record: string): Promise<ScheduledMeeting | null> {
    const meeting = normalizeStoredMeeting(JSON.parse(record));
    const carried = meeting?.readmissionRequiredEmails ?? [];
    if (!meeting || carried.length === 0) return meeting;
    const moved = await this.client.sendCommand([
      "EVAL",
      MOVE_CARRIED_REMOVALS_SCRIPT,
      "3",
      this.key,
      this.removedInviteesKey,
      this.removalsMovedKey,
      meeting.id,
      record,
      meetingRecord(JSON.parse(record) as object),
      String(carriedRemovalAt(meeting)),
      ...carried.map((email) => this.removedInvitee(meeting.id, email)),
    ]);
    if (Number(moved) === 1) {
      for (const email of carried) {
        void this.fallback.setInviteeReadmission?.(
          meeting.id,
          email,
          true,
          carriedRemovalAt(meeting),
        );
      }
    }
    return meeting;
  }

  private async withRemovedInvitees(
    meeting: ScheduledMeeting,
  ): Promise<ScheduledMeeting> {
    const removed = await this.removedInvitees();
    meeting.readmissionRequiredEmails = removed.get(meeting.id) ?? [];
    return meeting;
  }

  save(snapshot: ScheduledMeeting[]): void {
    this.knownMeetings = new Map(snapshot.map((meeting) => [meeting.id, meeting]));
    void this.fallback.save(snapshot);
    const payload = snapshot.map((meeting) => [
      meeting.id,
      meetingRecord(meeting),
    ] as const);
    this.queueWrite("save snapshot", async () => {
      const transaction = this.client.multi();
      transaction.del(this.key);
      if (payload.length > 0) {
        transaction.hSet(this.key, Object.fromEntries(payload));
      }
      await transaction.exec();
    });
  }

  saveChanged(meetings: ScheduledMeeting[]): void {
    if (meetings.length === 0) return;
    for (const meeting of meetings) {
      this.knownMeetings.set(meeting.id, meeting);
    }
    void this.fallback.save(Array.from(this.knownMeetings.values()));
    const payload = Object.fromEntries(
      meetings.map((meeting) => [meeting.id, meetingRecord(meeting)]),
    );
    this.queueWrite("save changed meetings", async () => {
      await this.client.hSet(this.key, payload);
    });
  }

  setInviteeReadmission(
    meetingId: string,
    email: string,
    required: boolean,
    at: number,
  ): void {
    void this.fallback.setInviteeReadmission?.(meetingId, email, required, at);
    const member = this.removedInvitee(meetingId, email);
    this.queueWrite("set a removed invitee", async () => {
      await this.client.sendCommand([
        "EVAL",
        DECIDE_SCRIPT,
        "2",
        this.removedInviteesKey,
        this.removalsMovedKey,
        member,
        String(at),
        required ? "removed" : "readmitted",
        meetingId,
      ]);
    });
  }

  endRemovals(meetingId: string, endedAt: number): void {
    void this.fallback.endRemovals?.(meetingId, endedAt);
    this.queueWrite("end a meeting's removals", async () => {
      await this.client.sendCommand([
        "EVAL",
        END_REMOVALS_SCRIPT,
        "2",
        this.removedInviteesKey,
        this.removalsEndedKey,
        meetingId,
        String(endedAt),
      ]);
    });
  }

  deleteIds(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.knownMeetings.delete(id);
    }
    void this.fallback.save(Array.from(this.knownMeetings.values()));
    this.queueWrite("delete meetings", async () => {
      await this.client.hDel(this.key, ids);
      const gone = [...(await this.decisions()).keys()].filter((member) =>
        ids.includes(member.slice(0, member.indexOf(" "))),
      );
      if (gone.length > 0) await this.client.hDel(this.removedInviteesKey, gone);
      await this.client.hDel(this.removalsEndedKey, ids);
      await this.client.sRem(this.removalsMovedKey, ids);
    });
  }

  async reserveBookingSlot(
    reservation: BookingSlotReservation,
  ): Promise<BookingSlotLease | null> {
    await this.start();
    const key = bookingSlotLockKey(this.keyPrefix, reservation);
    const token = randomUUID();
    const result = await this.client.sendCommand([
      "SET",
      key,
      token,
      "PX",
      String(bookingSlotLockTtlMs()),
      "NX",
    ]);
    if (String(result) !== "OK") return null;
    return {
      release: async () => {
        await this.client.sendCommand([
          "EVAL",
          RELEASE_BOOKING_SLOT_LOCK_SCRIPT,
          "1",
          key,
          token,
        ]);
      },
    };
  }

  async claimEmailReminder(
    claim: EmailReminderClaim,
  ): Promise<ScheduledMeeting | null> {
    await this.start();
    const result = await this.client.sendCommand([
      "EVAL",
      CLAIM_EMAIL_REMINDER_SCRIPT,
      "1",
      this.key,
      claim.meetingId,
      String(claim.now),
      String(claim.leadMs),
    ]);
    if (typeof result !== "string" || !result) return null;
    const claimed = await this.readRecord(result);
    if (!claimed) return null;
    const meeting = await this.withRemovedInvitees(claimed);
    this.knownMeetings.set(meeting.id, meeting);
    if (this.fallback.saveChanged) {
      await Promise.resolve(this.fallback.saveChanged([meeting]));
    } else {
      await Promise.resolve(
        this.fallback.save(Array.from(this.knownMeetings.values())),
      );
    }
    return meeting;
  }

  async loadOne(id: string): Promise<ScheduledMeeting | null> {
    await this.start();
    // After this SFU's own writes have gone out, so it never reads past one.
    await this.flush().catch(() => undefined);
    const payload = await this.client.hGet(this.key, id);
    const meeting = payload ? await this.readRecord(payload) : null;
    return meeting ? this.withRemovedInvitees(meeting) : null;
  }

  async load(): Promise<ScheduledMeeting[]> {
    try {
      await this.start();
      const values = await this.client.hVals(this.key);
      if (values.length > 0) {
        const meetings: ScheduledMeeting[] = [];
        for (const value of values) {
          const meeting = await this.readRecord(value);
          if (meeting) meetings.push(meeting);
        }
        const removed = await this.removedInvitees();
        for (const meeting of meetings) {
          meeting.readmissionRequiredEmails = removed.get(meeting.id) ?? [];
        }
        this.knownMeetings = new Map(
          meetings.map((meeting) => [meeting.id, meeting]),
        );
        return meetings;
      }

      const fallbackMeetings = await this.fallback.load();
      this.knownMeetings = new Map(
        fallbackMeetings.map((meeting) => [meeting.id, meeting]),
      );
      if (fallbackMeetings.length > 0) {
        handOver(this, fallbackMeetings);
        await this.flush();
        Logger.info(
          `Migrated ${fallbackMeetings.length} scheduled meeting(s) into Redis persistence`,
        );
      }
      return fallbackMeetings;
    } catch (error) {
      Logger.error(
        "Failed to load scheduled meetings from Redis; falling back to local persistence",
        error,
      );
      const fallbackMeetings = await this.fallback.load();
      this.knownMeetings = new Map(
        fallbackMeetings.map((meeting) => [meeting.id, meeting]),
      );
      return fallbackMeetings;
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
      Logger.error(`Failed to persist scheduled meetings to Redis (${label})`, error);
      throw error;
    });
  }
}

const createRedisScheduledMeetingPersistence = (
  redisUrl: string = resolveRedisPersistenceUrl(),
  keyPrefix: string = resolveRedisPersistenceKeyPrefix(),
  fallback: ScheduledMeetingPersistence = createSqliteScheduledMeetingPersistence(),
): ScheduledMeetingPersistence =>
  new RedisScheduledMeetingPersistence({ redisUrl, keyPrefix, fallback });

const migrateJsonScheduledMeetingsToSqlite = (
  sqlite: ScheduledMeetingPersistence,
  json: ScheduledMeetingPersistence,
): number => {
  const existing = sqlite.load() as ScheduledMeeting[];
  if (existing.length > 0) return 0;

  const legacy = json.load() as ScheduledMeeting[];
  if (legacy.length === 0) return 0;

  handOver(sqlite, legacy);
  return (sqlite.load() as ScheduledMeeting[]).length;
};

export const createScheduledMeetingPersistence = (): ScheduledMeetingPersistence => {
  const mode = process.env.SCHEDULED_MEETINGS_PERSISTENCE?.trim().toLowerCase();
  if (mode === "json" || mode === "file") {
    return createFileScheduledMeetingPersistence();
  }

  const jsonPersistence = createFileScheduledMeetingPersistence();
  const redisUrl = resolveRedisPersistenceUrl();

  try {
    const sqlitePersistence = createSqliteScheduledMeetingPersistence();
    const migrated = migrateJsonScheduledMeetingsToSqlite(
      sqlitePersistence,
      jsonPersistence,
    );
    if (migrated > 0) {
      Logger.info(
        `Migrated ${migrated} scheduled meeting(s) from JSON into SQLite`,
      );
    }
    if (shouldUseRedisPersistence(mode, redisUrl)) {
      if (!redisUrl) {
        throw new Error(
          "SCHEDULED_MEETINGS_PERSISTENCE=redis requires SFU_PERSISTENCE_REDIS_URL, SFU_REDIS_URL, or REDIS_URL.",
        );
      }
      return createRedisScheduledMeetingPersistence(
        redisUrl,
        resolveRedisPersistenceKeyPrefix(),
        sqlitePersistence,
      );
    }
    return sqlitePersistence;
  } catch (error) {
    if (mode === "sqlite") {
      throw error;
    }
    Logger.warn(
      `SQLite scheduled-meeting persistence unavailable; falling back to JSON: ${(error as Error).message}`,
    );
    if (shouldUseRedisPersistence(mode, redisUrl)) {
      if (!redisUrl) {
        throw new Error(
          "SCHEDULED_MEETINGS_PERSISTENCE=redis requires SFU_PERSISTENCE_REDIS_URL, SFU_REDIS_URL, or REDIS_URL.",
        );
      }
      return createRedisScheduledMeetingPersistence(
        redisUrl,
        resolveRedisPersistenceKeyPrefix(),
        jsonPersistence,
      );
    }
    return jsonPersistence;
  }
};

export const loadPersistedMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
): Promise<number> => Promise.resolve(persistence.load()).then((meetings) => {
  for (const meeting of meetings) {
    registerStore(store, meeting);
  }
  return meetings.length;
});

const persistScheduledMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
): Promise<void> =>
  Promise.resolve(persistence.save(Array.from(store.byId.values()))).then(() =>
    persistence.flush?.(),
  );

export const persistScheduledMeetingChanges = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
  meetings: ScheduledMeeting[],
): Promise<void> => {
  if (meetings.length === 0) return Promise.resolve();
  if (persistence.saveChanged) {
    return Promise.resolve(persistence.saveChanged(meetings)).then(() =>
      persistence.flush?.(),
    );
  }
  return persistScheduledMeetings(store, persistence);
};

/**
 * The meeting at this room code is over: the people a host removed from it
 * are invited again. Only the removals made up to `endedAt` are taken back,
 * so a removal another SFU makes for the next meeting is never undone by
 * this one arriving late. The end is saved even when this SFU knows of no
 * removal: one another SFU made before it may still be on its way.
 */
export const endScheduledMeetingRemovals = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence | null,
  clientId: string,
  roomCode: string,
  endedAt: number,
): Promise<void> => {
  const meeting = getScheduledMeetingByRoomCode(store, clientId, roomCode);
  if (!meeting) return Promise.resolve();
  const hadRemovals = (meeting.readmissionRequiredEmails ?? []).length > 0;
  meeting.readmissionRequiredEmails = [];
  if (!persistence) return Promise.resolve();
  if (!persistence.endRemovals) {
    return hadRemovals
      ? persistScheduledMeetingChanges(store, persistence, [meeting])
      : Promise.resolve();
  }
  return Promise.resolve(persistence.endRemovals(meeting.id, endedAt)).then(() =>
    persistence.flush?.(),
  );
};

// The time of this SFU's last decision about each invitee of a meeting, so
// its own decisions about one person never share a time and land in the
// order it made them.
const lastDecisionAt = new WeakMap<ScheduledMeeting, Map<string, number>>();
const decisionTime = (meeting: ScheduledMeeting, email: string): number => {
  const made = lastDecisionAt.get(meeting) ?? new Map<string, number>();
  lastDecisionAt.set(meeting, made);
  const at = Math.max(Date.now(), (made.get(email) ?? 0) + 1);
  made.set(email, at);
  return at;
};

// Stores one invitee's removal, or the end of it. A store with no write of
// its own for that gets the whole meeting, removed invitees included.
export const persistInviteeReadmission = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
  meeting: ScheduledMeeting,
  email: string,
  required: boolean,
): Promise<void> => {
  if (!persistence.setInviteeReadmission) {
    return persistScheduledMeetingChanges(store, persistence, [meeting]);
  }
  return Promise.resolve(
    persistence.setInviteeReadmission(
      meeting.id,
      email,
      required,
      decisionTime(meeting, email),
    ),
  ).then(() => persistence.flush?.());
};

export const persistScheduledMeetingDeletes = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
  ids: string[],
): Promise<void> => {
  if (ids.length === 0) return Promise.resolve();
  if (persistence.deleteIds) {
    return Promise.resolve(persistence.deleteIds(ids)).then(() =>
      persistence.flush?.(),
    );
  }
  return persistScheduledMeetings(store, persistence);
};

export const advanceScheduledMeetings = (
  store: ScheduledMeetingStore,
  now = Date.now(),
): ScheduledMeeting[] => {
  const changed: ScheduledMeeting[] = [];
  for (const meeting of store.byId.values()) {
    if (meeting.status === "scheduled" && now >= meeting.scheduledStartAt) {
      meeting.status = "live";
      if (!meeting.startedAt) meeting.startedAt = now;
      meeting.updatedAt = now;
      changed.push(meeting);
    } else if (meeting.status === "live" && now >= meeting.scheduledEndAt) {
      meeting.status = "ended";
      if (!meeting.endedAt) meeting.endedAt = now;
      meeting.updatedAt = now;
      changed.push(meeting);
    }
  }
  return changed;
};

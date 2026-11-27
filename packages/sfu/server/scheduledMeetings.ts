import type {
  CreateScheduledMeetingRequest,
  ScheduledMeeting,
  ScheduledMeetingEmailNotificationStatus,
  ScheduledMeetingStatus,
  UpdateScheduledMeetingRequest,
} from "../types.js";
import { asRecord } from "../utilities/untrusted.js";
import { InvalidInput } from "./controlPlane/model.js";
import { canonicalizeClientId } from "./clientIds.js";
import { generateMeetingCode } from "./meetingCodes.js";
import { storedTimestampOrNull } from "./storedValues.js";

const MAX_TITLE_LENGTH = 140;
const MIN_TITLE_LENGTH = 1;
const ROOM_CODE_MIN_LENGTH = 3;
const ROOM_CODE_MAX_LENGTH = 64;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const ROOM_CODE_ATTEMPTS = 64;

export const ROOM_CODE_TAKEN_MESSAGE =
  "That meeting code is already booked for another scheduled meeting.";

const sanitizeTitle = (value: string | undefined): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, MAX_TITLE_LENGTH);
};

export const sanitizeRoomCode = (value: string | undefined): string => {
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

const positiveStampOrNull = (value: unknown): number | null =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export const isActiveMeetingStatus = (status: ScheduledMeetingStatus): boolean =>
  status === "scheduled" || status === "live";

export type CreateScheduledMeetingOptions = {
  clientId: string;
  createdBy: string;
  defaultHostEmail: string;
  defaultHostName?: string;
  defaultHostUserId: string | null;
};

export type RoomCodeOwner = (clientId: string, roomCode: string) => string | null;

const pickRoomCode = (
  request: CreateScheduledMeetingRequest,
  clientId: string,
  activeOwner: RoomCodeOwner,
  random: (max: number) => number,
): string => {
  const requested = sanitizeRoomCode(request.roomCode);
  if (requested) {
    if (requested.length < ROOM_CODE_MIN_LENGTH) {
      throw new InvalidInput("Custom code must be at least 3 characters.");
    }
    if (activeOwner(clientId, requested)) throw new InvalidInput(ROOM_CODE_TAKEN_MESSAGE);
    return requested;
  }
  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    const candidate = generateMeetingCode(random);
    if (!activeOwner(clientId, candidate)) return candidate;
  }
  throw new InvalidInput("Could not pick a free meeting code. Try again.");
};

export const buildScheduledMeeting = (
  request: CreateScheduledMeetingRequest,
  options: CreateScheduledMeetingOptions,
  context: { id: string; now: number; random: (max: number) => number; activeOwner: RoomCodeOwner },
): ScheduledMeeting => {
  const clientId = canonicalizeClientId(options.clientId);
  const title = sanitizeTitle(request.title);
  if (!title || title.length < MIN_TITLE_LENGTH) {
    throw new InvalidInput("Title is required.");
  }

  const scheduledStartAt = Number(request.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt) || scheduledStartAt <= 0) {
    throw new InvalidInput("Invalid scheduled start time.");
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
  const hostEmail = requestHostEmailIsValid ? requestedHostEmail : fallbackHostEmail;
  if (!hostEmail || !hostEmail.includes("@")) {
    throw new InvalidInput("Host email is required.");
  }

  const hostName =
    sanitizeTitle(request.hostName) || sanitizeTitle(options.defaultHostName) || "";
  const roomCode = pickRoomCode(request, clientId, context.activeOwner, context.random);

  return {
    id: context.id,
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
    createdAt: context.now,
    createdBy: options.createdBy,
    updatedAt: context.now,
    source: request.source === "booking_link" ? "booking_link" : "manual",
    eventTypeId: sanitizeOptionalText(request.eventTypeId, 128),
    attendeeName: sanitizeOptionalText(request.attendeeName, 120),
    attendeeEmail: sanitizeOptionalEmail(request.attendeeEmail),
    attendeeNote: sanitizeOptionalText(request.attendeeNote, 2000),
    attendeeTimeZone: sanitizeOptionalText(request.attendeeTimeZone, 80),
    googleCalendarEventId: sanitizeOptionalText(request.googleCalendarEventId, 512),
    calendarSyncStatus: request.calendarSyncStatus ?? "not_required",
    calendarSyncError: sanitizeOptionalText(request.calendarSyncError ?? undefined, 512),
    emailNotificationStatus: normalizeEmailNotificationStatus(
      request.emailNotificationStatus,
    ),
    emailNotificationError: sanitizeOptionalText(
      request.emailNotificationError ?? undefined,
      512,
    ),
    emailNotificationSentAt: positiveStampOrNull(request.emailNotificationSentAt),
    emailReminderStatus: normalizeEmailNotificationStatus(request.emailReminderStatus),
    emailReminderError: sanitizeOptionalText(request.emailReminderError ?? undefined, 512),
    emailReminderSentAt: positiveStampOrNull(request.emailReminderSentAt),
  };
};

const nullableText = (value: string | null | undefined, maxLength: number): string | null =>
  value === null ? null : sanitizeOptionalText(value, maxLength);

const nullableStamp = (value: number | null | undefined): number | null =>
  value === null ? null : positiveStampOrNull(value);

export const applyScheduledMeetingUpdate = (
  meeting: ScheduledMeeting,
  request: UpdateScheduledMeetingRequest,
  context: { now: number; activeOwner: RoomCodeOwner },
): ScheduledMeeting => {
  const next: ScheduledMeeting = { ...meeting };
  const takenByOther = (code: string): boolean => {
    const owner = context.activeOwner(meeting.clientId, code);
    return Boolean(owner && owner !== meeting.id);
  };

  if (request.status === "scheduled" || request.status === "live") {
    const requestedCode =
      typeof request.roomCode === "string" ? sanitizeRoomCode(request.roomCode) : "";
    if (takenByOther(requestedCode || meeting.roomCode)) {
      throw new InvalidInput("That meeting code is already booked.");
    }
  }

  if (typeof request.title === "string") {
    const title = sanitizeTitle(request.title);
    if (!title) throw new InvalidInput("Title is required.");
    next.title = title;
  }
  if (
    typeof request.scheduledStartAt === "number" &&
    Number.isFinite(request.scheduledStartAt) &&
    request.scheduledStartAt > 0
  ) {
    next.scheduledStartAt = request.scheduledStartAt;
    if (next.scheduledEndAt <= next.scheduledStartAt) {
      next.scheduledEndAt = next.scheduledStartAt + DEFAULT_DURATION_MS;
    }
  }
  if (
    typeof request.scheduledEndAt === "number" &&
    Number.isFinite(request.scheduledEndAt) &&
    request.scheduledEndAt > next.scheduledStartAt
  ) {
    next.scheduledEndAt = request.scheduledEndAt;
  }
  if (typeof request.roomCode === "string") {
    const nextCode = sanitizeRoomCode(request.roomCode);
    if (nextCode && nextCode !== meeting.roomCode) {
      if (nextCode.length < ROOM_CODE_MIN_LENGTH) {
        throw new InvalidInput("Custom code must be at least 3 characters.");
      }
      if (takenByOther(nextCode)) {
        throw new InvalidInput("That meeting code is already booked.");
      }
      next.roomCode = nextCode;
    }
  }
  if (request.status) {
    next.status = request.status;
    if (request.status === "live" && !next.startedAt) next.startedAt = context.now;
    if (request.status === "ended" && !next.endedAt) next.endedAt = context.now;
  }
  if (request.googleCalendarEventId !== undefined) {
    next.googleCalendarEventId = nullableText(request.googleCalendarEventId, 512);
  }
  if (request.calendarSyncStatus) next.calendarSyncStatus = request.calendarSyncStatus;
  if (request.calendarSyncError !== undefined) {
    next.calendarSyncError = nullableText(request.calendarSyncError, 512);
  }
  if (request.emailNotificationStatus) {
    next.emailNotificationStatus = normalizeEmailNotificationStatus(
      request.emailNotificationStatus,
    );
  }
  if (request.emailNotificationError !== undefined) {
    next.emailNotificationError = nullableText(request.emailNotificationError, 512);
  }
  if (request.emailNotificationSentAt !== undefined) {
    next.emailNotificationSentAt = nullableStamp(request.emailNotificationSentAt);
  }
  if (request.emailReminderStatus) {
    next.emailReminderStatus = normalizeEmailNotificationStatus(request.emailReminderStatus);
  }
  if (request.emailReminderError !== undefined) {
    next.emailReminderError = nullableText(request.emailReminderError, 512);
  }
  if (request.emailReminderSentAt !== undefined) {
    next.emailReminderSentAt = nullableStamp(request.emailReminderSentAt);
  }
  next.updatedAt = context.now;
  return next;
};

export const advanceScheduledMeeting = (
  meeting: ScheduledMeeting,
  now: number,
): ScheduledMeeting | null => {
  if (meeting.status === "scheduled" && now >= meeting.scheduledStartAt) {
    return {
      ...meeting,
      status: "live",
      startedAt: meeting.startedAt || now,
      updatedAt: now,
    };
  }
  if (meeting.status === "live" && now >= meeting.scheduledEndAt) {
    return {
      ...meeting,
      status: "ended",
      endedAt: meeting.endedAt || now,
      updatedAt: now,
    };
  }
  return null;
};

export type ScheduledMeetingFilter = {
  clientId?: string;
  ownerEmail?: string;
  includeAll?: boolean;
  status?: ScheduledMeetingStatus[];
};

export const filterScheduledMeetings = (
  meetings: readonly ScheduledMeeting[],
  filter: ScheduledMeetingFilter,
): ScheduledMeeting[] => {
  const ownerEmail = filter.ownerEmail ? filter.ownerEmail.trim().toLowerCase() : undefined;
  return meetings
    .filter((meeting) => {
      if (filter.clientId && meeting.clientId !== filter.clientId) return false;
      if (!filter.includeAll && ownerEmail && meeting.hostEmail !== ownerEmail) return false;
      if (filter.status && !filter.status.includes(meeting.status)) return false;
      return true;
    })
    .sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
};


export const normalizeStoredMeeting = (raw: unknown): ScheduledMeeting | null => {
  const record = asRecord(raw);
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.clientId !== "string" || !record.clientId) return null;
  if (typeof record.roomCode !== "string" || !record.roomCode) return null;
  if (typeof record.hostEmail !== "string" || !record.hostEmail) return null;
  const scheduledStartAt = storedTimestampOrNull(record.scheduledStartAt);
  if (scheduledStartAt === null) return null;
  const scheduledEndAt = storedTimestampOrNull(record.scheduledEndAt) ?? scheduledStartAt + DEFAULT_DURATION_MS;
  const rawStatus = record.status;
  const status: ScheduledMeetingStatus =
    rawStatus === "live" || rawStatus === "ended" || rawStatus === "cancelled"
      ? rawStatus
      : "scheduled";
  const updatedAtRaw = storedTimestampOrNull(record.updatedAt);
  const createdAt = storedTimestampOrNull(record.createdAt) ?? updatedAtRaw ?? 0;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    id: record.id,
    clientId: canonicalizeClientId(record.clientId),
    roomCode: record.roomCode,
    title: typeof record.title === "string" ? record.title : "Scheduled meeting",
    hostEmail: record.hostEmail,
    hostName: typeof record.hostName === "string" ? record.hostName : "",
    hostUserId: text(record.hostUserId),
    scheduledStartAt,
    scheduledEndAt,
    status,
    startedAt: storedTimestampOrNull(record.startedAt),
    endedAt: storedTimestampOrNull(record.endedAt),
    createdAt,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : record.hostEmail,
    updatedAt: updatedAtRaw ?? createdAt,
    source: record.source === "booking_link" ? "booking_link" : "manual",
    eventTypeId: text(record.eventTypeId),
    attendeeName: text(record.attendeeName),
    attendeeEmail: text(record.attendeeEmail),
    attendeeNote: text(record.attendeeNote),
    attendeeTimeZone: text(record.attendeeTimeZone),
    googleCalendarEventId: text(record.googleCalendarEventId),
    calendarSyncStatus:
      record.calendarSyncStatus === "pending" ||
      record.calendarSyncStatus === "synced" ||
      record.calendarSyncStatus === "failed"
        ? record.calendarSyncStatus
        : "not_required",
    calendarSyncError: text(record.calendarSyncError),
    emailNotificationStatus: normalizeEmailNotificationStatus(record.emailNotificationStatus),
    emailNotificationError: text(record.emailNotificationError),
    emailNotificationSentAt: storedTimestampOrNull(record.emailNotificationSentAt),
    emailReminderStatus: normalizeEmailNotificationStatus(record.emailReminderStatus),
    emailReminderError: text(record.emailReminderError),
    emailReminderSentAt: storedTimestampOrNull(record.emailReminderSentAt),
  };
};

export const shouldSendSchedulingReminder = (
  meeting: ScheduledMeeting,
  now: number,
  leadMs: number,
): boolean => {
  if (leadMs <= 0) return false;
  if (meeting.source !== "booking_link") return false;
  if (meeting.status !== "scheduled") return false;
  if (!meeting.attendeeEmail) return false;
  if (
    meeting.emailReminderStatus === "pending" ||
    meeting.emailReminderStatus === "sent" ||
    meeting.emailReminderStatus === "failed"
  ) {
    return false;
  }
  const reminderDueAt = meeting.scheduledStartAt - leadMs;
  if (meeting.createdAt > reminderDueAt) return false;
  return now >= reminderDueAt && now < meeting.scheduledStartAt;
};

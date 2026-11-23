import type {
  ScheduledMeeting,
  SchedulingEventType,
  SchedulingProfile,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import {
  persistScheduledMeetingChanges,
  updateScheduledMeeting,
} from "./scheduledMeetings.js";
import {
  isSchedulingEmailConfigured,
  sendSchedulingReminderEmails,
} from "./schedulingEmails.js";
import type { SfuState } from "./state.js";

const MINUTE_MS = 60 * 1000;
const DEFAULT_REMINDER_MINUTES = 30;
const MAX_REMINDER_MINUTES = 24 * 60;
const reminderInFlight = new Set<string>();
let scanRunning = false;

const disabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
};

const resolveSchedulingReminderLeadMs = (): number => {
  if (disabled(process.env.SCHEDULING_EMAIL_REMINDERS_ENABLED)) return 0;
  const configured = Number(process.env.SCHEDULING_EMAIL_REMINDER_MINUTES);
  const minutes =
    Number.isFinite(configured) && configured > 0
      ? Math.min(Math.round(configured), MAX_REMINDER_MINUTES)
      : DEFAULT_REMINDER_MINUTES;
  return minutes * MINUTE_MS;
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

const resolveAppOrigin = (): string =>
  (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.BETTER_AUTH_BASE_URL ||
    "https://conclave.acmvit.in"
  ).replace(/\/$/, "");

const fallbackTimeZone = (meeting: ScheduledMeeting): string => {
  const zone = meeting.attendeeTimeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return zone;
  } catch {
    return "UTC";
  }
};

const resolveProfile = (
  state: SfuState,
  meeting: ScheduledMeeting,
  eventType: SchedulingEventType | null,
): SchedulingProfile => {
  const byEventType = eventType
    ? state.scheduling.profilesById.get(eventType.profileId)
    : null;
  if (byEventType) return byEventType;
  const byHost = Array.from(state.scheduling.profilesById.values()).find(
    (profile) =>
      profile.clientId === meeting.clientId &&
      profile.email.trim().toLowerCase() ===
        meeting.hostEmail.trim().toLowerCase(),
  );
  if (byHost) return byHost;
  return {
    id: `meeting-host:${meeting.id}`,
    clientId: meeting.clientId,
    userId: meeting.hostUserId || meeting.hostEmail,
    email: meeting.hostEmail,
    name: meeting.hostName || "Host",
    username: meeting.hostEmail.split("@")[0] || "host",
    timeZone: fallbackTimeZone(meeting),
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  };
};

const resolveEventType = (
  state: SfuState,
  meeting: ScheduledMeeting,
): SchedulingEventType | null => {
  if (!meeting.eventTypeId) return null;
  return state.scheduling.eventTypesById.get(meeting.eventTypeId) ?? null;
};

const fallbackEventType = (
  meeting: ScheduledMeeting,
  profile: SchedulingProfile,
): SchedulingEventType => ({
  id: meeting.eventTypeId || `meeting-event:${meeting.id}`,
  clientId: meeting.clientId,
  profileId: profile.id,
  userId: profile.userId,
  slug: meeting.roomCode,
  title: meeting.title,
  description: "",
  durationMinutes: Math.max(
    1,
    Math.round((meeting.scheduledEndAt - meeting.scheduledStartAt) / MINUTE_MS),
  ),
  minimumNoticeMinutes: 0,
  bookingWindowDays: 0,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  isActive: true,
  requiresCalendar: false,
  createdAt: meeting.createdAt,
  updatedAt: meeting.updatedAt,
});

const persistMeetingChange = async (
  state: SfuState,
  meeting: ScheduledMeeting,
): Promise<void> => {
  if (!state.scheduledMeetingPersistence) return;
  await persistScheduledMeetingChanges(
    state.scheduledMeetings,
    state.scheduledMeetingPersistence,
    [meeting],
  );
};

const claimReminderForMeeting = async (
  state: SfuState,
  meeting: ScheduledMeeting,
  now: number,
  leadMs: number,
): Promise<ScheduledMeeting | null> => {
  if (state.scheduledMeetingPersistence?.claimEmailReminder) {
    const claimed = await state.scheduledMeetingPersistence.claimEmailReminder({
      meetingId: meeting.id,
      now,
      leadMs,
    });
    if (!claimed) return null;
    const local = state.scheduledMeetings.byId.get(claimed.id);
    if (local) {
      Object.assign(local, claimed);
      return local;
    }
    state.scheduledMeetings.byId.set(claimed.id, claimed);
    state.scheduledMeetings.byRoomCode.set(
      `${claimed.clientId}:${claimed.roomCode}`,
      claimed.id,
    );
    return claimed;
  }

  const pending = updateScheduledMeeting(state.scheduledMeetings, meeting.id, {
    emailReminderStatus: "pending",
    emailReminderError: null,
    emailReminderSentAt: null,
  });
  await persistMeetingChange(state, pending);
  return pending;
};

const sendReminderForMeeting = async (
  state: SfuState,
  meeting: ScheduledMeeting,
  now: number,
  leadMs: number,
): Promise<ScheduledMeeting | null> => {
  const pending = await claimReminderForMeeting(state, meeting, now, leadMs);
  if (!pending) return null;

  const eventType = resolveEventType(state, pending);
  const profile = resolveProfile(state, pending, eventType);
  const result = await sendSchedulingReminderEmails({
    profile,
    eventType: eventType ?? fallbackEventType(pending, profile),
    meeting: pending,
    appOrigin: resolveAppOrigin(),
  });
  const updated = updateScheduledMeeting(state.scheduledMeetings, pending.id, {
    emailReminderStatus: result.status,
    emailReminderError: result.error,
    emailReminderSentAt: result.sentAt,
  });
  await persistMeetingChange(state, updated);
  return updated;
};

export const sendDueSchedulingEmailReminders = async (
  state: SfuState,
  now = Date.now(),
): Promise<ScheduledMeeting[]> => {
  if (scanRunning || !isSchedulingEmailConfigured()) return [];
  const leadMs = resolveSchedulingReminderLeadMs();
  if (leadMs <= 0) return [];

  scanRunning = true;
  const changed: ScheduledMeeting[] = [];
  try {
    const dueMeetings = Array.from(state.scheduledMeetings.byId.values()).filter(
      (meeting) =>
        !reminderInFlight.has(meeting.id) &&
        shouldSendSchedulingReminder(meeting, now, leadMs),
    );

    for (const meeting of dueMeetings) {
      reminderInFlight.add(meeting.id);
      try {
        const updated = await sendReminderForMeeting(state, meeting, now, leadMs);
        if (updated) changed.push(updated);
      } catch (error) {
        Logger.warn("Failed to send scheduling reminder", error);
        try {
          const failed = updateScheduledMeeting(state.scheduledMeetings, meeting.id, {
            emailReminderStatus: "failed",
            emailReminderError:
              (error as Error).message || "Scheduling reminder email failed.",
            emailReminderSentAt: null,
          });
          await persistMeetingChange(state, failed);
          changed.push(failed);
        } catch (persistError) {
          Logger.warn("Failed to persist scheduling reminder failure", persistError);
        }
      } finally {
        reminderInFlight.delete(meeting.id);
      }
    }
    return changed;
  } finally {
    scanRunning = false;
  }
};

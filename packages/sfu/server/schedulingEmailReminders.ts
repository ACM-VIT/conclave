import type {
  ScheduledMeeting,
  SchedulingEventType,
  SchedulingProfile,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import {
  claimDueReminder,
  dueReminderMeetings,
  recordReminderResult,
  reminderContext,
} from "./controlPlane/schedulingCommands.js";
import { defaultAppOrigin } from "./appOrigin.js";
import { commitFollowUp } from "./controlPlane/followUp.js";
import {
  isSchedulingEmailConfigured,
  sendSchedulingReminderEmails,
  type SchedulingEmailDeliveryResult,
} from "./schedulingEmails.js";
import type { SfuState } from "./state.js";

export { shouldSendSchedulingReminder } from "./scheduledMeetings.js";

const MINUTE_MS = 60 * 1000;
const DEFAULT_REMINDER_MINUTES = 30;
const MAX_REMINDER_MINUTES = 24 * 60;

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

const fallbackTimeZone = (meeting: ScheduledMeeting): string => {
  const zone = meeting.attendeeTimeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return zone;
  } catch {
    return "UTC";
  }
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

const fallbackProfile = (meeting: ScheduledMeeting): SchedulingProfile => ({
  id: `meeting-host:${meeting.id}`,
  clientId: meeting.clientId,
  userId: meeting.hostUserId || meeting.hostEmail,
  email: meeting.hostEmail,
  name: meeting.hostName || "Host",
  username: meeting.hostEmail.split("@")[0] || "host",
  timeZone: fallbackTimeZone(meeting),
  createdAt: meeting.createdAt,
  updatedAt: meeting.updatedAt,
});

const sendReminderForMeeting = async (
  state: SfuState,
  meeting: ScheduledMeeting,
  leadMs: number,
): Promise<ScheduledMeeting | null> => {
  const claim = await state.controlPlane.commit(claimDueReminder(meeting.id, leadMs));
  if (!claim.ok) return null;
  const pending = claim.value;
  let result: SchedulingEmailDeliveryResult;
  try {
    const context = await state.controlPlane.read(reminderContext(pending));
    const profile = context.profile ?? fallbackProfile(pending);
    result = await sendSchedulingReminderEmails({
      profile,
      eventType: context.eventType ?? fallbackEventType(pending, profile),
      meeting: pending,
      appOrigin: defaultAppOrigin(),
    });
  } catch (error) {
    Logger.warn("Failed to send scheduling reminder", error);
    result = {
      status: "failed",
      error: (error as Error).message || "Scheduling reminder email failed.",
      sentAt: null,
    };
  }
  const recorded = await commitFollowUp(
    state.controlPlane,
    `reminder result for ${pending.id}`,
    recordReminderResult(pending.id, result),
  );
  return recorded?.ok ? recorded.value : null;
};

export const sendDueSchedulingEmailReminders = async (
  state: SfuState,
): Promise<ScheduledMeeting[]> => {
  if (state.reminderScanRunning || !isSchedulingEmailConfigured()) return [];
  const leadMs = resolveSchedulingReminderLeadMs();
  if (leadMs <= 0) return [];
  state.reminderScanRunning = true;
  try {
    const due = await state.controlPlane.read(dueReminderMeetings(leadMs));
    const changed: ScheduledMeeting[] = [];
    for (const meeting of due) {
      const updated = await sendReminderForMeeting(state, meeting, leadMs);
      if (updated) changed.push(updated);
    }
    return changed;
  } finally {
    state.reminderScanRunning = false;
  }
};

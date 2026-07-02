import type {
  AvailableSlot,
  BookingConfirmation,
  CalendarConnectionSummary,
  PublicSchedulingPage,
  SchedulingEventType,
  SchedulingProfile,
  WeeklyAvailability,
} from "@conclave/meeting-core/scheduling";
import { resolveSfuSecret, resolveSfuUrl } from "@/lib/sfu-admin-auth";
import {
  buildScheduledMeetingHeaders,
  readScheduledMeetingError,
} from "@/lib/scheduled-meetings";
import type { SfuAuthenticatedUser } from "@/lib/sfu-user-auth";
import {
  canonicalizeSfuClientId,
  resolveServerSfuClientId,
} from "@/lib/sfu-client-id";

export type {
  AvailableSlot,
  BookingConfirmation,
  CalendarConnectionSummary,
  PublicSchedulingPage,
  SchedulingEventType,
  SchedulingProfile,
  WeeklyAvailability,
};

export type SchedulingDashboardResponse = {
  profile: SchedulingProfile;
  availability: WeeklyAvailability;
  eventTypes: SchedulingEventType[];
  calendar: CalendarConnectionSummary;
};

export type SchedulingBookingsResponse = {
  bookings?: Array<{
    id: string;
    clientId: string;
    roomCode: string;
    title: string;
    hostName: string;
    attendeeName?: string | null;
    attendeeEmail?: string | null;
    attendeeNote?: string | null;
    attendeeTimeZone?: string | null;
    scheduledStartAt: number;
    scheduledEndAt: number;
    googleCalendarEventId?: string | null;
    calendarSyncStatus?: string;
    emailNotificationStatus?: string;
    emailNotificationError?: string | null;
    emailNotificationSentAt?: number | null;
    emailReminderStatus?: string;
    emailReminderError?: string | null;
    emailReminderSentAt?: number | null;
  }>;
};

export const resolveSchedulingBase = (): string => {
  const base = resolveSfuUrl().replace(/\/$/, "");
  return `${base}/scheduling`;
};

export const buildSchedulingHeaders = (
  user: SfuAuthenticatedUser,
  request: Request,
): Headers => buildScheduledMeetingHeaders(user, request);

export const buildPublicSchedulingHeaders = (request?: Request): Headers => {
  const headers = new Headers();
  headers.set("x-sfu-secret", resolveSfuSecret());
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  const clientId =
    canonicalizeSfuClientId(request?.headers.get("x-sfu-client")) ||
    resolveServerSfuClientId();
  headers.set("x-sfu-client", clientId);
  return headers;
};

export const readSchedulingError = readScheduledMeetingError;

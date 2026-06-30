export type SchedulingWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type SchedulingMeetingSource = "manual" | "booking_link";

export type SchedulingSyncStatus =
  | "not_required"
  | "pending"
  | "synced"
  | "failed";

export type SchedulingEmailNotificationStatus =
  | "not_configured"
  | "pending"
  | "sent"
  | "failed";

export type SchedulingCalendarProvider = "google";

export type SchedulingCalendarStatus =
  | "not_connected"
  | "connected"
  | "needs_reconnect"
  | "error";

export interface AvailabilityWindow {
  day: SchedulingWeekday;
  startMinutes: number;
  endMinutes: number;
}

export interface AvailabilityOverride {
  date: string;
  windows: Array<Omit<AvailabilityWindow, "day">>;
  unavailable?: boolean;
}

export interface WeeklyAvailability {
  timeZone: string;
  windows: AvailabilityWindow[];
  overrides: AvailabilityOverride[];
  updatedAt?: number;
}

export interface SchedulingProfile {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  name: string;
  username: string;
  timeZone: string;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulingEventType {
  id: string;
  clientId: string;
  profileId: string;
  userId: string;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  minimumNoticeMinutes: number;
  bookingWindowDays: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  isActive: boolean;
  requiresCalendar: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarConnectionSummary {
  provider: SchedulingCalendarProvider;
  status: SchedulingCalendarStatus;
  email: string | null;
  calendarId: string;
  connectedAt: number | null;
  updatedAt: number | null;
  error: string | null;
}

export interface AvailableSlot {
  startAt: number;
  endAt: number;
  label: string;
}

export interface PublicSchedulingPage {
  profile: Pick<SchedulingProfile, "name" | "username" | "timeZone">;
  eventType: Pick<
    SchedulingEventType,
    | "id"
    | "slug"
    | "title"
    | "description"
    | "durationMinutes"
    | "minimumNoticeMinutes"
    | "bookingWindowDays"
  >;
  calendar: CalendarConnectionSummary;
}

export interface CreateBookingRequest {
  startAt: number;
  attendeeName: string;
  attendeeEmail: string;
  attendeeNote?: string;
  attendeeTimeZone?: string;
}

export interface BookingConfirmation {
  id: string;
  title: string;
  roomCode: string;
  meetingLink: string;
  startsAt: number;
  endsAt: number;
  hostName: string;
  attendeeName: string;
  attendeeEmail: string;
  calendarEventId: string | null;
  syncStatus: SchedulingSyncStatus;
  emailNotificationStatus: SchedulingEmailNotificationStatus;
}

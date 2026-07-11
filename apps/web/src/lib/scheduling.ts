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
  WeeklyAvailability,
};

export type SchedulingDashboardResponse = {
  profile: SchedulingProfile;
  availability: WeeklyAvailability;
  eventTypes: SchedulingEventType[];
  calendar: CalendarConnectionSummary;
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

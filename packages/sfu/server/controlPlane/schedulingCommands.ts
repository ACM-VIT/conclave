import type {
  CalendarConnectionSummary,
  CreateScheduledMeetingRequest,
  ScheduledMeeting,
  ScheduledMeetingEmailNotificationStatus,
  SchedulingCalendarConnection,
  SchedulingEventType,
  SchedulingProfile,
  WeeklyAvailability,
} from "../../types.js";
import { canonicalizeClientId, clientNamespacesIn, clientNamespaceIncludes } from "../clientIds.js";
import {
  buildScheduledMeeting,
  shouldSendSchedulingReminder,
  type CreateScheduledMeetingOptions,
} from "../scheduledMeetings.js";
import {
  applyEventTypeInput,
  applyProfileUpdate,
  bookingBlocksInterval,
  calendarSummary,
  connectGoogleCalendar,
  defaultWeeklyAvailability,
  internalBusyIntervals,
  isCalendarUsable,
  meetingMatchesProfile,
  newEventType,
  newSchedulingProfile,
  normalizeWeeklyAvailability,
  parseWeeklyAvailability,
  patchCalendarConnection,
  requestedUsername,
  syncProfileIdentity,
  uniqueUsername,
  type BusyInterval,
  type CalendarGrantInput,
  type CalendarTokenPatch,
  type ProfileIdentity,
  type ProfileUpdate,
} from "../scheduling.js";
import { CALENDAR_CHANGED, putCreateTask } from "./calendarTaskCommands.js";
import { done, fail, tags, uniqueKeys, type Stored } from "./model.js";
import type { Command, Query, TxRead } from "./tx.js";

export type HostDashboard = {
  profile: SchedulingProfile;
  availability: WeeklyAvailability;
  eventTypes: SchedulingEventType[];
  calendar: CalendarConnectionSummary;
};

export type BookingTarget = {
  profile: Stored<"profile">;
  eventType: Stored<"eventType">;
  hours: Stored<"hours"> | null;
  calendar: SchedulingCalendarConnection | null;
};

export type BookingExpectation = {
  profileRev: number;
  eventTypeRev: number;
  hoursRev: number;
  grantId: string | null;
};

export type BookedSlot = { meeting: ScheduledMeeting; calendarTaskId: string | null };

export type EmailResult = {
  status: ScheduledMeetingEmailNotificationStatus;
  error: string | null;
  sentAt: number | null;
};

export const PROFILE_NOT_FOUND = "Scheduling profile not found.";
export const EVENT_TYPE_NOT_FOUND = "Event type not found.";
export const SLOT_TAKEN = "That time is no longer available.";
export const BOOKING_PAGE_CHANGED = "The booking page changed while you were booking.";
export const BOOKING_GONE = "This booking is no longer available.";
const OFFLINE_ACCESS_MISSING =
  "Google did not return offline access. Disconnect and connect Google Calendar again.";

const eventTypesOf = (view: TxRead, profileId: string): SchedulingEventType[] =>
  view
    .tagged("eventType", tags.profileEventTypes(profileId))
    .map((stored) => stored.value)
    .sort((a, b) => a.createdAt - b.createdAt);

const availabilityOf = (view: TxRead, profile: SchedulingProfile): WeeklyAvailability =>
  view.get("hours", profile.id)?.value.availability ??
  defaultWeeklyAvailability(profile.timeZone, profile.updatedAt);

const calendarOf = (view: TxRead, profileId: string): SchedulingCalendarConnection | null =>
  view.get("calendar", profileId)?.value ?? null;

const dashboardOf = (view: TxRead, profile: SchedulingProfile): HostDashboard => ({
  profile,
  availability: availabilityOf(view, profile),
  eventTypes: eventTypesOf(view, profile.id),
  calendar: calendarSummary(calendarOf(view, profile.id)),
});

const findProfileForUser = (
  view: TxRead,
  clientId: string,
  userId: string,
): Stored<"profile"> | null => {
  for (const candidate of clientNamespacesIn(clientId)) {
    const found = view.lookup(
      "profile",
      "profileUser",
      uniqueKeys.profileUser(candidate, userId),
    );
    if (found) return found;
  }
  return null;
};

const eventTypeLookup = (view: TxRead): ((id: string) => SchedulingEventType | null) => {
  const byId = new Map(view.all("eventType").map((stored) => [stored.value.id, stored.value]));
  return (id) => byId.get(id) ?? null;
};

export const profileForUser =
  (clientId: string, userId: string): Query<SchedulingProfile | null> =>
  (view) =>
    findProfileForUser(view, clientId, userId)?.value ?? null;

export const hostDashboard =
  (profileId: string): Query<HostDashboard | null> =>
  (view) => {
    const profile = view.get("profile", profileId);
    return profile ? dashboardOf(view, profile.value) : null;
  };

export const hostCalendar =
  (profileId: string): Query<SchedulingCalendarConnection | null> =>
  (view) =>
    calendarOf(view, profileId);

export const hostBookings =
  (profileId: string): Query<ScheduledMeeting[]> =>
  (view) => {
    const profile = view.get("profile", profileId);
    if (!profile) return [];
    const eventTypeOf = eventTypeLookup(view);
    return view
      .all("meeting")
      .map((stored) => stored.value)
      .filter(
        (meeting) =>
          meeting.source === "booking_link" &&
          meetingMatchesProfile(
            meeting,
            profile.value,
            meeting.eventTypeId ? eventTypeOf(meeting.eventTypeId) : null,
          ),
      )
      .sort((a, b) => b.scheduledStartAt - a.scheduledStartAt);
  };

export const hostBusyIntervals =
  (profileId: string, from: number, to: number, clientId: string): Query<BusyInterval[]> =>
  (view) => {
    const profile = view.get("profile", profileId);
    if (!profile) return [];
    return internalBusyIntervals(
      view.tagged("meeting", tags.activeMeetings).map((stored) => stored.value),
      eventTypeLookup(view),
      profile.value,
      from,
      to,
      clientId,
    );
  };

export const bookingTarget =
  (
    clientId: string,
    username: string,
    slug: string,
  ): Query<BookingTarget | { error: string; status: number }> =>
  (view) => {
    for (const candidate of clientNamespacesIn(clientId)) {
      const profile = view.lookup(
        "profile",
        "profileUsername",
        uniqueKeys.profileUsername(candidate, username.trim().toLowerCase()),
      );
      if (!profile) continue;
      const eventType = view.lookup(
        "eventType",
        "eventSlug",
        uniqueKeys.eventSlug(profile.value.id, slug.trim().toLowerCase()),
      );
      if (!eventType || !eventType.value.isActive) {
        return { error: "Event type is not available.", status: 404 };
      }
      return {
        profile,
        eventType,
        hours: view.get("hours", profile.value.id),
        calendar: calendarOf(view, profile.value.id),
      };
    }
    return { error: "Scheduling page not found.", status: 404 };
  };

export const ensureHostProfile =
  (identity: ProfileIdentity, options: { syncIdentity: boolean }): Command<SchedulingProfile> =>
  (tx) => {
    const found = findProfileForUser(tx, identity.clientId, identity.userId);
    if (found) {
      const synced = options.syncIdentity
        ? syncProfileIdentity(found.value, identity, tx.now)
        : null;
      if (!synced) return done(found.value);
      tx.put("profile", synced);
      return done(synced);
    }
    const clientId = canonicalizeClientId(identity.clientId);
    const username = uniqueUsername(
      requestedUsername(undefined, identity.email, identity.userId),
      (candidate) =>
        tx.owner("profileUsername", uniqueKeys.profileUsername(clientId, candidate)) !== null,
    );
    const profile = newSchedulingProfile(identity, {
      id: tx.entropy.uuid(),
      username,
      now: tx.now,
    });
    tx.put("profile", profile);
    tx.put("hours", {
      profileId: profile.id,
      availability: defaultWeeklyAvailability(profile.timeZone, tx.now),
    });
    return done(profile);
  };

export const updateHostProfile =
  (profileId: string, updates: ProfileUpdate): Command<HostDashboard> =>
  (tx) => {
    const current = tx.get("profile", profileId);
    if (!current) return fail("not_found", PROFILE_NOT_FOUND);
    const profile = applyProfileUpdate(current.value, updates, {
      now: tx.now,
      isUsernameTaken: (candidate) => {
        const owner = tx.owner(
          "profileUsername",
          uniqueKeys.profileUsername(current.value.clientId, candidate),
        );
        return owner !== null && owner !== profileId;
      },
    });
    tx.put("profile", profile);
    if (updates.timeZone !== undefined) {
      const availability = availabilityOf(tx, current.value);
      tx.put("hours", {
        profileId,
        availability: {
          ...normalizeWeeklyAvailability(
            { ...availability, timeZone: profile.timeZone },
            profile.timeZone,
            tx.now,
          ),
          updatedAt: tx.now,
        },
      });
    }
    return done(dashboardOf(tx, profile));
  };

export const setHostHours =
  (
    profileId: string,
    input: unknown,
  ): Command<{ availability: WeeklyAvailability; profile: SchedulingProfile }> =>
  (tx) => {
    const current = tx.get("profile", profileId);
    if (!current) return fail("not_found", PROFILE_NOT_FOUND);
    const availability = parseWeeklyAvailability(input, current.value, tx.now);
    const profile = { ...current.value, timeZone: availability.timeZone, updatedAt: tx.now };
    tx.put("hours", { profileId, availability });
    tx.put("profile", profile);
    return done({ availability, profile });
  };

export const createHostEventType =
  (profileId: string, input: Partial<SchedulingEventType>): Command<SchedulingEventType> =>
  (tx) => {
    const profile = tx.get("profile", profileId);
    if (!profile) return fail("not_found", PROFILE_NOT_FOUND);
    const eventType = newEventType(profile.value, input, {
      id: tx.entropy.uuid(),
      now: tx.now,
      isSlugTaken: (candidate) =>
        tx.owner("eventSlug", uniqueKeys.eventSlug(profileId, candidate)) !== null,
    });
    tx.put("eventType", eventType);
    return done(eventType);
  };

export const updateHostEventType =
  (
    profileId: string,
    id: string,
    input: Partial<SchedulingEventType>,
  ): Command<SchedulingEventType> =>
  (tx) => {
    const current = tx.get("eventType", id);
    if (!current || current.value.profileId !== profileId) {
      return fail("not_found", EVENT_TYPE_NOT_FOUND);
    }
    const eventType = applyEventTypeInput(current.value, input, {
      now: tx.now,
      isSlugTaken: (candidate) => {
        const owner = tx.owner("eventSlug", uniqueKeys.eventSlug(profileId, candidate));
        return owner !== null && owner !== id;
      },
    });
    tx.put("eventType", eventType);
    return done(eventType);
  };

export const deleteHostEventType =
  (profileId: string, id: string): Command<SchedulingEventType> =>
  (tx) => {
    const current = tx.get("eventType", id);
    if (!current || current.value.profileId !== profileId) {
      return fail("not_found", EVENT_TYPE_NOT_FOUND);
    }
    tx.remove("eventType", id);
    return done(current.value);
  };

export const connectHostCalendar =
  (profileId: string, input: CalendarGrantInput): Command<CalendarConnectionSummary> =>
  (tx) => {
    const profile = tx.get("profile", profileId);
    if (!profile) return fail("not_found", PROFILE_NOT_FOUND);
    const existing = calendarOf(tx, profileId);
    if (!input.refreshToken && !existing?.refreshToken) {
      return fail("invalid", OFFLINE_ACCESS_MISSING);
    }
    const connection = connectGoogleCalendar(profile.value, existing, input, {
      id: tx.entropy.uuid(),
      grantId: tx.entropy.uuid(),
      now: tx.now,
    });
    tx.put("calendar", connection);
    return done(calendarSummary(connection));
  };

export const disconnectHostCalendar =
  (
    profileId: string,
  ): Command<{ calendar: CalendarConnectionSummary; eventTypes: SchedulingEventType[] }> =>
  (tx) => {
    tx.remove("calendar", profileId);
    return done({ calendar: calendarSummary(null), eventTypes: eventTypesOf(tx, profileId) });
  };

export const patchCalendarToken =
  (
    profileId: string,
    grantId: string,
    patch: CalendarTokenPatch,
  ): Command<SchedulingCalendarConnection> =>
  (tx) => {
    const current = calendarOf(tx, profileId);
    if (!current || current.grantId !== grantId) return fail("conflict", CALENDAR_CHANGED);
    const next = patchCalendarConnection(current, patch, tx.now);
    tx.put("calendar", next);
    return done(next);
  };

export const bookSlot =
  (input: {
    profileId: string;
    eventTypeId: string;
    expect: BookingExpectation;
    startAt: number;
    endAt: number;
    request: CreateScheduledMeetingRequest;
    options: CreateScheduledMeetingOptions;
    clientId?: string;
    calendarEvent: { appOrigin: string; timeZone: string; claimedForMs: number };
  }): Command<BookedSlot> =>
  (tx) => {
    const profile = tx.get("profile", input.profileId);
    const eventType = tx.get("eventType", input.eventTypeId);
    if (
      !profile ||
      !eventType ||
      !eventType.value.isActive ||
      eventType.value.profileId !== input.profileId
    ) {
      return fail("conflict", BOOKING_PAGE_CHANGED);
    }
    const calendar = calendarOf(tx, input.profileId);
    const grantId = isCalendarUsable(calendar) ? calendar.grantId : null;
    if (
      profile.rev !== input.expect.profileRev ||
      eventType.rev !== input.expect.eventTypeRev ||
      (tx.get("hours", input.profileId)?.rev ?? 0) !== input.expect.hoursRev ||
      grantId !== input.expect.grantId
    ) {
      return fail("conflict", BOOKING_PAGE_CHANGED);
    }
    const blocked = bookingBlocksInterval(eventType.value, input.startAt, input.endAt);
    const busy = internalBusyIntervals(
      tx.tagged("meeting", tags.activeMeetings).map((stored) => stored.value),
      eventTypeLookup(tx),
      profile.value,
      blocked.startAt,
      blocked.endAt,
      input.clientId,
    );
    if (busy.length > 0) return fail("conflict", SLOT_TAKEN);
    const meeting = buildScheduledMeeting(input.request, input.options, {
      id: tx.entropy.uuid(),
      now: tx.now,
      random: tx.entropy.float,
      activeOwner: (clientId, roomCode) =>
        tx.owner("meetingCode", uniqueKeys.meetingCode(clientId, roomCode)),
    });
    tx.put("meeting", meeting);
    const task = grantId
      ? putCreateTask(tx, { meeting, profileId: profile.value.id, grantId, ...input.calendarEvent })
      : null;
    return done({ meeting, calendarTaskId: task?.id ?? null });
  };

export const recordBookingEmailResult =
  (meetingId: string, result: EmailResult): Command<ScheduledMeeting> =>
  (tx) => {
    const current = tx.get("meeting", meetingId);
    if (!current) return fail("not_found", BOOKING_GONE);
    const next: ScheduledMeeting = {
      ...current.value,
      emailNotificationStatus: result.status,
      emailNotificationError: result.error,
      emailNotificationSentAt: result.sentAt,
      updatedAt: tx.now,
    };
    tx.put("meeting", next);
    return done(next);
  };

export const claimDueReminder =
  (meetingId: string, leadMs: number): Command<ScheduledMeeting> =>
  (tx) => {
    const current = tx.get("meeting", meetingId);
    if (!current) return fail("not_found", BOOKING_GONE);
    if (!shouldSendSchedulingReminder(current.value, tx.now, leadMs)) {
      return fail("conflict", "The reminder is not due or already claimed.");
    }
    const next: ScheduledMeeting = {
      ...current.value,
      emailReminderStatus: "pending",
      emailReminderError: null,
      emailReminderSentAt: null,
      updatedAt: tx.now,
    };
    tx.put("meeting", next);
    return done(next);
  };

export const recordReminderResult =
  (meetingId: string, result: EmailResult): Command<ScheduledMeeting> =>
  (tx) => {
    const current = tx.get("meeting", meetingId);
    if (!current) return fail("not_found", BOOKING_GONE);
    if (current.value.emailReminderStatus !== "pending") {
      return fail("conflict", "The reminder result was already recorded.");
    }
    const next: ScheduledMeeting = {
      ...current.value,
      emailReminderStatus: result.status,
      emailReminderError: result.error,
      emailReminderSentAt: result.sentAt,
      updatedAt: tx.now,
    };
    tx.put("meeting", next);
    return done(next);
  };

export const dueReminderMeetings =
  (leadMs: number): Query<ScheduledMeeting[]> =>
  (view) =>
    view
      .tagged("meeting", tags.activeMeetings)
      .map((stored) => stored.value)
      .filter((meeting) => shouldSendSchedulingReminder(meeting, view.now, leadMs));

export const reminderContext =
  (
    meeting: ScheduledMeeting,
  ): Query<{ profile: SchedulingProfile | null; eventType: SchedulingEventType | null }> =>
  (view) => {
    const candidate = meeting.eventTypeId
      ? view.get("eventType", meeting.eventTypeId)?.value ?? null
      : null;
    const eventType = candidate && clientNamespaceIncludes(candidate.clientId, meeting.clientId)
      ? candidate
      : null;
    const byEventType = eventType ? view.get("profile", eventType.profileId)?.value ?? null : null;
    if (byEventType && clientNamespaceIncludes(byEventType.clientId, meeting.clientId)) {
      return { profile: byEventType, eventType };
    }
    const hostEmail = meeting.hostEmail.trim().toLowerCase();
    const hostProfiles = view.all("profile")
      .map(({ value }) => value)
      .filter((profile) => profile.email.trim().toLowerCase() === hostEmail);
    const profile = hostProfiles.find((profile) => profile.clientId === meeting.clientId) ??
      hostProfiles.find((profile) => clientNamespaceIncludes(profile.clientId, meeting.clientId)) ??
      null;
    return { profile, eventType };
  };

import type { Express, Request, Response } from "express";
import { Logger } from "../../utilities/loggers.js";
import {
  asArray,
  readCoercedBoolean,
  readCoercedNumber,
  readNumber,
  readString,
  requestBody,
  type UntrustedRecord,
} from "../../utilities/untrusted.js";
import { secretsMatch } from "../secret.js";
import {
  clearGoogleCalendarConnection,
  createEventType,
  deleteEventType,
  ensureSchedulingProfile,
  generateAvailableSlots,
  getCalendarSummary,
  getProfileByUser,
  getProfileAvailability,
  getPublicEventType,
  getPublicProfile,
  changeSchedulingHost,
  listEventTypes,
  moveSchedulingProfileToClient,
  setGoogleCalendarConnection,
  setProfileAvailability,
  updateEventType,
  updateSchedulingProfile,
  type BusyInterval,
  type SchedulingStore,
  mergePersistedScheduling,
} from "../scheduling.js";
import {
  changeMeetings,
  createScheduledMeeting,
  moveScheduledMeetingToClient,
  updateScheduledMeeting,
  type BookingSlotLease,
  type ScheduledMeetingStore,
} from "../scheduledMeetings.js";
import {
  isSchedulingEmailConfigured,
  sendSchedulingBookingEmails,
  type SchedulingEmailDeliveryResult,
} from "../schedulingEmails.js";
import { buildSchedulingMeetingLink } from "../schedulingLinks.js";
import { applyIfUnchanged, basisOf, retryInBackground, sameStoredValue } from "../persistThenApply.js";
import {
  PersistenceUnavailableError,
  sendPersistenceUnavailable,
} from "./persistenceUnavailable.js";
import type { SfuState } from "../state.js";
import {
  canonicalizeClientId,
  canMigrateClientNamespace,
  clientIdCandidates,
  resolveDefaultClientId,
} from "../clientIds.js";
import type {
  BookingConfirmation,
  CalendarConnectionSummary,
  CreateBookingRequest,
  ScheduledMeeting,
  UpdateScheduledMeetingRequest,
  SchedulingCalendarConnection,
  SchedulingEventType,
  SchedulingProfile,
} from "../../types.js";

type RegisterOptions = {
  state: SfuState;
  sfuSecret: string;
};

const MAX_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 2000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const localBookingSlotLocks = new Set<string>();

const hasValidSecret = (req: Request, secret: string): boolean => {
  const provided = req.header("x-sfu-secret");
  return Boolean(provided && secretsMatch(provided, secret));
};

const normalizeIdentifier = (
  value: unknown,
  maxLength = MAX_ID_LENGTH,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
};

const normalizeEmail = (value: unknown): string | null => {
  const normalized = normalizeIdentifier(value, MAX_EMAIL_LENGTH)?.toLowerCase();
  return normalized && normalized.includes("@") ? normalized : null;
};

const normalizeText = (value: unknown, maxLength = MAX_TEXT_LENGTH): string =>
  typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";

/**
 * Decode the client-editable event-type fields from an untrusted body.
 * Type-invalid fields decode to undefined ("not provided"); scheduling.ts
 * sanitizes and clamps every value again before storing it.
 */
const eventTypeInput = (body: UntrustedRecord): Partial<SchedulingEventType> => ({
  title: readString(body, "title"),
  slug: readString(body, "slug"),
  description: readString(body, "description"),
  durationMinutes: readCoercedNumber(body, "durationMinutes"),
  minimumNoticeMinutes: readCoercedNumber(body, "minimumNoticeMinutes"),
  bookingWindowDays: readCoercedNumber(body, "bookingWindowDays"),
  bufferBeforeMinutes: readCoercedNumber(body, "bufferBeforeMinutes"),
  bufferAfterMinutes: readCoercedNumber(body, "bufferAfterMinutes"),
  isActive: readCoercedBoolean(body, "isActive"),
  requiresCalendar: readCoercedBoolean(body, "requiresCalendar"),
});

const resolveClientId = (
  req: Request,
  fallback = resolveDefaultClientId(),
): string => {
  const fromQuery = normalizeIdentifier(req.query.clientId) || "";
  const fromHeader = normalizeIdentifier(req.header("x-sfu-client")) || "";
  return canonicalizeClientId(fromQuery || fromHeader || fallback);
};

const resolveUserContext = (
  req: Request,
): {
  email: string | null;
  name: string | null;
  userId: string | null;
  isAdmin: boolean;
} => {
  const email = normalizeEmail(req.header("x-user-email"));
  const name = normalizeIdentifier(req.header("x-user-name"), MAX_NAME_LENGTH);
  const userId = normalizeIdentifier(req.header("x-user-id"));
  const isAdmin = req.header("x-user-is-admin") === "1";
  return { email, name, userId, isAdmin };
};

const requireGoogleConfig = (): { clientId: string; clientSecret: string } => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google Calendar sync is not configured.");
  }
  return { clientId, clientSecret };
};

const resolveAppOrigin = (req: Request): string => {
  const fromHeader = req.header("x-app-origin")?.trim();
  if (fromHeader) return fromHeader.replace(/\/$/, "");
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.BETTER_AUTH_BASE_URL ||
    "https://conclave.acmvit.in"
  ).replace(/\/$/, "");
};

const publicCalendarSummary = (
  summary: CalendarConnectionSummary,
): CalendarConnectionSummary => ({
  ...summary,
  error: summary.status === "connected" ? null : summary.error,
});

const profilePayload = (
  state: SfuState,
  profile: SchedulingProfile,
) => ({
  profile,
  availability: getProfileAvailability(state.scheduling, profile),
  eventTypes: listEventTypes(state.scheduling, profile.id),
  calendar: getCalendarSummary(state.scheduling, profile.id),
});

const changeHost = <R>(
  state: SfuState,
  host: string | ((store: SchedulingStore) => string | null),
  mutate: (draft: SchedulingStore) => R,
): Promise<R> => changeSchedulingHost(state.scheduling, state.schedulingPersistence, host, mutate);

/** The draft's copy of a host profile, which a change may edit. */
const hostIn = (draft: SchedulingStore, profileId: string): SchedulingProfile => {
  const profile = draft.profilesById.get(profileId);
  if (!profile) throw new Error("Scheduling profile not found.");
  return profile;
};

const committedProfile = (state: SfuState, profile: SchedulingProfile): SchedulingProfile =>
  state.scheduling.profilesById.get(profile.id) ?? profile;

const legacyProfileToMigrate = (
  state: SfuState,
  clientId: string,
  userId: string,
): SchedulingProfile | null => {
  for (const legacyClientId of clientIdCandidates(clientId).slice(1)) {
    const legacyProfile = getProfileByUser(state.scheduling, legacyClientId, userId);
    if (!legacyProfile) continue;
    // Only into the deployment's default client: the requested id comes
    // from the request and must not move a profile's booking meetings out.
    return canMigrateClientNamespace(legacyProfile.clientId, clientId) ? legacyProfile : null;
  }
  return null;
};

/**
 * Moves a legacy profile's booking meetings into `clientId`. It runs before
 * the profile moves, so a failure leaves the profile behind to try again.
 */
const moveProfileMeetings = async (
  state: SfuState,
  profile: SchedulingProfile,
  clientId: string,
): Promise<void> => {
  const previousClientId = profile.clientId;
  const eventTypeIds = new Set(
    listEventTypes(state.scheduling, profile.id).map((eventType) => eventType.id),
  );
  const belongsToProfile = (meeting: ScheduledMeeting): boolean =>
    meeting.clientId === previousClientId &&
    meeting.source === "booking_link" &&
    Boolean(
      (meeting.eventTypeId && eventTypeIds.has(meeting.eventTypeId)) ||
        (meeting.hostUserId && meeting.hostUserId === profile.userId) ||
        meeting.hostEmail.trim().toLowerCase() === profile.email,
    );
  const profileMeetings = (store: ScheduledMeetingStore): string[] =>
    [...store.byId.values()].filter(belongsToProfile).map((meeting) => meeting.id);
  if (profileMeetings(state.scheduledMeetings).length === 0) return;
  await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, profileMeetings, (draft) => {
    for (const id of profileMeetings(draft)) {
      try {
        moveScheduledMeetingToClient(draft, id, clientId);
      } catch (error) {
        Logger.warn(`Skipped scheduled meeting namespace migration for ${id}`, error);
      }
    }
  });
};

const requireHostProfile = async (
  req: Request,
  res: Response,
  state: SfuState,
): Promise<SchedulingProfile | null> => {
  const { email, name, userId } = resolveUserContext(req);
  if (!email || !userId) {
    res.status(400).json({ error: "User context required" });
    return null;
  }
  const clientId = resolveClientId(req);
  if (!getProfileByUser(state.scheduling, clientId, userId) && state.schedulingPersistence) {
    await mergePersistedScheduling(state.scheduling, state.schedulingPersistence);
  }
  const legacy = getProfileByUser(state.scheduling, clientId, userId)
    ? null
    : legacyProfileToMigrate(state, clientId, userId);
  if (legacy) await moveProfileMeetings(state, legacy, clientId);
  const timeZone = readString(requestBody(req), "timeZone");
  const profile = await changeHost(
    state,
    (store) => getProfileByUser(store, clientId, userId)?.id ?? legacy?.id ?? null,
    (draft) => {
      if (legacy && draft.profilesById.has(legacy.id) && !getProfileByUser(draft, clientId, userId)) {
        moveSchedulingProfileToClient(draft, hostIn(draft, legacy.id), clientId);
      }
      return ensureSchedulingProfile(draft, { clientId, userId, email, name, timeZone });
    },
  );
  return committedProfile(state, profile);
};

const requireConnectedCalendar = (
  state: SfuState,
  profile: SchedulingProfile,
): SchedulingCalendarConnection | null => {
  const connection = state.scheduling.calendarByProfileId.get(profile.id);
  if (!connection || connection.status !== "connected" || !connection.refreshToken) {
    return null;
  }
  return connection;
};

const hasCalendarConnectionProblem = (
  state: SfuState,
  profile: SchedulingProfile,
  eventType: SchedulingEventType,
): boolean => {
  if (!eventType.requiresCalendar) return false;
  const summary = getCalendarSummary(state.scheduling, profile.id);
  return summary.status !== "connected";
};

const sendCalendarUnavailable = (res: Response): void => {
  res.status(503).json({
    error:
      "Calendar availability is temporarily unavailable. Ask the host to reconnect Google Calendar.",
  });
};

const bookingSlotLockKey = (
  profile: SchedulingProfile,
): string => `${profile.clientId}:${profile.email.toLowerCase()}`;

const acquireBookingSlotLease = async (
  state: SfuState,
  profile: SchedulingProfile,
  startAt: number,
  endAt: number,
): Promise<BookingSlotLease | null> => {
  const key = bookingSlotLockKey(profile);
  if (localBookingSlotLocks.has(key)) return null;
  localBookingSlotLocks.add(key);

  let remoteLease: BookingSlotLease | null = null;
  try {
    if (state.scheduledMeetingPersistence?.reserveBookingSlot) {
      remoteLease = await state.scheduledMeetingPersistence.reserveBookingSlot({
        clientId: profile.clientId,
        hostEmail: profile.email,
        startAt,
        endAt,
      });
      if (!remoteLease) {
        localBookingSlotLocks.delete(key);
        return null;
      }
    }

    return {
      release: async () => {
        try {
          await remoteLease?.release();
        } finally {
          localBookingSlotLocks.delete(key);
        }
      },
    };
  } catch (error) {
    localBookingSlotLocks.delete(key);
    throw error;
  }
};

const answerFailure = (res: Response, error: unknown, status: number): void => {
  if (error instanceof PersistenceUnavailableError) {
    sendPersistenceUnavailable(res);
    return;
  }
  res.status(status).json({ error: (error as Error).message });
};

class GoogleCalendarApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "GoogleCalendarApiError";
    this.status = status;
    this.code = code;
  }
}

const googleErrorCode = (data: unknown): string | null => {
  if (!data || typeof data !== "object" || !("error" in data)) return null;
  const error = (data as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "string" ? status : null;
  }
  return null;
};

const googleFetchJson = async <T>(
  url: string,
  init: RequestInit,
): Promise<T> => {
  const response = await fetch(url, init);
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = googleErrorCode(data);
    const message = code
      ? code
      : data && typeof data === "object" && "error" in data
        ? JSON.stringify((data as { error?: unknown }).error)
        : response.statusText;
    throw new GoogleCalendarApiError(
      message || "Google Calendar request failed.",
      response.status,
      code,
    );
  }
  if (!data || typeof data !== "object") {
    throw new Error("Google Calendar returned an invalid response.");
  }
  return data as T;
};

const refreshGoogleAccessToken = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
): Promise<string> => {
  if (
    connection.accessToken &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return connection.accessToken;
  }

  const grant = grantOf(connection);
  const config = requireGoogleConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: connection.refreshToken || "",
    grant_type: "refresh_token",
  });
  let token: {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  try {
    token = await googleFetchJson<{
      access_token?: string;
      expires_in?: number;
      scope?: string;
    }>(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    if (shouldMarkCalendarReconnectRequired(error)) {
      await markCalendarError(state, grant, error);
    }
    throw error;
  }
  if (!token.access_token) {
    throw new Error("Google did not return an access token.");
  }
  await saveConnectionState(state, grant, "refreshed Google access token", {
    accessToken: token.access_token,
    accessTokenExpiresAt: Date.now() + Math.max(token.expires_in ?? 3600, 60) * 1000,
    status: "connected",
    error: null,
  });
  return token.access_token;
};

/** The Google grant a call was made with: the connection and the refresh token it held. */
type CalendarGrant = Pick<SchedulingCalendarConnection, "profileId" | "id" | "refreshToken">;

const grantOf = (connection: SchedulingCalendarConnection): CalendarGrant =>
  basisOf(connection, ["profileId", "id", "refreshToken"]);

/**
 * Saves what a Google call returned about a host's calendar connection, but
 * only while the connection still holds the grant the call was made with, so
 * a reply that comes back after a reconnect is dropped. These are caches and
 * status marks, so a failed save is logged and the request goes on.
 */
const saveConnectionState = async (
  state: SfuState,
  grant: CalendarGrant,
  what: string,
  patch: Partial<SchedulingCalendarConnection>,
): Promise<void> => {
  try {
    await changeHost(state, grant.profileId, (draft) =>
      applyIfUnchanged(what, draft.calendarByProfileId.get(grant.profileId), grant, (held) =>
        Object.assign(held, patch, { updatedAt: Date.now() }),
      ),
    );
  } catch (error) {
    Logger.warn(`Failed to save ${what}`, error);
  }
};

const markCalendarError = (
  state: SfuState,
  grant: CalendarGrant,
  error: unknown,
): Promise<void> =>
  saveConnectionState(state, grant, "calendar reconnect mark", {
    status: "needs_reconnect",
    error: (error as Error).message || "Google Calendar sync failed.",
  });

const shouldMarkCalendarReconnectRequired = (error: unknown): boolean =>
  error instanceof GoogleCalendarApiError &&
  (error.status === 401 ||
    error.code === "invalid_grant" ||
    error.code === "invalid_client" ||
    error.code === "unauthorized_client");

const fetchGoogleBusy = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  timeMin: number,
  timeMax: number,
): Promise<BusyInterval[]> => {
  const accessToken = await refreshGoogleAccessToken(state, connection);
  const data = await googleFetchJson<{
    calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }>;
  }>(GOOGLE_FREEBUSY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      items: [{ id: connection.calendarId || "primary" }],
    }),
  });
  const calendarId = connection.calendarId || "primary";
  const busy = data.calendars?.[calendarId]?.busy;
  if (!Array.isArray(busy)) {
    throw new Error("Google Calendar returned an invalid freebusy response.");
  }
  return busy
    .map((entry) => ({
      startAt: entry.start ? new Date(entry.start).getTime() : NaN,
      endAt: entry.end ? new Date(entry.end).getTime() : NaN,
    }))
    .filter(
      (entry) => Number.isFinite(entry.startAt) && Number.isFinite(entry.endAt),
    );
};

const fetchOptionalGoogleBusy = async (
  state: SfuState,
  connection: SchedulingCalendarConnection | null,
  eventType: SchedulingEventType,
  timeMin: number,
  timeMax: number,
): Promise<BusyInterval[]> => {
  if (!connection) return [];
  try {
    return await fetchGoogleBusy(state, connection, timeMin, timeMax);
  } catch (error) {
    if (eventType.requiresCalendar) throw error;
    Logger.warn(
      "Optional Google Calendar busy lookup failed; continuing with Conclave availability",
      error,
    );
    return [];
  }
};

type EventTimes = { startAt: number; endAt: number };

/**
 * A Google event a booking created: the grant and calendar it lives in, and
 * the times Google last confirmed it holds, or null while a move is not yet
 * confirmed. One copy is kept across retries, so a retry starts from what
 * Google holds, not from what the event was created with.
 */
type BookingCalendarEvent = {
  id: string;
  grant: CalendarGrant;
  calendarId: string;
  accessToken: string;
  timeZone: string;
  googleTimes: EventTimes | null;
};

const calendarEventsUrl = (calendarId: string, eventId?: string): string =>
  `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events${
    eventId ? `/${encodeURIComponent(eventId)}` : ""
  }?sendUpdates=none`;

const eventTimes = (startAt: number, endAt: number, timeZone: string) => ({
  start: { dateTime: new Date(startAt).toISOString(), timeZone },
  end: { dateTime: new Date(endAt).toISOString(), timeZone },
});

const createGoogleCalendarEvent = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  input: {
    title: string;
    description: string;
    meetingLink: string;
    startAt: number;
    endAt: number;
    timeZone: string;
    attendeeName: string;
    attendeeEmail: string;
  },
): Promise<BookingCalendarEvent> => {
  const grant = grantOf(connection);
  const calendarId = connection.calendarId || "primary";
  try {
    const accessToken = await refreshGoogleAccessToken(state, connection);
    const data = await googleFetchJson<{ id?: string }>(calendarEventsUrl(calendarId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.title,
        location: "Conclave room",
        description: `${input.description ? `${input.description}\n\n` : ""}Join Conclave: ${input.meetingLink}`,
        ...eventTimes(input.startAt, input.endAt, input.timeZone),
        attendees: [
          {
            email: input.attendeeEmail,
            displayName: input.attendeeName,
          },
        ],
      }),
    });
    if (!data.id) throw new Error("Google did not return an event id.");
    return {
      id: data.id,
      grant,
      calendarId,
      accessToken,
      timeZone: input.timeZone,
      googleTimes: { startAt: input.startAt, endAt: input.endAt },
    };
  } catch (error) {
    if (shouldMarkCalendarReconnectRequired(error)) {
      await markCalendarError(state, grant, error);
    }
    throw error;
  }
};

/** The host's connection, if it still holds the grant the event was made with. */
const connectionFor = (state: SfuState, grant: CalendarGrant): SchedulingCalendarConnection | null => {
  const connection = state.scheduling.calendarByProfileId.get(grant.profileId);
  return connection && sameStoredValue(grantOf(connection), grant) ? connection : null;
};

/** Moves the event in Google; what Google holds is unknown until it confirms the move. */
const moveGoogleCalendarEvent = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  event: BookingCalendarEvent,
  times: EventTimes,
): Promise<void> => {
  event.googleTimes = null;
  const accessToken = await refreshGoogleAccessToken(state, connection);
  await googleFetchJson<{ id?: string }>(calendarEventsUrl(event.calendarId, event.id), {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(eventTimes(times.startAt, times.endAt, event.timeZone)),
  });
  event.accessToken = accessToken;
  event.googleTimes = times;
};

/** Deletes an event nothing should point at; an event already gone counts as deleted. */
const deleteGoogleCalendarEvent = async (state: SfuState, event: BookingCalendarEvent): Promise<void> => {
  const connection = connectionFor(state, event.grant);
  const accessToken = connection ? await refreshGoogleAccessToken(state, connection) : event.accessToken;
  const response = await fetch(calendarEventsUrl(event.calendarId, event.id), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new GoogleCalendarApiError(response.statusText || "Google Calendar delete failed.", response.status);
  }
};

const MAX_SETTLE_ROUNDS = 5;

/**
 * Records a Google event a booking created and brings it in line with the
 * saved booking. The event already exists, so its id is never dropped: it
 * is recorded and moved to the booking's saved times when they differ from
 * what Google last confirmed, or the event is deleted when the booking is
 * gone or the host's calendar was reconnected to another grant. The booking
 * reads `synced` only once the saved times match what Google confirmed.
 * Every step is safe to repeat, and `event` carries what Google holds from
 * one attempt to the next.
 */
const settleBookingEvent = async (
  state: SfuState,
  meetingId: string,
  event: BookingCalendarEvent,
): Promise<void> => {
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
    const connection = connectionFor(state, event.grant);
    if (!connection) {
      await deleteGoogleCalendarEvent(state, event);
      Logger.info(`Deleted Google event ${event.id}: the host reconnected Google Calendar while booking ${meetingId} synced`);
      await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [meetingId], (draft) =>
        draft.byId.has(meetingId)
          ? updateScheduledMeeting(draft, meetingId, {
              googleCalendarEventId: null,
              calendarSyncStatus: "failed",
              calendarSyncError: "Google Calendar was reconnected while this booking synced.",
            })
          : null,
      );
      return;
    }
    const recorded = await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [meetingId], (draft) => {
      const held = draft.byId.get(meetingId);
      if (!held) return null;
      const times = { startAt: held.scheduledStartAt, endAt: held.scheduledEndAt };
      const matches = event.googleTimes !== null && sameStoredValue(event.googleTimes, times);
      updateScheduledMeeting(draft, meetingId, {
        googleCalendarEventId: event.id,
        calendarSyncStatus: matches ? "synced" : "pending",
        calendarSyncError: null,
      });
      return { matches, times };
    });
    if (!recorded) {
      await deleteGoogleCalendarEvent(state, event);
      Logger.info(`Deleted Google event ${event.id}: booking ${meetingId} was removed while it synced`);
      return;
    }
    if (recorded.matches) return;
    await moveGoogleCalendarEvent(state, connection, event, recorded.times);
  }
  throw new Error(`Booking ${meetingId} kept moving while its Google event synced`);
};

const meetingMatchesProfile = (
  meeting: ScheduledMeeting,
  profile: SchedulingProfile,
  eventType?: SchedulingEventType | null,
): boolean => {
  if (eventType?.profileId === profile.id) return true;
  if (meeting.clientId !== profile.clientId) return false;
  if (meeting.hostUserId && profile.userId) {
    return meeting.hostUserId === profile.userId;
  }
  return meeting.hostEmail.trim().toLowerCase() === profile.email.trim().toLowerCase();
};

const collectInternalBusy = (
  state: SfuState,
  profile: SchedulingProfile,
  from: number,
  to: number,
): BusyInterval[] =>
  Array.from(state.scheduledMeetings.byId.values())
    .map((meeting) => ({
      meeting,
      eventType: meeting.eventTypeId
        ? state.scheduling.eventTypesById.get(meeting.eventTypeId) ?? null
        : null,
    }))
    .map(({ meeting, eventType }) => ({
      meeting,
      startAt:
        meeting.scheduledStartAt -
        (eventType?.bufferBeforeMinutes ?? 0) * MINUTE_MS,
      endAt:
        meeting.scheduledEndAt +
        (eventType?.bufferAfterMinutes ?? 0) * MINUTE_MS,
    }))
    .filter(({ meeting, startAt, endAt }) => {
      const eventType = meeting.eventTypeId
        ? state.scheduling.eventTypesById.get(meeting.eventTypeId) ?? null
        : null;
      if (!meetingMatchesProfile(meeting, profile, eventType)) return false;
      if (meeting.status === "cancelled" || meeting.status === "ended") return false;
      return startAt < to && from < endAt;
    })
    .map(({ startAt, endAt }) => ({ startAt, endAt }));

const resolvePublicTarget = (
  state: SfuState,
  clientId: string,
  username: string,
  slug: string,
):
  | {
      profile: SchedulingProfile;
      eventType: SchedulingEventType;
      calendar: SchedulingCalendarConnection | null;
    }
  | { error: string; status: number } => {
  const profile = getPublicProfile(state.scheduling, clientId, username);
  if (!profile) return { error: "Scheduling page not found.", status: 404 };
  const eventType = getPublicEventType(state.scheduling, profile, slug);
  if (!eventType || !eventType.isActive) {
    return { error: "Event type is not available.", status: 404 };
  }
  const calendar = requireConnectedCalendar(state, profile);
  return { profile, eventType, calendar };
};

const resolvePublicTargetForClients = (
  state: SfuState,
  clientId: string,
  username: string,
  slug: string,
): ReturnType<typeof resolvePublicTarget> => {
  let lastNotFound: ReturnType<typeof resolvePublicTarget> = {
    error: "Scheduling page not found.",
    status: 404,
  };
  for (const candidateClientId of clientIdCandidates(clientId)) {
    const target = resolvePublicTarget(
      state,
      candidateClientId,
      username,
      slug,
    );
    if (!("error" in target)) return target;
    if (target.status !== 404) return target;
    lastNotFound = target;
  }
  return lastNotFound;
};

const buildConfirmation = (
  meeting: ScheduledMeeting,
  appOrigin: string,
): BookingConfirmation => ({
  id: meeting.id,
  title: meeting.title,
  roomCode: meeting.roomCode,
  meetingLink: buildSchedulingMeetingLink(appOrigin, meeting),
  startsAt: meeting.scheduledStartAt,
  endsAt: meeting.scheduledEndAt,
  hostName: meeting.hostName,
  attendeeName: meeting.attendeeName || "",
  attendeeEmail: meeting.attendeeEmail || "",
  calendarEventId: meeting.googleCalendarEventId ?? null,
  syncStatus: meeting.calendarSyncStatus ?? "not_required",
  emailNotificationStatus: meeting.emailNotificationStatus ?? "not_configured",
});

/**
 * Runs a step that comes after a booking was saved. The booking already
 * exists, so a failure is logged and the step retried in the background,
 * never turned into an error for the guest. Every step is safe to repeat.
 */
const followUpBooking = async (what: string, step: () => Promise<unknown>): Promise<void> => {
  try {
    await step();
  } catch (error) {
    Logger.warn(`Failed ${what}; retrying in the background`, error);
    retryInBackground(what, step);
  }
};

/** Records an outcome on a booking; the outcome depends only on the booking still existing. */
const recordOnBooking = (
  state: SfuState,
  meetingId: string,
  what: string,
  fields: UpdateScheduledMeetingRequest,
) => () =>
  changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [meetingId], (draft) =>
    applyIfUnchanged(`${what} for booking ${meetingId}`, draft.byId.get(meetingId), {}, () =>
      updateScheduledMeeting(draft, meetingId, fields),
    ),
  );

const sendBookingEmails = async (
  input: Parameters<typeof sendSchedulingBookingEmails>[0],
): Promise<SchedulingEmailDeliveryResult> => {
  try {
    return await sendSchedulingBookingEmails(input);
  } catch (error) {
    Logger.warn("Failed to send booking emails", error);
    return { status: "failed", error: (error as Error).message || "Booking email failed.", sentAt: null };
  }
};

export const registerSchedulingRoutes = (
  app: Express,
  options: RegisterOptions,
): void => {
  const { state, sfuSecret } = options;

  const requireSecret = (req: Request, res: Response): boolean => {
    if (hasValidSecret(req, sfuSecret)) return true;
    res.status(401).json({ error: "Unauthorized" });
    return false;
  };

  app.get("/scheduling/profile", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    res.json(profilePayload(state, profile));
  });

  app.put("/scheduling/profile", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    const body = requestBody(req);
    try {
      const updated = await changeHost(state, profile.id, (draft) => {
        const next = updateSchedulingProfile(draft, profile.id, {
          name: readString(body, "name"),
          username: readString(body, "username"),
          timeZone: readString(body, "timeZone"),
        });
        if (typeof body.timeZone === "string") {
          setProfileAvailability(draft, next, {
            ...getProfileAvailability(draft, next),
            timeZone: next.timeZone,
          });
        }
        return next;
      });
      res.json(profilePayload(state, committedProfile(state, updated)));
    } catch (error) {
      answerFailure(res, error, 400);
    }
  });

  app.get("/scheduling/availability/default", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    res.json({ availability: getProfileAvailability(state.scheduling, profile) });
  });

  app.put("/scheduling/availability/default", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    const availability = await changeHost(state, profile.id, (draft) =>
      setProfileAvailability(draft, hostIn(draft, profile.id), requestBody(req)),
    );
    res.json({ availability, profile: committedProfile(state, profile) });
  });

  app.get("/scheduling/event-types", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    res.json({ eventTypes: listEventTypes(state.scheduling, profile.id) });
  });

  app.post("/scheduling/event-types", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    try {
      const eventType = await changeHost(state, profile.id, (draft) =>
        createEventType(draft, hostIn(draft, profile.id), eventTypeInput(requestBody(req))),
      );
      res.status(201).json({ eventType });
    } catch (error) {
      answerFailure(res, error, 400);
    }
  });

  app.patch("/scheduling/event-types/:id", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    try {
      const eventType = await changeHost(state, profile.id, (draft) =>
        updateEventType(draft, hostIn(draft, profile.id), req.params.id, eventTypeInput(requestBody(req))),
      );
      res.json({ eventType });
    } catch (error) {
      answerFailure(res, error, 400);
    }
  });

  app.delete("/scheduling/event-types/:id", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    const eventType = await changeHost(state, profile.id, (draft) =>
      deleteEventType(draft, hostIn(draft, profile.id), req.params.id),
    );
    if (!eventType) {
      res.status(404).json({ error: "Event type not found." });
      return;
    }
    res.json({ success: true, id: eventType.id });
  });

  app.get("/scheduling/calendar/google", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    res.json({ calendar: getCalendarSummary(state.scheduling, profile.id) });
  });

  app.post("/scheduling/calendar/google", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    const body = requestBody(req);
    const existing = state.scheduling.calendarByProfileId.get(profile.id);
    const refreshToken = normalizeIdentifier(body.refreshToken, 4096);
    if (!refreshToken && !existing?.refreshToken) {
      res.status(400).json({
        error:
          "Google did not return offline access. Disconnect and connect Google Calendar again.",
      });
      return;
    }
    const connectionInput = {
      email: normalizeEmail(body.email) || profile.email,
      accessToken: normalizeIdentifier(body.accessToken, 4096),
      refreshToken,
      accessTokenExpiresAt: readNumber(body, "accessTokenExpiresAt") ?? null,
      scopes: (asArray(body.scopes) ?? [])
        .map((scope) => normalizeText(scope, 200))
        .filter(Boolean),
      status: "connected" as const,
      error: null,
    };
    const connection = await changeHost(state, profile.id, (draft) =>
      setGoogleCalendarConnection(draft, hostIn(draft, profile.id), connectionInput),
    );
    res.json({ calendar: getCalendarSummary(state.scheduling, connection.profileId) });
  });

  app.delete("/scheduling/calendar/google", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    await changeHost(state, profile.id, (draft) =>
      clearGoogleCalendarConnection(draft, hostIn(draft, profile.id)),
    );
    res.json({
      calendar: getCalendarSummary(state.scheduling, profile.id),
      eventTypes: listEventTypes(state.scheduling, profile.id),
    });
  });

  app.get("/scheduling/bookings", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    const bookings = Array.from(state.scheduledMeetings.byId.values())
      .filter(
        (meeting) => {
          const eventType = meeting.eventTypeId
            ? state.scheduling.eventTypesById.get(meeting.eventTypeId) ?? null
            : null;
          return (
            meetingMatchesProfile(meeting, profile, eventType) &&
            meeting.source === "booking_link"
          );
        },
      )
      .sort((a, b) => b.scheduledStartAt - a.scheduledStartAt);
    res.json({ bookings });
  });

  app.get("/scheduling/public/:username/:slug", (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = resolvePublicTargetForClients(
      state,
      resolveClientId(req),
      req.params.username,
      req.params.slug,
    );
    if ("error" in target) {
      res.status(target.status).json({ error: target.error });
      return;
    }
    res.json({
      schedulingPage: {
        profile: {
          name: target.profile.name,
          username: target.profile.username,
          timeZone: target.profile.timeZone,
        },
        eventType: {
          id: target.eventType.id,
          slug: target.eventType.slug,
          title: target.eventType.title,
          description: target.eventType.description,
          durationMinutes: target.eventType.durationMinutes,
          minimumNoticeMinutes: target.eventType.minimumNoticeMinutes,
          bookingWindowDays: target.eventType.bookingWindowDays,
        },
        calendar: publicCalendarSummary(
          getCalendarSummary(state.scheduling, target.profile.id),
        ),
      },
    });
  });

  app.get("/scheduling/public/:username/:slug/slots", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = resolvePublicTargetForClients(
      state,
      resolveClientId(req),
      req.params.username,
      req.params.slug,
    );
    if ("error" in target) {
      res.status(target.status).json({ error: target.error });
      return;
    }
    if (hasCalendarConnectionProblem(state, target.profile, target.eventType)) {
      sendCalendarUnavailable(res);
      return;
    }
    const now = Date.now();
    const requestedFrom = Number(req.query.from ?? now);
    const requestedTo = Number(req.query.to ?? now + 14 * DAY_MS);
    if (
      !Number.isFinite(requestedFrom) ||
      !Number.isFinite(requestedTo) ||
      requestedTo <= requestedFrom
    ) {
      res.status(400).json({ error: "Invalid slot range." });
      return;
    }
    const slotFrom = Math.max(
      requestedFrom,
      now + target.eventType.minimumNoticeMinutes * MINUTE_MS,
    );
    const slotTo = Math.min(
      requestedTo,
      now + target.eventType.bookingWindowDays * DAY_MS,
    );
    if (slotTo <= slotFrom) {
      res.json({ slots: [] });
      return;
    }
    const busyFrom =
      slotFrom - target.eventType.bufferBeforeMinutes * MINUTE_MS;
    const busyTo = slotTo + target.eventType.bufferAfterMinutes * MINUTE_MS;
    try {
      const internalBusy = collectInternalBusy(
        state,
        target.profile,
        busyFrom,
        busyTo,
      );
      const googleBusy = await fetchOptionalGoogleBusy(
        state,
        target.calendar,
        target.eventType,
        busyFrom,
        busyTo,
      );
      const slots = generateAvailableSlots({
        eventType: target.eventType,
        availability: getProfileAvailability(state.scheduling, target.profile),
        busyIntervals: [...internalBusy, ...googleBusy],
        from: slotFrom,
        to: slotTo,
        now,
        timeZone: target.profile.timeZone,
      });
      res.json({ slots });
    } catch (error) {
      answerFailure(res, error, 502);
    }
  });

  app.post("/scheduling/public/:username/:slug/book", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const target = resolvePublicTargetForClients(
      state,
      resolveClientId(req),
      req.params.username,
      req.params.slug,
    );
    if ("error" in target) {
      res.status(target.status).json({ error: target.error });
      return;
    }
    if (hasCalendarConnectionProblem(state, target.profile, target.eventType)) {
      sendCalendarUnavailable(res);
      return;
    }

    const body = (req.body ?? {}) as CreateBookingRequest;
    const startAt = Number(body.startAt);
    const attendeeName = normalizeText(body.attendeeName, MAX_NAME_LENGTH);
    const attendeeEmail = normalizeEmail(body.attendeeEmail);
    const attendeeNote = normalizeText(body.attendeeNote, MAX_TEXT_LENGTH);
    const attendeeTimeZone =
      normalizeIdentifier(body.attendeeTimeZone, 80) || target.profile.timeZone;
    if (!Number.isFinite(startAt) || !attendeeName || !attendeeEmail) {
      res.status(400).json({ error: "Name, email, and a valid time are required." });
      return;
    }

    const endAt = startAt + target.eventType.durationMinutes * 60 * 1000;
    const rangeFrom = startAt - 60_000;
    const rangeTo = endAt + 60_000;
    try {
      const bookingSlotLease = await acquireBookingSlotLease(
        state,
        target.profile,
        startAt,
        endAt,
      );
      if (!bookingSlotLease) {
        res.status(409).json({ error: "That time is no longer available." });
        return;
      }
      let slotLeaseReleased = false;
      const releaseSlotLease = async (): Promise<void> => {
        if (slotLeaseReleased) return;
        slotLeaseReleased = true;
        await bookingSlotLease.release();
      };

      const checkAvailability = async (): Promise<boolean> => {
        const internalBusy = collectInternalBusy(
          state,
          target.profile,
          rangeFrom,
          rangeTo,
        );
        const googleBusy = await fetchOptionalGoogleBusy(
          state,
          target.calendar,
          target.eventType,
          rangeFrom,
          rangeTo,
        );
        return generateAvailableSlots({
          eventType: target.eventType,
          availability: getProfileAvailability(state.scheduling, target.profile),
          busyIntervals: [...internalBusy, ...googleBusy],
          from: rangeFrom,
          to: rangeTo,
          timeZone: target.profile.timeZone,
        }).some((slot) => slot.startAt === startAt);
      };

      try {
        const available = await checkAvailability();
        if (!available) {
          await releaseSlotLease();
          res.status(409).json({ error: "That time is no longer available." });
          return;
        }
      } catch (availabilityError) {
        await releaseSlotLease();
        throw availabilityError;
      }

      const appOrigin = resolveAppOrigin(req);
      let meeting: ScheduledMeeting;
      try {
        meeting = await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [], (draft) =>
          createScheduledMeeting(
            draft,
            {
              title: target.eventType.title,
              scheduledStartAt: startAt,
              scheduledEndAt: endAt,
              hostEmail: target.profile.email,
              hostName: target.profile.name,
              source: "booking_link",
              eventTypeId: target.eventType.id,
              attendeeName,
              attendeeEmail,
              attendeeNote,
              attendeeTimeZone,
              calendarSyncStatus: target.calendar ? "pending" : "not_required",
              emailNotificationStatus: isSchedulingEmailConfigured()
                ? "pending"
                : "not_configured",
            },
            {
              clientId: target.profile.clientId,
              createdBy: attendeeEmail,
              defaultHostEmail: target.profile.email,
              defaultHostName: target.profile.name,
              defaultHostUserId: target.profile.userId,
            },
          ),
        );
      } catch (createError) {
        await releaseSlotLease();
        throw createError;
      }
      try {
        await releaseSlotLease();
      } catch (releaseError) {
        Logger.warn("Failed to release booking slot lock", releaseError);
      }

      // The booking is saved, so from here on the guest gets a confirmation.
      // Each later step records its outcome on its own and never fails it,
      // and the confirmation reports only what has been saved.
      let calendarError: string | null = null;
      const calendar = target.calendar;
      if (calendar) {
        try {
          const event = await createGoogleCalendarEvent(state, calendar, {
            title: target.eventType.title,
            description: attendeeNote,
            meetingLink: buildSchedulingMeetingLink(appOrigin, meeting),
            startAt,
            endAt,
            timeZone: target.profile.timeZone,
            attendeeName,
            attendeeEmail,
          });
          await followUpBooking(`syncing the Google event of booking ${meeting.id}`, () =>
            settleBookingEvent(state, meeting.id, event),
          );
        } catch (error) {
          calendarError = (error as Error).message || "Could not create the calendar event.";
          await followUpBooking(
            `saving the calendar failure of booking ${meeting.id}`,
            recordOnBooking(state, meeting.id, "calendar failure", {
              calendarSyncStatus: "failed",
              calendarSyncError: calendarError,
            }),
          );
        }
      }

      let emailError: string | null = null;
      const savedBooking = state.scheduledMeetings.byId.get(meeting.id);
      if (savedBooking) {
        const emailResult = await sendBookingEmails({
          profile: target.profile,
          eventType: target.eventType,
          meeting: structuredClone(savedBooking),
          appOrigin,
          calendarError,
        });
        emailError = emailResult.error;
        await followUpBooking(
          `saving the email status of booking ${meeting.id}`,
          recordOnBooking(state, meeting.id, "email status", {
            emailNotificationStatus: emailResult.status,
            emailNotificationError: emailResult.error,
            emailNotificationSentAt: emailResult.sentAt,
          }),
        );
      } else {
        Logger.info(`Skipped the confirmation email: booking ${meeting.id} was removed while it synced`);
      }

      res.status(201).json({
        booking: buildConfirmation(meeting, appOrigin),
        ...(calendarError ? { calendarError } : {}),
        ...(emailError ? { emailError } : {}),
      });
    } catch (error) {
      Logger.warn("Booking request failed", error);
      answerFailure(res, error, 502);
    }
  });
};

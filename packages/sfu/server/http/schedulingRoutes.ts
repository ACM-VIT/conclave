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
  listEventTypes,
  moveSchedulingProfileToClient,
  persistScheduling,
  setGoogleCalendarConnection,
  setProfileAvailability,
  updateEventType,
  updateSchedulingProfile,
  type BusyInterval,
} from "../scheduling.js";
import {
  createScheduledMeeting,
  deleteScheduledMeeting,
  moveScheduledMeetingToClient,
  persistScheduledMeetingChanges,
  updateScheduledMeeting,
  type BookingSlotLease,
} from "../scheduledMeetings.js";
import {
  isSchedulingEmailConfigured,
  sendSchedulingBookingEmails,
  type SchedulingEmailDeliveryResult,
} from "../schedulingEmails.js";
import { buildSchedulingMeetingLink } from "../schedulingLinks.js";
import type { SfuState } from "../state.js";
import type {
  BookingConfirmation,
  CalendarConnectionSummary,
  CreateBookingRequest,
  ScheduledMeeting,
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

const CONCLAVE_CLIENT_ID = "conclave";
const LEGACY_WEB_CLIENT_IDS = ["default", "public"];

const resolveDefaultClientId = (): string =>
  process.env.SFU_CLIENT_ID?.trim() ||
  process.env.NEXT_PUBLIC_SFU_CLIENT_ID?.trim() ||
  CONCLAVE_CLIENT_ID;

const clientIdCandidates = (primary: string): string[] => {
  const seen = new Set<string>();
  return [primary, resolveDefaultClientId(), CONCLAVE_CLIENT_ID, ...LEGACY_WEB_CLIENT_IDS]
    .map((clientId) => clientId.trim())
    .filter((clientId) => {
      if (!clientId || seen.has(clientId)) return false;
      seen.add(clientId);
      return true;
    });
};

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
  return fromQuery || fromHeader || fallback;
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

const migrateProfileNamespace = async (
  state: SfuState,
  profile: SchedulingProfile,
  clientId: string,
): Promise<void> => {
  const previousClientId = profile.clientId;
  if (previousClientId === clientId) return;
  const eventTypeIds = new Set(
    Array.from(state.scheduling.eventTypesById.values())
      .filter((eventType) => eventType.profileId === profile.id)
      .map((eventType) => eventType.id),
  );

  moveSchedulingProfileToClient(state.scheduling, profile, clientId);

  const changedMeetings: ScheduledMeeting[] = [];
  for (const meeting of state.scheduledMeetings.byId.values()) {
    if (meeting.clientId !== previousClientId) continue;
    if (meeting.source !== "booking_link") continue;
    const belongsToProfile =
      (meeting.eventTypeId && eventTypeIds.has(meeting.eventTypeId)) ||
      (meeting.hostUserId && meeting.hostUserId === profile.userId) ||
      meeting.hostEmail.trim().toLowerCase() === profile.email;
    if (!belongsToProfile) continue;
    try {
      const moved = moveScheduledMeetingToClient(
        state.scheduledMeetings,
        meeting.id,
        clientId,
      );
      if (moved) changedMeetings.push(moved);
    } catch (error) {
      Logger.warn(
        `Skipped scheduled meeting namespace migration for ${meeting.id}`,
        error,
      );
    }
  }

  if (changedMeetings.length > 0 && state.scheduledMeetingPersistence) {
    await persistScheduledMeetingChanges(
      state.scheduledMeetings,
      state.scheduledMeetingPersistence,
      changedMeetings,
    );
  }
};

const requireHostProfile = async (
  req: Request,
  res: Response,
  state: SfuState,
): Promise<SchedulingProfile | null> => {
  const user = resolveUserContext(req);
  if (!user.email || !user.userId) {
    res.status(400).json({ error: "User context required" });
    return null;
  }
  const clientId = resolveClientId(req);
  const existingProfile = getProfileByUser(
    state.scheduling,
    clientId,
    user.userId,
  );
  if (!existingProfile) {
    for (const legacyClientId of clientIdCandidates(clientId).slice(1)) {
      const legacyProfile = getProfileByUser(
        state.scheduling,
        legacyClientId,
        user.userId,
      );
      if (!legacyProfile) continue;
      await migrateProfileNamespace(state, legacyProfile, clientId);
      break;
    }
  }
  const profile = ensureSchedulingProfile(state.scheduling, {
    clientId,
    userId: user.userId,
    email: user.email,
    name: user.name,
    timeZone: readString(requestBody(req), "timeZone"),
  });
  await persistScheduling(state.scheduling, state.schedulingPersistence);
  return profile;
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
      await markCalendarError(state, connection, error);
    }
    throw error;
  }
  if (!token.access_token) {
    throw new Error("Google did not return an access token.");
  }
  connection.accessToken = token.access_token;
  connection.accessTokenExpiresAt =
    Date.now() + Math.max(token.expires_in ?? 3600, 60) * 1000;
  connection.status = "connected";
  connection.error = null;
  connection.updatedAt = Date.now();
  await persistScheduling(state.scheduling, state.schedulingPersistence);
  return connection.accessToken;
};

const markCalendarError = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  error: unknown,
): Promise<void> => {
  connection.status = "needs_reconnect";
  connection.error = (error as Error).message || "Google Calendar sync failed.";
  connection.updatedAt = Date.now();
  await persistScheduling(state.scheduling, state.schedulingPersistence);
};

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
): Promise<string> => {
  try {
    const accessToken = await refreshGoogleAccessToken(state, connection);
    const url = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(
      connection.calendarId || "primary",
    )}/events?sendUpdates=none`;
    const data = await googleFetchJson<{ id?: string }>(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.title,
        location: "Conclave room",
        description: `${input.description ? `${input.description}\n\n` : ""}Join Conclave: ${input.meetingLink}`,
        start: {
          dateTime: new Date(input.startAt).toISOString(),
          timeZone: input.timeZone,
        },
        end: {
          dateTime: new Date(input.endAt).toISOString(),
          timeZone: input.timeZone,
        },
        attendees: [
          {
            email: input.attendeeEmail,
            displayName: input.attendeeName,
          },
        ],
      }),
    });
    if (!data.id) throw new Error("Google did not return an event id.");
    return data.id;
  } catch (error) {
    if (shouldMarkCalendarReconnectRequired(error)) {
      await markCalendarError(state, connection, error);
    }
    throw error;
  }
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

const sendBookingEmailNotifications = async (
  state: SfuState,
  input: {
    profile: SchedulingProfile;
    eventType: SchedulingEventType;
    meeting: ScheduledMeeting;
    appOrigin: string;
    calendarError?: string | null;
  },
): Promise<{
  meeting: ScheduledMeeting;
  emailResult: SchedulingEmailDeliveryResult;
}> => {
  const emailResult = await sendSchedulingBookingEmails(input);
  const next = updateScheduledMeeting(state.scheduledMeetings, input.meeting.id, {
    emailNotificationStatus: emailResult.status,
    emailNotificationError: emailResult.error,
    emailNotificationSentAt: emailResult.sentAt,
  });
  try {
    await persistMeetingChange(state, next);
  } catch (error) {
    Logger.warn("Failed to persist scheduling email status", error);
  }
  return { meeting: next, emailResult };
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
      const updated = updateSchedulingProfile(state.scheduling, profile.id, {
        name: readString(body, "name"),
        username: readString(body, "username"),
        timeZone: readString(body, "timeZone"),
      });
      if (typeof body.timeZone === "string") {
        setProfileAvailability(state.scheduling, updated, {
          ...getProfileAvailability(state.scheduling, updated),
          timeZone: updated.timeZone,
        });
      }
      await persistScheduling(state.scheduling, state.schedulingPersistence);
      res.json(profilePayload(state, updated));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
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
    const availability = setProfileAvailability(
      state.scheduling,
      profile,
      requestBody(req),
    );
    await persistScheduling(state.scheduling, state.schedulingPersistence);
    res.json({ availability, profile });
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
      const eventType = createEventType(
        state.scheduling,
        profile,
        eventTypeInput(requestBody(req)),
      );
      await persistScheduling(state.scheduling, state.schedulingPersistence);
      res.status(201).json({ eventType });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.patch("/scheduling/event-types/:id", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    try {
      const eventType = updateEventType(
        state.scheduling,
        profile,
        req.params.id,
        eventTypeInput(requestBody(req)),
      );
      await persistScheduling(state.scheduling, state.schedulingPersistence);
      res.json({ eventType });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete("/scheduling/event-types/:id", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    const eventType = deleteEventType(state.scheduling, profile, req.params.id);
    if (!eventType) {
      res.status(404).json({ error: "Event type not found." });
      return;
    }
    await persistScheduling(state.scheduling, state.schedulingPersistence);
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
    const connection = setGoogleCalendarConnection(state.scheduling, profile, {
      email: normalizeEmail(body.email) || profile.email,
      accessToken: normalizeIdentifier(body.accessToken, 4096),
      refreshToken,
      accessTokenExpiresAt: readNumber(body, "accessTokenExpiresAt") ?? null,
      scopes: (asArray(body.scopes) ?? [])
        .map((scope) => normalizeText(scope, 200))
        .filter(Boolean),
      status: "connected",
      error: null,
    });
    await persistScheduling(state.scheduling, state.schedulingPersistence);
    res.json({ calendar: getCalendarSummary(state.scheduling, connection.profileId) });
  });

  app.delete("/scheduling/calendar/google", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const profile = await requireHostProfile(req, res, state);
    if (!profile) return;
    clearGoogleCalendarConnection(state.scheduling, profile);
    await persistScheduling(state.scheduling, state.schedulingPersistence);
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
      res.status(502).json({ error: (error as Error).message });
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
        meeting = createScheduledMeeting(
          state.scheduledMeetings,
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
        );
      } catch (createError) {
        await releaseSlotLease();
        throw createError;
      }
      try {
        await persistMeetingChange(state, meeting);
      } catch (persistError) {
        deleteScheduledMeeting(state.scheduledMeetings, meeting.id);
        await releaseSlotLease();
        throw persistError;
      }
      try {
        await releaseSlotLease();
      } catch (releaseError) {
        Logger.warn("Failed to release booking slot lock", releaseError);
      }

      const calendar = target.calendar;
      if (!calendar) {
        const { meeting: notified, emailResult } =
          await sendBookingEmailNotifications(state, {
            profile: target.profile,
            eventType: target.eventType,
            meeting,
            appOrigin,
          });
        res.status(201).json({
          booking: buildConfirmation(notified, appOrigin),
          ...(emailResult.error ? { emailError: emailResult.error } : {}),
        });
        return;
      }

      try {
        const meetingLink = buildSchedulingMeetingLink(appOrigin, meeting);
        const calendarEventId = await createGoogleCalendarEvent(
          state,
          calendar,
          {
            title: target.eventType.title,
            description: attendeeNote,
            meetingLink,
            startAt,
            endAt,
            timeZone: target.profile.timeZone,
            attendeeName,
            attendeeEmail,
          },
        );
        const synced = updateScheduledMeeting(state.scheduledMeetings, meeting.id, {
          googleCalendarEventId: calendarEventId,
          calendarSyncStatus: "synced",
          calendarSyncError: null,
        });
        await persistMeetingChange(state, synced);
        const { meeting: notified, emailResult } =
          await sendBookingEmailNotifications(state, {
            profile: target.profile,
            eventType: target.eventType,
            meeting: synced,
            appOrigin,
          });
        res.status(201).json({
          booking: buildConfirmation(notified, appOrigin),
          ...(emailResult.error ? { emailError: emailResult.error } : {}),
        });
      } catch (calendarError) {
        const message =
          (calendarError as Error).message || "Could not create the calendar event.";
        const failed = updateScheduledMeeting(state.scheduledMeetings, meeting.id, {
          calendarSyncStatus: "failed",
          calendarSyncError: message,
        });
        await persistMeetingChange(state, failed);
        const { meeting: notified, emailResult } =
          await sendBookingEmailNotifications(state, {
            profile: target.profile,
            eventType: target.eventType,
            meeting: failed,
            appOrigin,
            calendarError: message,
          });
        res.status(201).json({
          booking: buildConfirmation(notified, appOrigin),
          calendarError: message,
          ...(emailResult.error ? { emailError: emailResult.error } : {}),
        });
      }
    } catch (error) {
      Logger.warn("Booking request failed", error);
      res.status(502).json({ error: (error as Error).message });
    }
  });
};

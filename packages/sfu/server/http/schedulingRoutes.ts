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
  calendarSummary,
  defaultWeeklyAvailability,
  generateAvailableSlots,
  isCalendarUsable,
  type BusyInterval,
} from "../scheduling.js";
import {
  BOOKING_GONE,
  BOOKING_PAGE_CHANGED,
  SLOT_TAKEN,
  bookSlot,
  bookingTarget,
  connectHostCalendar,
  createHostEventType,
  deleteHostEventType,
  disconnectHostCalendar,
  ensureHostProfile,
  hostBookings,
  hostBusyIntervals,
  hostDashboard,
  patchCalendarToken,
  recordBookingCalendarFailure,
  recordBookingEmailResult,
  setHostHours,
  settleBookingCalendar,
  updateHostEventType,
  updateHostProfile,
  type BookingTarget,
  type HostDashboard,
} from "../controlPlane/schedulingCommands.js";
import { commitFollowUp } from "../controlPlane/followUp.js";
import { StoreCorruptionError, StoreUnavailableError } from "../controlPlane/model.js";
import {
  isSchedulingEmailConfigured,
  sendSchedulingBookingEmails,
} from "../schedulingEmails.js";
import { buildSchedulingMeetingLink } from "../schedulingLinks.js";
import type { SfuState } from "../state.js";
import { canonicalizeClientId, resolveDefaultClientId } from "../clientIds.js";
import type {
  BookingConfirmation,
  CalendarConnectionSummary,
  CreateBookingRequest,
  ScheduledMeeting,
  SchedulingCalendarConnection,
  SchedulingEventType,
  SchedulingProfile,
} from "../../types.js";
import {
  STORE_UNAVAILABLE_MESSAGE,
  controlPlaneRoute,
  sendFailure,
} from "./controlPlaneReplies.js";

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

const shouldMarkCalendarReconnectRequired = (error: unknown): boolean =>
  error instanceof GoogleCalendarApiError &&
  (error.status === 401 ||
    error.code === "invalid_grant" ||
    error.code === "invalid_client" ||
    error.code === "unauthorized_client");


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

const isStoreError = (error: unknown): boolean =>
  error instanceof StoreUnavailableError || error instanceof StoreCorruptionError;

const markCalendarError = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  error: unknown,
): Promise<void> => {
  state.googleAccessTokens.delete(connection.grantId);
  try {
    await state.controlPlane.commit(
      patchCalendarToken(connection.profileId, connection.grantId, {
        status: "needs_reconnect",
        error: (error as Error).message || "Google Calendar sync failed.",
      }),
    );
  } catch (storeError) {
    Logger.warn("Failed to record that Google Calendar needs a reconnect", storeError);
  }
};

const refreshGoogleAccessToken = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
): Promise<string> => {
  const freshAfter = Date.now() + 60_000;
  const cached = state.googleAccessTokens.get(connection.grantId);
  if (cached && cached.expiresAt > freshAfter) return cached.token;
  if (
    connection.accessToken &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt > freshAfter
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
  let token: { access_token?: string; expires_in?: number };
  try {
    token = await googleFetchJson<{ access_token?: string; expires_in?: number }>(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
  } catch (error) {
    if (shouldMarkCalendarReconnectRequired(error)) {
      await markCalendarError(state, connection, error);
    }
    throw error;
  }
  if (!token.access_token) {
    throw new Error("Google did not return an access token.");
  }
  state.googleAccessTokens.set(connection.grantId, {
    token: token.access_token,
    expiresAt: Date.now() + Math.max(token.expires_in ?? 3600, 60) * 1000,
  });
  return token.access_token;
};

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
    .filter((entry) => Number.isFinite(entry.startAt) && Number.isFinite(entry.endAt));
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
        start: { dateTime: new Date(input.startAt).toISOString(), timeZone: input.timeZone },
        end: { dateTime: new Date(input.endAt).toISOString(), timeZone: input.timeZone },
        attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName }],
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

const deleteGoogleCalendarEvent = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  eventId: string,
): Promise<void> => {
  try {
    const accessToken = await refreshGoogleAccessToken(state, connection);
    const response = await fetch(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(
        connection.calendarId || "primary",
      )}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`Google answered ${response.status}`);
    }
  } catch (error) {
    Logger.warn(`Failed to remove orphaned Google Calendar event ${eventId}`, error);
  }
};

const hasCalendarConnectionProblem = (target: BookingTarget): boolean =>
  target.eventType.value.requiresCalendar &&
  calendarSummary(target.calendar).status !== "connected";

const sendCalendarUnavailable = (res: Response): void => {
  res.status(503).json({
    error:
      "Calendar availability is temporarily unavailable. Ask the host to reconnect Google Calendar.",
  });
};

const availabilityFor = (target: BookingTarget) =>
  target.hours?.value.availability ??
  defaultWeeklyAvailability(target.profile.value.timeZone, target.profile.value.updatedAt);

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

  const requireHostProfile = async (
    req: Request,
    res: Response,
    options: { syncIdentity: boolean },
  ): Promise<SchedulingProfile | null> => {
    const user = resolveUserContext(req);
    if (!user.email || !user.userId) {
      res.status(400).json({ error: "User context required" });
      return null;
    }
    const result = await state.controlPlane.commit(
      ensureHostProfile(
        {
          clientId: resolveClientId(req),
          userId: user.userId,
          email: user.email,
          name: user.name,
          timeZone: readString(requestBody(req), "timeZone"),
        },
        options,
      ),
    );
    if (!result.ok) {
      sendFailure(res, result);
      return null;
    }
    return result.value;
  };

  const readDashboard = async (
    req: Request,
    res: Response,
  ): Promise<HostDashboard | null> => {
    const profile = await requireHostProfile(req, res, { syncIdentity: false });
    if (!profile) return null;
    const dashboard = await state.controlPlane.read(hostDashboard(profile.id));
    if (!dashboard) {
      res.status(404).json({ error: "Scheduling profile not found." });
      return null;
    }
    return dashboard;
  };

  const resolveTarget = async (
    req: Request,
    res: Response,
  ): Promise<BookingTarget | null> => {
    const target = await state.controlPlane.read(
      bookingTarget(resolveClientId(req), String(req.params.username), String(req.params.slug)),
    );
    if ("error" in target) {
      res.status(target.status).json({ error: target.error });
      return null;
    }
    return target;
  };

  app.get(
    "/scheduling/profile",
    controlPlaneRoute("read the scheduling profile", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const dashboard = await readDashboard(req, res);
      if (dashboard) res.json(dashboard);
    }),
  );

  app.put(
    "/scheduling/profile",
    controlPlaneRoute("update the scheduling profile", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: true });
      if (!profile) return;
      const body = requestBody(req);
      const result = await state.controlPlane.commit(
        updateHostProfile(profile.id, {
          name: readString(body, "name"),
          username: readString(body, "username"),
          timeZone: readString(body, "timeZone"),
        }),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json(result.value);
    }),
  );

  app.get(
    "/scheduling/availability/default",
    controlPlaneRoute("read availability", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const dashboard = await readDashboard(req, res);
      if (dashboard) res.json({ availability: dashboard.availability });
    }),
  );

  app.put(
    "/scheduling/availability/default",
    controlPlaneRoute("save availability", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: true });
      if (!profile) return;
      const result = await state.controlPlane.commit(setHostHours(profile.id, requestBody(req)));
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json(result.value);
    }),
  );

  app.get(
    "/scheduling/event-types",
    controlPlaneRoute("list event types", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const dashboard = await readDashboard(req, res);
      if (dashboard) res.json({ eventTypes: dashboard.eventTypes });
    }),
  );

  app.post(
    "/scheduling/event-types",
    controlPlaneRoute("create an event type", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: true });
      if (!profile) return;
      const result = await state.controlPlane.commit(
        createHostEventType(profile.id, eventTypeInput(requestBody(req))),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.status(201).json({ eventType: result.value });
    }),
  );

  app.patch(
    "/scheduling/event-types/:id",
    controlPlaneRoute("update an event type", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: true });
      if (!profile) return;
      const result = await state.controlPlane.commit(
        updateHostEventType(profile.id, String(req.params.id), eventTypeInput(requestBody(req))),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json({ eventType: result.value });
    }),
  );

  app.delete(
    "/scheduling/event-types/:id",
    controlPlaneRoute("delete an event type", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: true });
      if (!profile) return;
      const result = await state.controlPlane.commit(
        deleteHostEventType(profile.id, String(req.params.id)),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json({ success: true, id: result.value.id });
    }),
  );

  app.get(
    "/scheduling/calendar/google",
    controlPlaneRoute("read the calendar connection", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const dashboard = await readDashboard(req, res);
      if (dashboard) res.json({ calendar: dashboard.calendar });
    }),
  );

  app.post(
    "/scheduling/calendar/google",
    controlPlaneRoute("connect Google Calendar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: true });
      if (!profile) return;
      const body = requestBody(req);
      const result = await state.controlPlane.commit(
        connectHostCalendar(profile.id, {
          email: normalizeEmail(body.email) || profile.email,
          accessToken: normalizeIdentifier(body.accessToken, 4096),
          refreshToken: normalizeIdentifier(body.refreshToken, 4096),
          accessTokenExpiresAt: readNumber(body, "accessTokenExpiresAt") ?? null,
          scopes: (asArray(body.scopes) ?? [])
            .map((scope) => normalizeText(scope, 200))
            .filter(Boolean),
        }),
      );
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json({ calendar: result.value });
    }),
  );

  app.delete(
    "/scheduling/calendar/google",
    controlPlaneRoute("disconnect Google Calendar", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: true });
      if (!profile) return;
      const result = await state.controlPlane.commit(disconnectHostCalendar(profile.id));
      if (!result.ok) {
        sendFailure(res, result);
        return;
      }
      res.json(result.value);
    }),
  );

  app.get(
    "/scheduling/bookings",
    controlPlaneRoute("list bookings", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const profile = await requireHostProfile(req, res, { syncIdentity: false });
      if (!profile) return;
      res.json({ bookings: await state.controlPlane.read(hostBookings(profile.id)) });
    }),
  );

  app.get(
    "/scheduling/public/:username/:slug",
    controlPlaneRoute("read a booking page", async (req, res) => {
      if (!requireSecret(req, res)) return;
      const target = await resolveTarget(req, res);
      if (!target) return;
      const profile = target.profile.value;
      const eventType = target.eventType.value;
      res.json({
        schedulingPage: {
          profile: { name: profile.name, username: profile.username, timeZone: profile.timeZone },
          eventType: {
            id: eventType.id,
            slug: eventType.slug,
            title: eventType.title,
            description: eventType.description,
            durationMinutes: eventType.durationMinutes,
            minimumNoticeMinutes: eventType.minimumNoticeMinutes,
            bookingWindowDays: eventType.bookingWindowDays,
          },
          calendar: publicCalendarSummary(calendarSummary(target.calendar)),
        },
      });
    }),
  );

  app.get("/scheduling/public/:username/:slug/slots", async (req, res) => {
    if (!requireSecret(req, res)) return;
    try {
      const target = await resolveTarget(req, res);
      if (!target) return;
      if (hasCalendarConnectionProblem(target)) {
        sendCalendarUnavailable(res);
        return;
      }
      const eventType = target.eventType.value;
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
      const slotFrom = Math.max(requestedFrom, now + eventType.minimumNoticeMinutes * MINUTE_MS);
      const slotTo = Math.min(requestedTo, now + eventType.bookingWindowDays * DAY_MS);
      if (slotTo <= slotFrom) {
        res.json({ slots: [] });
        return;
      }
      const busyFrom = slotFrom - eventType.bufferBeforeMinutes * MINUTE_MS;
      const busyTo = slotTo + eventType.bufferAfterMinutes * MINUTE_MS;
      const internalBusy = await state.controlPlane.read(
        hostBusyIntervals(target.profile.value.id, busyFrom, busyTo),
      );
      const googleBusy = await fetchOptionalGoogleBusy(
        state,
        isCalendarUsable(target.calendar) ? target.calendar : null,
        eventType,
        busyFrom,
        busyTo,
      );
      res.json({
        slots: generateAvailableSlots({
          eventType,
          availability: availabilityFor(target),
          busyIntervals: [...internalBusy, ...googleBusy],
          from: slotFrom,
          to: slotTo,
          now,
          timeZone: target.profile.value.timeZone,
        }),
      });
    } catch (error) {
      if (isStoreError(error)) {
        Logger.error("[ControlPlane] slot lookup failed", error);
        res.status(503).json({ error: STORE_UNAVAILABLE_MESSAGE });
        return;
      }
      res.status(502).json({ error: (error as Error).message });
    }
  });

  app.post("/scheduling/public/:username/:slug/book", async (req, res) => {
    if (!requireSecret(req, res)) return;
    const body = (req.body ?? {}) as CreateBookingRequest;
    const startAt = Number(body.startAt);
    const attendeeName = normalizeText(body.attendeeName, MAX_NAME_LENGTH);
    const attendeeEmail = normalizeEmail(body.attendeeEmail);
    const attendeeNote = normalizeText(body.attendeeNote, MAX_TEXT_LENGTH);
    const appOrigin = resolveAppOrigin(req);
    try {
      const commitBooking = async (
        retriesLeft: number,
      ): Promise<{ target: BookingTarget; meeting: ScheduledMeeting; calendar: SchedulingCalendarConnection | null } | null> => {
        const target = await resolveTarget(req, res);
        if (!target) return null;
        if (hasCalendarConnectionProblem(target)) {
          sendCalendarUnavailable(res);
          return null;
        }
        if (!Number.isFinite(startAt) || !attendeeName || !attendeeEmail) {
          res.status(400).json({ error: "Name, email, and a valid time are required." });
          return null;
        }
        const profile = target.profile.value;
        const eventType = target.eventType.value;
        const calendar = isCalendarUsable(target.calendar) ? target.calendar : null;
        const endAt = startAt + eventType.durationMinutes * MINUTE_MS;
        const rangeFrom = startAt - 60_000;
        const rangeTo = endAt + 60_000;
        const internalBusy = await state.controlPlane.read(
          hostBusyIntervals(profile.id, rangeFrom, rangeTo),
        );
        const googleBusy = await fetchOptionalGoogleBusy(
          state,
          calendar,
          eventType,
          rangeFrom,
          rangeTo,
        );
        const offered = generateAvailableSlots({
          eventType,
          availability: availabilityFor(target),
          busyIntervals: [...internalBusy, ...googleBusy],
          from: rangeFrom,
          to: rangeTo,
          timeZone: profile.timeZone,
        }).some((slot) => slot.startAt === startAt);
        if (!offered) {
          res.status(409).json({ error: SLOT_TAKEN });
          return null;
        }
        const result = await state.controlPlane.commit(
          bookSlot({
            profileId: profile.id,
            eventTypeId: eventType.id,
            expect: {
              profileRev: target.profile.rev,
              eventTypeRev: target.eventType.rev,
              hoursRev: target.hours?.rev ?? 0,
              grantId: calendar?.grantId ?? null,
            },
            startAt,
            endAt,
            request: {
              title: eventType.title,
              scheduledStartAt: startAt,
              scheduledEndAt: endAt,
              hostEmail: profile.email,
              hostName: profile.name,
              source: "booking_link",
              eventTypeId: eventType.id,
              attendeeName,
              attendeeEmail,
              attendeeNote,
              attendeeTimeZone:
                normalizeIdentifier(body.attendeeTimeZone, 80) || profile.timeZone,
              calendarSyncStatus: calendar ? "pending" : "not_required",
              emailNotificationStatus: isSchedulingEmailConfigured() ? "pending" : "not_configured",
            },
            options: {
              clientId: profile.clientId,
              createdBy: attendeeEmail,
              defaultHostEmail: profile.email,
              defaultHostName: profile.name,
              defaultHostUserId: profile.userId,
            },
          }),
        );
        if (result.ok) return { target, meeting: result.value, calendar };
        if (result.message === BOOKING_PAGE_CHANGED && retriesLeft > 0) {
          return commitBooking(retriesLeft - 1);
        }
        if (result.reason === "conflict") {
          res.status(409).json({ error: SLOT_TAKEN });
          return null;
        }
        sendFailure(res, result);
        return null;
      };

      const booked = await commitBooking(1);
      if (!booked) return;
      const { target, calendar } = booked;
      let latest = booked.meeting;
      let calendarError: string | null = null;
      const profile = target.profile.value;
      const eventType = target.eventType.value;

      const bookingGone = (): void => {
        res.status(409).json({ error: BOOKING_GONE });
      };

      if (calendar) {
        let eventId: string | null = null;
        try {
          eventId = await createGoogleCalendarEvent(state, calendar, {
            title: eventType.title,
            description: attendeeNote,
            meetingLink: buildSchedulingMeetingLink(appOrigin, latest),
            startAt: latest.scheduledStartAt,
            endAt: latest.scheduledEndAt,
            timeZone: profile.timeZone,
            attendeeName,
            attendeeEmail: attendeeEmail ?? "",
          });
        } catch (error) {
          calendarError = (error as Error).message || "Could not create the calendar event.";
        }
        if (eventId) {
          const settled = await commitFollowUp(
            state.controlPlane,
            `calendar event ${eventId} for booking ${latest.id}`,
            settleBookingCalendar({
              meetingId: latest.id,
              profileId: profile.id,
              grantId: calendar.grantId,
              eventId,
              startAt: latest.scheduledStartAt,
              endAt: latest.scheduledEndAt,
            }),
          );
          if (settled && !settled.ok) {
            await deleteGoogleCalendarEvent(state, calendar, eventId);
            bookingGone();
            return;
          }
          if (settled?.ok && settled.value.orphaned) {
            await deleteGoogleCalendarEvent(state, calendar, eventId);
            bookingGone();
            return;
          }
          if (settled?.ok) latest = settled.value.meeting;
        } else if (calendarError) {
          const failed = await commitFollowUp(
            state.controlPlane,
            `calendar failure for booking ${latest.id}`,
            recordBookingCalendarFailure(latest.id, calendarError),
          );
          if (failed && !failed.ok) {
            bookingGone();
            return;
          }
          if (failed?.ok) latest = failed.value;
        }
      }

      const emailResult = await sendSchedulingBookingEmails({
        profile,
        eventType,
        meeting: latest,
        appOrigin,
        calendarError,
      });
      const recorded = await commitFollowUp(
        state.controlPlane,
        `booking email result for ${latest.id}`,
        recordBookingEmailResult(latest.id, emailResult),
      );
      if (recorded && !recorded.ok) {
        bookingGone();
        return;
      }
      if (recorded?.ok) latest = recorded.value;
      res.status(201).json({
        booking: buildConfirmation(latest, appOrigin),
        ...(calendarError ? { calendarError } : {}),
        ...(emailResult.error ? { emailError: emailResult.error } : {}),
      });
    } catch (error) {
      if (res.headersSent) return;
      if (isStoreError(error)) {
        Logger.error("[ControlPlane] booking failed", error);
        res.status(503).json({ error: STORE_UNAVAILABLE_MESSAGE });
        return;
      }
      Logger.warn("Booking request failed", error);
      res.status(502).json({ error: (error as Error).message });
    }
  });
};

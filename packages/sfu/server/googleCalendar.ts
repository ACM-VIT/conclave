import { Logger } from "../utilities/loggers.js";
import { patchCalendarToken } from "./controlPlane/schedulingCommands.js";
import { usesImportedCalendarGrant, type BusyInterval } from "./scheduling.js";
import type { SfuState } from "./state.js";
import type { SchedulingCalendarConnection, SchedulingEventType } from "../types.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_EVENT_DEADLINE_MS = 15_000;

export const requireGoogleConfig = (): { clientId: string; clientSecret: string } => {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google Calendar sync is not configured.");
  }
  return { clientId, clientSecret };
};


export class GoogleCalendarApiError extends Error {
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

export const refreshGoogleAccessToken = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  signal?: AbortSignal,
): Promise<string> => {
  const freshAfter = Date.now() + 60_000;
  const cached = state.googleAccessTokens.get(connection.grantId);
  if (cached && cached.expiresAt > freshAfter) return cached.token;
  if (
    // Legacy access tokens have no provenance. Use the refresh token bound to the grant.
    !usesImportedCalendarGrant(connection) &&
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
        signal,
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

export const fetchOptionalGoogleBusy = async (
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


export const createGoogleCalendarEvent = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  input: {
    eventId: string;
    title: string;
    description: string;
    meetingLink: string;
    startAt: number;
    endAt: number;
    timeZone: string;
    attendeeName: string;
    attendeeEmail: string;
  },
  { accessToken, signal }: { accessToken: string; signal: AbortSignal },
): Promise<string> => {
  try {
    const url = `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(
      connection.calendarId || "primary",
    )}/events?sendUpdates=none`;
    const data = await googleFetchJson<{ id?: string }>(url, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: input.eventId,
        summary: input.title,
        location: "Conclave room",
        description: `${input.description ? `${input.description}\n\n` : ""}Join Conclave: ${input.meetingLink}`,
        start: { dateTime: new Date(input.startAt).toISOString(), timeZone: input.timeZone },
        end: { dateTime: new Date(input.endAt).toISOString(), timeZone: input.timeZone },
        attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName }],
      }),
    });
    if (data.id !== input.eventId) throw new Error("Google did not keep the requested event id.");
    return data.id;
  } catch (error) {
    if (error instanceof GoogleCalendarApiError && error.status === 409) return input.eventId;
    if (shouldMarkCalendarReconnectRequired(error)) {
      await markCalendarError(state, connection, error);
    }
    throw error;
  }
};

export const deleteGoogleCalendarEvent = async (
  state: SfuState,
  connection: SchedulingCalendarConnection,
  eventId: string,
): Promise<"deleted" | "missing"> => {
  const signal = AbortSignal.timeout(GOOGLE_EVENT_DEADLINE_MS);
  const accessToken = await refreshGoogleAccessToken(state, connection, signal);
  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(
      connection.calendarId || "primary",
    )}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    { method: "DELETE", signal, headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (response.ok || response.status === 410) return "deleted";
  if (response.status === 404) return "missing";
  const error = new GoogleCalendarApiError(`Google answered ${response.status}`, response.status);
  if (shouldMarkCalendarReconnectRequired(error)) await markCalendarError(state, connection, error);
  throw error;
};

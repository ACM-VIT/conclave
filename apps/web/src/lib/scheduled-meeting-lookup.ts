export interface PublicScheduledMeeting {
  id: string;
  clientId?: string;
  bookingLink?: boolean;
  roomCode: string;
  title: string;
  hostName: string;
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: "scheduled" | "live" | "ended" | "cancelled";
  startedAt: number | null;
  endedAt: number | null;
}

export class SfuTooOldForBookingsError extends Error {
  constructor() {
    super("The meeting service is older than this page and cannot look scheduled meetings up yet.");
    this.name = "SfuTooOldForBookingsError";
  }
}

export const isSfuTooOldForBookings = (error: unknown): boolean =>
  error instanceof SfuTooOldForBookingsError;

export const fetchPublicScheduledMeeting = async (
  scheduledMeetingsBase: string,
  sfuSecret: string,
  clientId: string,
  roomCode: string,
  signal?: AbortSignal,
): Promise<PublicScheduledMeeting | null> => {
  const url = `${scheduledMeetingsBase}/public/v2/by-room/${encodeURIComponent(roomCode)}?clientId=${encodeURIComponent(clientId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-sfu-secret": sfuSecret, accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (response.status === 404) throw new SfuTooOldForBookingsError();
  if (!response.ok) throw new Error(`Scheduled meeting lookup failed (${response.status})`);
  const data: unknown = await response.json();
  if (data === null || typeof data !== "object" || !("scheduledMeeting" in data)) {
    throw new Error("Invalid scheduled meeting lookup response");
  }
  const meeting = data.scheduledMeeting;
  if (meeting === null) return null;
  if (!meeting || typeof meeting !== "object" || !("clientId" in meeting) || typeof meeting.clientId !== "string" ||
      !("id" in meeting) || typeof meeting.id !== "string") {
    throw new Error("Invalid scheduled meeting lookup response");
  }
  return meeting.clientId === clientId ? meeting as PublicScheduledMeeting : null;
};

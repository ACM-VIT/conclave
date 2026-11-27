export interface PublicScheduledMeeting {
  id: string;
  clientId?: string;
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
  const data = (await response.json()) as { scheduledMeeting?: PublicScheduledMeeting | null };
  return data?.scheduledMeeting?.clientId === clientId ? data.scheduledMeeting : null;
};

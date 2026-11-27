import {
  buildScheduledWebinarHeaders,
  type SfuAuthenticatedUser,
} from "@/lib/sfu-user-auth";
import { resolveSfuSecret, resolveSfuUrl } from "@/lib/sfu-admin-auth";
import { readResponseError } from "@/app/lib/utils";
import {
  fetchPublicScheduledMeeting,
  isSfuTooOldForBookings,
  type PublicScheduledMeeting,
} from "@/lib/scheduled-meeting-lookup";
import type { RoomDestination } from "@/lib/meeting-links";

export type { PublicScheduledMeeting };

export const resolveScheduledMeetingsBase = (): string => {
  const base = resolveSfuUrl().replace(/\/$/, "");
  return `${base}/scheduled-meetings`;
};

export const buildScheduledMeetingHeaders = (
  user: SfuAuthenticatedUser,
  request: Request,
): Headers => buildScheduledWebinarHeaders(user, request);

export const readScheduledMeetingError = (
  response: Response,
): Promise<string> => readResponseError(response);

export const lookupPublicScheduledMeetingByRoomCode = async (
  { clientId, roomCode }: RoomDestination,
): Promise<PublicScheduledMeeting | null> => {
  try {
    const meeting = await fetchPublicScheduledMeeting(
      resolveScheduledMeetingsBase(),
      resolveSfuSecret(),
      clientId,
      roomCode,
    );
    return meeting?.clientId === clientId ? meeting : null;
  } catch (error) {
    if (isSfuTooOldForBookings(error)) throw error;
    return null;
  }
};

export const lookupScheduledMeetingHostEmail = async (
  { clientId, roomCode }: RoomDestination,
): Promise<string | null> => {
  try {
    const base = resolveScheduledMeetingsBase();
    const url = `${base}/by-room/${encodeURIComponent(roomCode)}?clientId=${encodeURIComponent(clientId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-sfu-secret": resolveSfuSecret(),
        accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      scheduledMeeting?: { hostEmail?: string };
    };
    const email = data?.scheduledMeeting?.hostEmail?.trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
};

export const isMeetingJoinable = (
  meeting: PublicScheduledMeeting,
  now: number = Date.now(),
): boolean => {
  if (meeting.status === "cancelled") return false;
  if (meeting.status === "ended") return true;
  if (meeting.startedAt !== null) return true;
  return now >= meeting.scheduledStartAt;
};

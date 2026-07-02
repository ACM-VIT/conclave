import {
  buildScheduledWebinarHeaders,
  type SfuAuthenticatedUser,
} from "@/lib/sfu-user-auth";
import { resolveSfuSecret, resolveSfuUrl } from "@/lib/sfu-admin-auth";
import { readResponseError } from "@/app/lib/utils";
import {
  canonicalizeSfuClientId,
  CONCLAVE_SFU_CLIENT_ID,
} from "@/lib/sfu-client-id";

export type ScheduledMeetingStatus =
  | "scheduled"
  | "live"
  | "ended"
  | "cancelled";

export type ScheduledMeetingEmailNotificationStatus =
  | "not_configured"
  | "pending"
  | "sent"
  | "failed";

export interface ScheduledMeeting {
  id: string;
  clientId: string;
  roomCode: string;
  title: string;
  hostEmail: string;
  hostName: string;
  hostUserId: string | null;
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: ScheduledMeetingStatus;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  emailNotificationStatus?: ScheduledMeetingEmailNotificationStatus;
  emailNotificationError?: string | null;
  emailNotificationSentAt?: number | null;
  emailReminderStatus?: ScheduledMeetingEmailNotificationStatus;
  emailReminderError?: string | null;
  emailReminderSentAt?: number | null;
}

export interface CreateScheduledMeetingPayload {
  title: string;
  scheduledStartAt: number;
  scheduledEndAt?: number;
  roomCode?: string;
  hostEmail?: string;
  hostName?: string;
}

export interface PublicScheduledMeeting {
  id: string;
  roomCode: string;
  title: string;
  hostName: string;
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: ScheduledMeetingStatus;
  startedAt: number | null;
  endedAt: number | null;
}

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
  clientId: string,
  roomCode: string,
): Promise<PublicScheduledMeeting | null> => {
  try {
    const resolvedClientId =
      canonicalizeSfuClientId(clientId) || CONCLAVE_SFU_CLIENT_ID;
    const base = resolveScheduledMeetingsBase();
    const url = `${base}/public/by-room/${encodeURIComponent(roomCode)}?clientId=${encodeURIComponent(resolvedClientId)}`;
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
      scheduledMeeting?: PublicScheduledMeeting;
    };
    return data?.scheduledMeeting ?? null;
  } catch {
    return null;
  }
};

export const lookupScheduledMeetingHostEmail = async (
  clientId: string,
  roomCode: string,
): Promise<string | null> => {
  try {
    const resolvedClientId =
      canonicalizeSfuClientId(clientId) || CONCLAVE_SFU_CLIENT_ID;
    const base = resolveScheduledMeetingsBase();
    const url = `${base}/by-room/${encodeURIComponent(roomCode)}?clientId=${encodeURIComponent(resolvedClientId)}`;
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

import {
  buildScheduledWebinarHeaders,
  type SfuAuthenticatedUser,
} from "@/lib/sfu-user-auth";
import { resolveSfuSecret, resolveSfuUrl } from "@/lib/sfu-admin-auth";
import { resolveSfuUrls } from "@/lib/sfu-url";
import { readResponseError } from "@/app/lib/utils";
import {
  canonicalizeSfuClientId,
  CONCLAVE_SFU_CLIENT_ID,
  resolveSfuClientIdCandidates,
} from "@/lib/sfu-client-id";

export interface PublicScheduledMeeting {
  id: string;
  roomCode: string;
  title: string;
  hostName: string;
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: "scheduled" | "live" | "ended" | "cancelled";
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

export type ScheduledMeetingLookup =
  | { kind: "scheduled"; clientId: string; meeting: PublicScheduledMeeting }
  | { kind: "unscheduled" }
  // The SFU could not say. The code may well be a real meeting.
  | { kind: "unknown" };

// The link page waits for this lookup before it renders, so all of it shares
// one short deadline. An SFU that has not answered by then counts as failed.
const LOOKUP_DEADLINE_MS = 2500;

// `null` is the SFU saying no meeting is scheduled at this code. A failed
// lookup throws, so it is never read as that answer.
const fetchPublicScheduledMeeting = async (
  sfuUrl: string,
  clientId: string,
  roomCode: string,
  signal: AbortSignal,
): Promise<PublicScheduledMeeting | null> => {
  const base = `${sfuUrl.replace(/\/$/, "")}/scheduled-meetings`;
  const url = `${base}/public/by-room/${encodeURIComponent(roomCode)}?clientId=${encodeURIComponent(clientId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-sfu-secret": resolveSfuSecret(),
      accept: "application/json",
    },
    cache: "no-store",
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Scheduled meeting lookup failed (${response.status})`);
  }
  const data = (await response.json()) as {
    scheduledMeeting?: PublicScheduledMeeting;
  };
  return data?.scheduledMeeting ?? null;
};

// Asks every SFU, for every client the code could belong to, at once. The
// code is unscheduled only when all of them said so.
export const lookupScheduledMeetingForCode = async (
  roomCode: string,
  preferredClientId?: string,
): Promise<ScheduledMeetingLookup> => {
  const deadline = AbortSignal.timeout(LOOKUP_DEADLINE_MS);
  const sfuUrls = resolveSfuUrls();
  const answers = await Promise.all(
    resolveSfuClientIdCandidates(preferredClientId).map(async (clientId) => ({
      clientId,
      results: await Promise.allSettled(
        sfuUrls.map((sfuUrl) =>
          fetchPublicScheduledMeeting(sfuUrl, clientId, roomCode, deadline),
        ),
      ),
    })),
  );
  for (const { clientId, results } of answers) {
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        return { kind: "scheduled", clientId, meeting: result.value };
      }
    }
  }
  const failed = answers.some(({ results }) =>
    results.some((result) => result.status === "rejected"),
  );
  return failed ? { kind: "unknown" } : { kind: "unscheduled" };
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

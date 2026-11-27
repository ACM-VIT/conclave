import {
  buildScheduledWebinarHeaders,
  type SfuAuthenticatedUser,
} from "@/lib/sfu-user-auth";
import { resolveSfuSecret, resolveSfuUrl } from "@/lib/sfu-admin-auth";
import { resolveSfuUrls } from "@/lib/sfu-url";
import { readResponseError } from "@/app/lib/utils";
import {
  fetchPublicScheduledMeeting,
  isSfuTooOldForBookings,
  type PublicScheduledMeeting,
} from "./scheduled-meeting-lookup";
import type { RoomDestination } from "@/lib/meeting-links";
import { CONCLAVE_SFU_CLIENT_ID, resolveServerSfuClientId } from "./sfu-client-id";

export type { PublicScheduledMeeting };

const scheduledMeetingsBase = (sfuUrl: string): string =>
  `${sfuUrl.replace(/\/$/, "")}/scheduled-meetings`;

export const resolveScheduledMeetingsBase = (): string =>
  scheduledMeetingsBase(resolveSfuUrl());

export const buildScheduledMeetingHeaders = (
  user: SfuAuthenticatedUser,
  request: Request,
): Headers => buildScheduledWebinarHeaders(user, request);

export const readScheduledMeetingError = (
  response: Response,
): Promise<string> => readResponseError(response);

// A scheduled meeting lives on the SFU that answered for it, which is not
// always the first one configured.
export type FoundScheduledMeeting = {
  kind: "scheduled";
  sfuUrl: string;
  clientId: string;
  meeting: PublicScheduledMeeting;
};

export type ScheduledMeetingLookup =
  | FoundScheduledMeeting
  | { kind: "unscheduled" }
  // The SFU could not say. The code may well be a real meeting.
  | { kind: "unknown" };

// The link page waits for these lookups before it renders, so each has a
// short deadline. An SFU that has not answered by then counts as failed.
const LOOKUP_DEADLINE_MS = 2500;

const lookupInTenant = async (
  { roomCode, clientId }: RoomDestination,
  deadline: AbortSignal,
): Promise<ScheduledMeetingLookup> => {
  const sfuUrls = resolveSfuUrls();
  const results = await Promise.allSettled(
    sfuUrls.map((sfuUrl) =>
      fetchPublicScheduledMeeting(scheduledMeetingsBase(sfuUrl), resolveSfuSecret(), clientId, roomCode, deadline),
    ),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled" && result.value) {
      return {
        kind: "scheduled",
        sfuUrl: sfuUrls[index],
        clientId,
        meeting: result.value,
      };
    }
  }
  const [first] = results;
  if (
    first?.status === "rejected" &&
    results.every((result) => result.status === "rejected" && isSfuTooOldForBookings(result.reason))
  ) {
    throw first.reason;
  }
  return results.some((result) => result.status === "rejected")
    ? { kind: "unknown" }
    : { kind: "unscheduled" };
};

const noActiveRoom = async ({ roomCode, clientId }: RoomDestination, signal: AbortSignal): Promise<boolean> => {
  const room = encodeURIComponent(roomCode);
  const tenant = encodeURIComponent(clientId);
  const init = {
    headers: { "x-sfu-secret": resolveSfuSecret(), accept: "application/json" },
    cache: "no-store",
    signal,
  } satisfies RequestInit;
  const absentAt = async (url: string, field: "owner" | "room"): Promise<boolean> => {
    const response = await fetch(url, init);
    if (!response.ok) return false;
    const body = (await response.json()) as Partial<Record<typeof field, unknown>> | null;
    return body?.[field] === null;
  };
  // A live room can outlast its registry lease while Redis is down.
  const results = await Promise.allSettled(resolveSfuUrls().flatMap((sfuUrl) => {
    const base = sfuUrl.replace(/\/$/, "");
    return [
      absentAt(`${base}/routing/rooms/${tenant}/${room}`, "owner"),
      absentAt(`${base}/rooms/${room}?clientId=${tenant}`, "room"),
    ];
  }));
  return results.length > 0 && results.every((result) => result.status === "fulfilled" && result.value);
};

export const lookupScheduledMeetingForCode = async (
  destination: RoomDestination,
  { allowLegacyBooking = false }: { allowLegacyBooking?: boolean } = {},
): Promise<ScheduledMeetingLookup> => {
  const deadline = AbortSignal.timeout(LOOKUP_DEADLINE_MS);
  const primary = await lookupInTenant(destination, deadline);
  if (!allowLegacyBooking || primary.kind !== "unscheduled" ||
      destination.clientId !== resolveServerSfuClientId() || destination.clientId === CONCLAVE_SFU_CLIENT_ID) {
    return primary;
  }
  const legacy = await lookupInTenant({ ...destination, clientId: CONCLAVE_SFU_CLIENT_ID }, deadline);
  return legacy.kind === "scheduled" && legacy.meeting.bookingLink === true &&
    await noActiveRoom(destination, deadline) ? legacy : primary;
};

export const lookupScheduledMeetingHostEmail = async ({
  sfuUrl,
  clientId,
  meeting,
}: FoundScheduledMeeting): Promise<string | null> => {
  try {
    const url = `${scheduledMeetingsBase(sfuUrl)}/by-room/${encodeURIComponent(meeting.roomCode)}?clientId=${encodeURIComponent(clientId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-sfu-secret": resolveSfuSecret(),
        accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(LOOKUP_DEADLINE_MS),
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

// A person is waiting on these, so no SFU may hold one up.
const REQUEST_DEADLINE_MS = 4000;

// One SFU's whole answer, headers and body, or a throw if it did not finish
// in time. Reading the body here keeps a reply that stalls halfway from
// passing as an answer.
const fetchWholeReply = async (
  url: string,
  init: RequestInit,
  deadlineMs: number,
): Promise<Response> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(deadlineMs),
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type");
  return new Response(body || null, {
    status: response.status,
    headers: contentType ? { "content-type": contentType } : undefined,
  });
};

// Sends a request about one scheduled meeting to the SFU that has it: each
// in turn until one knows the meeting. Only that SFU acts on it. An SFU that
// stalls, errors or answers 5xx is passed over for the next.
export const fetchFromScheduledMeetingSfu = async (
  path: string,
  init: RequestInit,
  deadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<Response> => {
  let notFound: Response | null = null;
  let unreachable: Error | null = null;
  for (const sfuUrl of resolveSfuUrls()) {
    try {
      const response = await fetchWholeReply(
        `${scheduledMeetingsBase(sfuUrl)}${path}`,
        init,
        deadlineMs,
      );
      if (response.status >= 500) {
        throw new Error(`Answered ${response.status}`);
      }
      if (response.status !== 404) return response;
      notFound = response;
    } catch (error) {
      unreachable = new Error(`Could not reach ${sfuUrl}`, { cause: error });
    }
  }
  if (unreachable || !notFound) {
    throw unreachable ?? new Error("No SFU is configured");
  }
  return notFound;
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

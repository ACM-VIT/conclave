import { Suspense } from "react";
import { headers as nextHeaders } from "next/headers";
import MeetsClientShell from "../meets-client-shell";
import RouteLoadingState from "../components/RouteLoadingState";
import { sanitizeRoomCode, sanitizeWebinarLinkCode } from "../lib/utils";
import ScheduledMeetingLanding from "../components/ScheduledMeetingLanding";
import ErrorStateView from "../components/ErrorStateView";
import { isSfuTooOldForBookings } from "@/lib/scheduled-meeting-lookup";
import {
  isMeetingJoinable,
  lookupPublicScheduledMeetingByRoomCode,
  lookupScheduledMeetingHostEmail,
  type PublicScheduledMeeting,
} from "@/lib/scheduled-meetings";
import { auth } from "@/lib/auth";
import { findScheduledMeetingForLink } from "@/lib/sfu-client-id";

type MeetRoomPageProps = {
  params: Promise<{ code: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const getParamValue = (
  value: string | string[] | undefined,
): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const isTruthyParam = (value: string | string[] | undefined): boolean => {
  if (Array.isArray(value)) {
    value = value[0];
  }
  if (value === undefined) return false;
  if (value.trim() === "") return true;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
};

const sanitizeClientId = (
  value: string | string[] | undefined,
): string | undefined => {
  const candidate = getParamValue(value)?.trim();
  if (!candidate) return undefined;
  return /^[a-zA-Z0-9._:-]{1,64}$/.test(candidate) ? candidate : undefined;
};

const resolveSessionEmail = async (): Promise<string | null> => {
  try {
    const headers = await nextHeaders();
    const session = await auth.api.getSession({ headers }).catch(() => null);
    const email = session?.user?.email?.trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
};

const lookupScheduledMeetingCandidate = (
  roomCode: string,
  linkedClientId?: string,
): Promise<{ clientId: string; meeting: PublicScheduledMeeting } | null> =>
  findScheduledMeetingForLink(linkedClientId, (clientId) =>
    lookupPublicScheduledMeetingByRoomCode(clientId, roomCode),
  );

export default function MeetRoomPage({
  params,
  searchParams,
}: MeetRoomPageProps) {
  return (
    <Suspense
      fallback={
        <RouteLoadingState
          title="Joining room"
        />
      }
    >
      <MeetRoomContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function MeetRoomContent({ params, searchParams }: MeetRoomPageProps) {
  const { code } = await params;
  const resolvedSearchParams = (await (searchParams ?? Promise.resolve(
    {} as Record<string, string | string[] | undefined>,
  )));
  const rawCode = typeof code === "string" ? code : "";
  const roomCode = decodeURIComponent(rawCode);
  const resolvedRoomCode =
    roomCode === "undefined" || roomCode === "null" ? "" : roomCode;
  const bypassMediaPermissions = isTruthyParam(resolvedSearchParams.recorder);
  const devOverridesEnabled = process.env.NODE_ENV === "development";
  const safeBotOverridesEnabled =
    devOverridesEnabled || bypassMediaPermissions;
  const autoJoinOnMount =
    safeBotOverridesEnabled && isTruthyParam(resolvedSearchParams.autojoin);
  const hideJoinUI =
    safeBotOverridesEnabled && isTruthyParam(resolvedSearchParams.hide);
  const joinModeParam = safeBotOverridesEnabled
    ? getParamValue(resolvedSearchParams.mode)
    : undefined;
  const joinMode =
    joinModeParam === "webinar_attendee" ? "webinar_attendee" : undefined;
  const sanitizedRoomCode =
    joinMode === "webinar_attendee"
      ? sanitizeWebinarLinkCode(resolvedRoomCode)
      : sanitizeRoomCode(resolvedRoomCode);
  const displayName = safeBotOverridesEnabled
    ? getParamValue(resolvedSearchParams.name)
    : undefined;
  const sfuClientId = sanitizeClientId(resolvedSearchParams.clientId);
  let resolvedSfuClientId = sfuClientId;
  const user = displayName ? { name: displayName } : undefined;
  const isAdmin =
    devOverridesEnabled && isTruthyParam(resolvedSearchParams.admin);

  if (sanitizedRoomCode && !bypassMediaPermissions) {
    let scheduledCandidate: Awaited<ReturnType<typeof lookupScheduledMeetingCandidate>>;
    try {
      scheduledCandidate = await lookupScheduledMeetingCandidate(
        sanitizedRoomCode,
        sfuClientId,
      );
    } catch (error) {
      if (!isSfuTooOldForBookings(error)) throw error;
      return (
        <ErrorStateView
          eyebrow="Meetings are updating"
          title="This meeting link can't open yet"
          message="The meeting service is being updated. Try this link again in a few minutes."
          homeLabel="Go home"
        />
      );
    }
    const scheduled = scheduledCandidate?.meeting ?? null;
    if (scheduledCandidate) {
      resolvedSfuClientId = scheduledCandidate.clientId;
    }
    if (scheduledCandidate && scheduled && !isMeetingJoinable(scheduled)) {
      const scheduledClientId = scheduledCandidate.clientId;
      const [sessionEmail, hostEmail] = await Promise.all([
        resolveSessionEmail(),
        lookupScheduledMeetingHostEmail(
          scheduledClientId,
          sanitizedRoomCode,
        ),
      ]);
      const viewerIsHost = Boolean(
        sessionEmail && hostEmail && sessionEmail === hostEmail,
      );
      return (
        <ScheduledMeetingLanding
          meeting={scheduled}
          clientId={scheduledClientId}
          viewerIsHost={viewerIsHost}
        />
      );
    }
  }

  return (
    <MeetsClientShell
      initialRoomId={sanitizedRoomCode}
      forceJoinOnly={true}
      bypassMediaPermissions={bypassMediaPermissions}
      sfuClientId={resolvedSfuClientId}
      autoJoinOnMount={autoJoinOnMount}
      hideJoinUI={hideJoinUI}
      joinMode={joinMode}
      user={user}
      isAdmin={isAdmin}
    />
  );
}

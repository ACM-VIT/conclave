import { Suspense } from "react";
import { headers as nextHeaders } from "next/headers";
import MeetsClientShell from "../meets-client-shell";
import RouteLoadingState from "../components/RouteLoadingState";
import ScheduledMeetingLanding from "../components/ScheduledMeetingLanding";
import {
  isMeetingJoinable,
  lookupScheduledMeetingForCode,
  lookupScheduledMeetingHostEmail,
} from "@/lib/scheduled-meetings";
import { auth } from "@/lib/auth";
import { resolveMeetingClientId } from "@/lib/sfu-client-id";
import { roomIdFromMeetingPath, webinarSlugFromPath, type RoomDestination } from "@/lib/meeting-links";

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
  const destination: RoomDestination = {
    roomCode: joinMode === "webinar_attendee" ? webinarSlugFromPath(roomCode) : roomIdFromMeetingPath(roomCode),
    clientId: resolveMeetingClientId(getParamValue(resolvedSearchParams.clientId)),
  };
  const displayName = safeBotOverridesEnabled
    ? getParamValue(resolvedSearchParams.name)
    : undefined;
  let mayOpenRoom = false;
  let joinClientId = destination.clientId;
  const user = displayName ? { name: displayName } : undefined;
  const isAdmin =
    devOverridesEnabled && isTruthyParam(resolvedSearchParams.admin);

  if (destination.roomCode) {
    const lookup = await lookupScheduledMeetingForCode(destination, {
      allowLegacyBooking: resolvedSearchParams.clientId === undefined && joinMode !== "webinar_attendee",
    });
    mayOpenRoom = lookup.kind !== "unscheduled";
    if (lookup.kind === "scheduled") joinClientId = lookup.clientId;
    // Recorders go straight to the join.
    if (
      lookup.kind === "scheduled" &&
      !bypassMediaPermissions &&
      !isMeetingJoinable(lookup.meeting)
    ) {
      const [sessionEmail, hostEmail] = await Promise.all([
        resolveSessionEmail(),
        lookupScheduledMeetingHostEmail(lookup),
      ]);
      const viewerIsHost = Boolean(
        sessionEmail && hostEmail && sessionEmail === hostEmail,
      );
      return (
        <ScheduledMeetingLanding
          meeting={lookup.meeting}
          clientId={lookup.clientId}
          viewerIsHost={viewerIsHost}
        />
      );
    }
  }

  return (
    <MeetsClientShell
      initialRoomId={destination.roomCode}
      forceJoinOnly={true}
      allowRoomCreation={mayOpenRoom}
      bypassMediaPermissions={bypassMediaPermissions}
      sfuClientId={joinClientId}
      autoJoinOnMount={autoJoinOnMount}
      hideJoinUI={hideJoinUI}
      joinMode={joinMode}
      user={user}
      isAdmin={isAdmin}
    />
  );
}

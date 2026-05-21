import { use } from "react";
import MeetsClientShell from "../meets-client-shell";
import { sanitizeRoomCode, sanitizeWebinarLinkCode } from "../lib/utils";

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

export default function MeetRoomPage({ params, searchParams }: MeetRoomPageProps) {
  const { code } = use(params);
  const resolvedSearchParams = use(searchParams ?? Promise.resolve({})) as Record<
    string,
    string | string[] | undefined
  >;
  const rawCode = typeof code === "string" ? code : "";
  const roomCode = decodeURIComponent(rawCode);
  const resolvedRoomCode =
    roomCode === "undefined" || roomCode === "null" ? "" : roomCode;
  const bypassMediaPermissions = isTruthyParam(
    resolvedSearchParams.recorder
  );
  // `broadcast=1` (only honored alongside recorder=1, i.e. the headless
  // bot path) hides every UI chrome element so the rendered tab is
  // publishable as-is.
  const broadcastMode =
    bypassMediaPermissions && isTruthyParam(resolvedSearchParams.broadcast);
  const devOverridesEnabled = process.env.NODE_ENV === "development";
  const recorderOverridesEnabled = bypassMediaPermissions;
  const safeBotOverridesEnabled =
    devOverridesEnabled || recorderOverridesEnabled;
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
  const user = displayName ? { name: displayName } : undefined;
  const isAdmin =
    devOverridesEnabled && isTruthyParam(resolvedSearchParams.admin);
  return (
    <MeetsClientShell
      initialRoomId={sanitizedRoomCode}
      forceJoinOnly={true}
      bypassMediaPermissions={bypassMediaPermissions}
      broadcastMode={broadcastMode}
      sfuClientId={sfuClientId}
      autoJoinOnMount={autoJoinOnMount}
      hideJoinUI={hideJoinUI}
      joinMode={joinMode}
      user={user}
      isAdmin={isAdmin}
    />
  );
}

import { use } from "react";
import MeetsClientShell from "../meets-client-shell";
import { sanitizeRoomCode } from "../lib/utils";

type MeetRoomPageProps = {
  params: Promise<{ code: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const isTruthyParam = (value: string | string[] | undefined): boolean => {
  if (Array.isArray(value)) {
    value = value[0];
  }
  if (value === undefined) return false;
  if (value.trim() === "") return true;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
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
  const sanitizedRoomCode = sanitizeRoomCode(resolvedRoomCode);
  const bypassMediaPermissions = isTruthyParam(
    resolvedSearchParams.recorder
  );
  return (
    <MeetsClientShell
      initialRoomId={sanitizedRoomCode}
      forceJoinOnly={true}
      bypassMediaPermissions={bypassMediaPermissions}
    />
  );
}

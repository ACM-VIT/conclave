import { APP_ROUTE_SEGMENTS, sanitizeRoomCode } from "@/app/lib/utils";
import { canonicalizeSfuClientId } from "@/lib/sfu-client-id";

type MeetingLinkInput = {
  roomCode: string;
  clientId?: string | null;
};

const APP_ROUTES: ReadonlySet<string> = new Set(APP_ROUTE_SEGMENTS);

export const roomIdFromMeetingPath = (segment: string): string =>
  segment === "undefined" || segment === "null" ? "" : sanitizeRoomCode(segment);

export const buildMeetingPath = (meeting: MeetingLinkInput): string | null => {
  const { roomCode } = meeting;
  if (APP_ROUTES.has(roomCode) || roomIdFromMeetingPath(roomCode) !== roomCode) return null;
  const path = `/${encodeURIComponent(roomCode)}`;
  const clientId = canonicalizeSfuClientId(meeting.clientId);
  return clientId ? `${path}?clientId=${encodeURIComponent(clientId)}` : path;
};

export const buildMeetingUrl = (
  origin: string,
  meeting: MeetingLinkInput,
): string | null => {
  const path = buildMeetingPath(meeting);
  return path === null ? null : `${origin.replace(/\/$/, "")}${path}`;
};

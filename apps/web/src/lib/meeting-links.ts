import { APP_ROUTE_SEGMENTS, sanitizeRoomCode, sanitizeWebinarLinkCode } from "../app/lib/utils";
import { canonicalizeSfuClientId } from "./sfu-client-id";

export type RoomDestination = {
  roomCode: string;
  clientId: string;
};

const APP_ROUTES: ReadonlySet<string> = new Set(APP_ROUTE_SEGMENTS);

export const roomIdFromMeetingPath = (segment: string): string =>
  segment === "undefined" || segment === "null" ? "" : sanitizeRoomCode(segment);

const tenantPath = (path: string, clientId: string): string | null => {
  const tenant = canonicalizeSfuClientId(clientId);
  return tenant ? `${path}?clientId=${encodeURIComponent(tenant)}` : null;
};

export const webinarSlugFromPath = (segment: string): string =>
  segment === "undefined" || segment === "null" ? "" : sanitizeWebinarLinkCode(segment);

export const buildWebinarPath = ({ slug, clientId }: { slug: string; clientId: string }): string | null =>
  slug && webinarSlugFromPath(slug) === slug
    ? tenantPath(`/w/${encodeURIComponent(slug)}`, clientId)
    : null;

export const buildMeetingPath = (meeting: RoomDestination): string | null => {
  const { roomCode } = meeting;
  if (!roomCode || APP_ROUTES.has(roomCode) || roomIdFromMeetingPath(roomCode) !== roomCode) return null;
  return tenantPath(`/${encodeURIComponent(roomCode)}`, meeting.clientId);
};

export const buildMeetingUrl = (
  origin: string,
  meeting: RoomDestination,
): string | null => {
  const path = buildMeetingPath(meeting);
  return path === null ? null : `${origin.replace(/\/$/, "")}${path}`;
};

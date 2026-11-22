import { canonicalizeSfuClientId } from "./sfu-client-id";

type MeetingLinkInput = {
  roomCode: string;
  clientId?: string | null;
};

/**
 * A meeting link always names its tenant: a bare link means the server's
 * default for bookings and the browser's default for rooms, which can differ.
 */
export const buildMeetingPath = (meeting: MeetingLinkInput): string => {
  const path = `/${encodeURIComponent(meeting.roomCode)}`;
  const clientId = canonicalizeSfuClientId(meeting.clientId);
  return clientId ? `${path}?clientId=${encodeURIComponent(clientId)}` : path;
};

export const buildMeetingUrl = (
  origin: string,
  meeting: MeetingLinkInput,
): string => `${origin.replace(/\/$/, "")}${buildMeetingPath(meeting)}`;

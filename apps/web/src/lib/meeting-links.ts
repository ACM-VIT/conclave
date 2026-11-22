import {
  canonicalizeSfuClientId,
  CONCLAVE_SFU_CLIENT_ID,
  resolveBrowserSfuClientId,
} from "./sfu-client-id";

type MeetingLinkInput = {
  roomCode: string;
  clientId?: string | null;
};

export const buildMeetingPath = (meeting: MeetingLinkInput): string => {
  const path = `/${encodeURIComponent(meeting.roomCode)}`;
  const clientId = canonicalizeSfuClientId(meeting.clientId);
  const isDefaultTenant =
    clientId === CONCLAVE_SFU_CLIENT_ID &&
    resolveBrowserSfuClientId() === CONCLAVE_SFU_CLIENT_ID;
  if (!clientId || isDefaultTenant) return path;
  return `${path}?clientId=${encodeURIComponent(clientId)}`;
};

export const buildMeetingUrl = (
  origin: string,
  meeting: MeetingLinkInput,
): string => `${origin.replace(/\/$/, "")}${buildMeetingPath(meeting)}`;

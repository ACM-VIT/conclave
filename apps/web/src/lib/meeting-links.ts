import {
  canonicalizeSfuClientId,
  CONCLAVE_SFU_CLIENT_ID,
} from "@/lib/sfu-client-id";

type MeetingLinkInput = {
  roomCode: string;
  clientId?: string | null;
};

export const buildMeetingPath = (meeting: MeetingLinkInput): string => {
  const path = `/${encodeURIComponent(meeting.roomCode)}`;
  const clientId = canonicalizeSfuClientId(meeting.clientId);
  if (!clientId || clientId === CONCLAVE_SFU_CLIENT_ID) {
    return path;
  }
  return `${path}?clientId=${encodeURIComponent(clientId)}`;
};

export const buildMeetingUrl = (
  origin: string,
  meeting: MeetingLinkInput,
): string => `${origin.replace(/\/$/, "")}${buildMeetingPath(meeting)}`;

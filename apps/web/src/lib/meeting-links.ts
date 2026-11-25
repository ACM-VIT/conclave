import { canonicalizeSfuClientId } from "@/lib/sfu-client-id";

type MeetingLinkInput = {
  roomCode: string;
  clientId?: string | null;
};

export const buildMeetingPath = (meeting: MeetingLinkInput): string => {
  const path = `/${encodeURIComponent(meeting.roomCode)}`;
  const clientId = canonicalizeSfuClientId(meeting.clientId);
  return clientId ? `${path}?clientId=${encodeURIComponent(clientId)}` : path;
};

export const buildMeetingUrl = (
  origin: string,
  meeting: MeetingLinkInput,
): string => `${origin.replace(/\/$/, "")}${buildMeetingPath(meeting)}`;

type MeetingLinkInput = {
  roomCode: string;
  clientId?: string | null;
};

const shouldIncludeClientId = (
  clientId: string | null | undefined,
): clientId is string => {
  const normalized = clientId?.trim();
  return Boolean(normalized && normalized !== "default");
};

export const buildMeetingPath = (meeting: MeetingLinkInput): string => {
  const path = `/${encodeURIComponent(meeting.roomCode)}`;
  if (!shouldIncludeClientId(meeting.clientId)) {
    return path;
  }
  return `${path}?clientId=${encodeURIComponent(meeting.clientId.trim())}`;
};

export const buildMeetingUrl = (
  origin: string,
  meeting: MeetingLinkInput,
): string => `${origin.replace(/\/$/, "")}${buildMeetingPath(meeting)}`;

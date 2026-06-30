import type { ScheduledMeeting } from "../types.js";

type MeetingLinkInput = Pick<ScheduledMeeting, "clientId" | "roomCode">;

export const buildSchedulingMeetingLink = (
  appOrigin: string,
  meeting: MeetingLinkInput,
): string => {
  const url = new URL(
    `/${encodeURIComponent(meeting.roomCode)}`,
    `${appOrigin.replace(/\/$/, "")}/`,
  );
  if (meeting.clientId && meeting.clientId !== "default") {
    url.searchParams.set("clientId", meeting.clientId);
  }
  return url.toString();
};

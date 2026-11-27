import type { ScheduledMeeting } from "../types.js";
import { canonicalizeClientId } from "./clientIds.js";

type MeetingLinkInput = Pick<ScheduledMeeting, "clientId" | "roomCode">;

export const buildSchedulingMeetingLink = (
  appOrigin: string,
  meeting: MeetingLinkInput,
): string => {
  const url = new URL(
    `/${encodeURIComponent(meeting.roomCode)}`,
    `${appOrigin.replace(/\/$/, "")}/`,
  );
  const clientId = canonicalizeClientId(meeting.clientId);
  url.searchParams.set("clientId", clientId);
  return url.toString();
};

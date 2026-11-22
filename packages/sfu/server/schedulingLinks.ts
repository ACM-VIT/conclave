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
  // The web app opens a bare link in its own default tenant, which the SFU
  // cannot know, so a booking link always names the booking's tenant.
  const clientId = canonicalizeClientId(meeting.clientId);
  if (clientId) url.searchParams.set("clientId", clientId);
  return url.toString();
};

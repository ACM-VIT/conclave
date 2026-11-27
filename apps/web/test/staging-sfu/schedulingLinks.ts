import type { ScheduledMeeting } from "../../../../packages/sfu/types.js";
import {
  canonicalizeClientId,
  CONCLAVE_CLIENT_ID,
} from "../../../../packages/sfu/server/clientIds.js";

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
  if (clientId && clientId !== CONCLAVE_CLIENT_ID) {
    url.searchParams.set("clientId", clientId);
  }
  return url.toString();
};

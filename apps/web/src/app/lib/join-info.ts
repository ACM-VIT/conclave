import type { GuestPassFields } from "./guest-pass-session";
import { getJoinedRoom } from "./joined-room";
import { isMeetingCreatedHere } from "./new-meeting";
import type { JoinMode } from "./types";
import { requestJoinInfo as fetchJoinInfo, type JoinInfoAnswer } from "./join-info-request";

export type JoinInfoRequest = {
  roomId: string;
  sessionId: string;
  user?: { id?: string; email?: string | null; name?: string | null };
  isHost: boolean;
  // The code is known to be a real meeting, such as a scheduled one.
  isKnownMeeting: boolean;
  clientId: string;
  joinMode: JoinMode;
  guestFields?: GuestPassFields;
  signal?: AbortSignal;
};

// Asks for an SFU token. Besides a host, a join may open the room when the
// code is a known meeting or this tab was in the meeting before. Any other
// visitor to a code with no room is told to check it.
export const requestJoinInfo = ({
  roomId,
  sessionId,
  user,
  isHost,
  isKnownMeeting,
  clientId,
  joinMode,
  guestFields,
  signal,
}: JoinInfoRequest): Promise<JoinInfoAnswer> =>
  fetchJoinInfo(
    "/api/sfu/join",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sfu-client": clientId,
      },
      body: JSON.stringify({
        roomId,
        sessionId,
        user,
        isHost,
        allowRoomCreation: isKnownMeeting || getJoinedRoom(roomId) !== null,
        createsMeeting: isMeetingCreatedHere(roomId),
        clientId,
        joinMode,
        ...guestFields,
      }),
    },
    { signal },
  );

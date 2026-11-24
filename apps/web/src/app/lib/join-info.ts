import type { GuestPassFields } from "./guest-pass-session";
import { getJoinedRoom } from "./joined-room";
import type { JoinMode } from "./types";
import { readResponseError } from "./utils";

const JOIN_INFO_REQUEST_TIMEOUT_MS = 15000;

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
};

export type JoinInfo = {
  token: string;
  sfuUrl: string;
  iceServers?: RTCIceServer[];
  guestId?: string;
  guestGrant?: string;
};

const fetchWithTimeout = async (init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    JOIN_INFO_REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch("/api/sfu/join", {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Join info request timeout");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

// Asks for an SFU token. Besides a host, a join may open the room when the
// code is a known meeting or this tab was in the meeting before. Any other
// visitor to a code with no room is told to check it.
export const requestJoinInfo = async ({
  roomId,
  sessionId,
  user,
  isHost,
  isKnownMeeting,
  clientId,
  joinMode,
  guestFields,
}: JoinInfoRequest): Promise<JoinInfo> => {
  const response = await fetchWithTimeout({
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
      clientId,
      joinMode,
      ...guestFields,
    }),
  });

  if (!response.ok) {
    const error = new Error(await readResponseError(response)) as Error & {
      responseStatus?: number;
    };
    error.responseStatus = response.status;
    throw error;
  }

  return (await response.json()) as JoinInfo;
};

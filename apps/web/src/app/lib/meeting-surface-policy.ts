import type { ConnectionState } from "./types";

export const shouldRetainMeetingSurface = ({
  connectionState,
  hasEnteredMeetingSurface,
  intentionalDisconnect,
}: {
  connectionState: ConnectionState;
  hasEnteredMeetingSurface: boolean;
  intentionalDisconnect: boolean;
}): boolean => {
  if (intentionalDisconnect) return false;
  if (connectionState === "joined") return true;
  return hasEnteredMeetingSurface && connectionState !== "waiting";
};

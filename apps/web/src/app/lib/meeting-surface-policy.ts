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

export type ReconnectHold = {
  connectionLive: boolean;
  holdingThroughReconnect: boolean;
};

const LIVE_OR_RECOVERING: ReadonlySet<ConnectionState> = new Set([
  "connecting",
  "connected",
  "joining",
  "joined",
  "reconnecting",
]);

export const reconnectHold = ({
  isJoined,
  connectionState,
  authorityRuntime,
}: {
  isJoined: boolean;
  connectionState: ConnectionState;
  authorityRuntime: "unknown" | "unsupported" | "ready";
}): ReconnectHold => {
  const connectionLive = isJoined && LIVE_OR_RECOVERING.has(connectionState);
  return {
    connectionLive,
    holdingThroughReconnect: connectionLive && authorityRuntime === "unknown",
  };
};

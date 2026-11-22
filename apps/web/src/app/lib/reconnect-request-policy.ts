export type ReconnectRequest = {
  immediate?: boolean;
  userInitiated?: boolean;
  /**
   * Ask the join route for a fresh answer on a new socket, even while the
   * socket is still connected, so rebuilt transports get current TURN
   * credentials instead of the ones that just failed.
   */
  refreshIceServers?: boolean;
};

export type InFlightReconnectDecision = {
  markUserRetry: boolean;
  cancelBackoff: boolean;
  announceQueuedRetry: boolean;
};

export const resolveInFlightReconnectRequest = (
  request: ReconnectRequest | undefined,
  context: { isWaitingForBackoff: boolean; canCancelBackoff: boolean },
): InFlightReconnectDecision => {
  if (request?.userInitiated !== true) {
    return {
      markUserRetry: false,
      cancelBackoff: false,
      announceQueuedRetry: false,
    };
  }
  const cancelBackoff =
    request.immediate === true &&
    context.isWaitingForBackoff &&
    context.canCancelBackoff;
  return {
    markUserRetry: true,
    cancelBackoff,
    announceQueuedRetry: !cancelBackoff,
  };
};

export const resolveReconnectStartAttempts = (
  previousAttempts: number,
  maxAttempts: number,
): number => (previousAttempts >= maxAttempts ? 0 : previousAttempts);

export type ReconnectFailureKind =
  /** The server could not be reached. Retry on the normal backoff. */
  | "transient"
  /**
   * The server answered, but the room or its registry is not there right
   * now. A restarted server has no room until its host is back, and a registry
   * outage clears up on its own, so this is worth waiting out for a while.
   */
  | "room-unavailable"
  /** The server answered, but it is draining and will not take the room. */
  | "server-draining"
  /**
   * The room now needs an invite code, or turned down the one given. Only
   * the user can supply it, so stop and ask instead of retrying.
   */
  | "invite-code-required"
  | "final";

export const ROOM_UNAVAILABLE_RETRY_WINDOW_MS = 60_000;
const ROOM_UNAVAILABLE_RETRY_FIRST_DELAY_MS = 1_000;
const ROOM_UNAVAILABLE_RETRY_MAX_DELAY_MS = 4_000;

export const classifyReconnectFailure = ({
  message,
  responseStatus,
}: {
  message: string;
  responseStatus: number | null;
}): ReconnectFailureKind => {
  if (responseStatus !== null) {
    return responseStatus >= 500 && responseStatus < 600 ? "transient" : "final";
  }
  const text = message.trim();
  if (!text) return "transient";
  if (/server is draining/i.test(text)) return "server-draining";
  if (
    /(meeting|webinar) invite code required|invalid (meeting|webinar) invite code/i.test(
      text,
    )
  ) {
    return "invite-code-required";
  }
  if (/no room found|shared room registry unavailable/i.test(text)) {
    return "room-unavailable";
  }
  // A join cut short because its socket dropped is worth another attempt.
  return /timeout|xhr poll|websocket|transport|socket|network|fetch|load failed|connection|join was cancelled/i.test(
    text,
  )
    ? "transient"
    : "final";
};

/**
 * Whether the next attempt can reuse the socket a failed one left open. A
 * refusal of the held answer may not hold for the join route's answer (the
 * room moved, or the user was made host), and a draining server never takes
 * the room, so both make the next attempt ask the join route on a new socket.
 */
export const canReuseSocketAfterFailure = ({
  failureKind,
  usedHeldJoinInfo,
}: {
  failureKind: ReconnectFailureKind;
  usedHeldJoinInfo: boolean;
}): boolean => !usedHeldJoinInfo && failureKind !== "server-draining";

export type RoomUnavailableRetryPlan =
  | { retry: true; delayMs: number }
  | { retry: false };

/**
 * Retries a missing room on a short backoff, and gives up once it has been
 * missing for the whole window.
 */
export const planRoomUnavailableRetry = ({
  unavailableSince,
  now,
  retries,
}: {
  unavailableSince: number;
  now: number;
  retries: number;
}): RoomUnavailableRetryPlan =>
  now - unavailableSince >= ROOM_UNAVAILABLE_RETRY_WINDOW_MS
    ? { retry: false }
    : {
        retry: true,
        delayMs: Math.min(
          ROOM_UNAVAILABLE_RETRY_FIRST_DELAY_MS * 2 ** retries,
          ROOM_UNAVAILABLE_RETRY_MAX_DELAY_MS,
        ),
      };

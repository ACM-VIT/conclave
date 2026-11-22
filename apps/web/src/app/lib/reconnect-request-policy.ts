export type ReconnectRequest = {
  immediate?: boolean;
  userInitiated?: boolean;
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
  if (
    /no room found|shared room registry unavailable|server is draining/i.test(
      text,
    )
  ) {
    return "room-unavailable";
  }
  return /timeout|xhr poll|websocket|transport|socket|network|fetch|load failed|connection/i.test(
    text,
  )
    ? "transient"
    : "final";
};

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

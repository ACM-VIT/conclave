/**
 * Decisions for requests to reconnect a meeting that dropped.
 *
 * Many things ask to reconnect: socket disconnects, transport failures, the
 * tab regaining focus, the browser coming back online, and the user pressing
 * Retry. Only the last one is a user retry. Background nudges must never
 * reset the attempt cap or skip the backoff, or alt-tabbing while offline
 * turns the bounded retry loop into an unbounded one with no delay.
 */

export type ReconnectRequest = {
  /** Skip the backoff wait before the next attempt. */
  immediate?: boolean;
  /** The user pressed Retry; resets the attempt cap. */
  userInitiated?: boolean;
};

export type InFlightReconnectDecision = {
  /** Ask the running loop to restart its attempt count. */
  markUserRetry: boolean;
  /** Cut the current backoff wait short. */
  cancelBackoff: boolean;
  /** Tell the user their retry will run once the current step finishes. */
  announceQueuedRetry: boolean;
};

/**
 * What a reconnect request does while a reconnect loop is already running.
 * Background nudges are ignored; the running loop owns recovery.
 */
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

/**
 * The attempt count a fresh reconnect loop starts from. A loop that already
 * gave up leaves the count at the cap; a later recovery (back online, tab
 * focused) starts a new bounded cycle instead of giving up again at once.
 */
export const resolveReconnectStartAttempts = (
  previousAttempts: number,
  maxAttempts: number,
): number => (previousAttempts >= maxAttempts ? 0 : previousAttempts);

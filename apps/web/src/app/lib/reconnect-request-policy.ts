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

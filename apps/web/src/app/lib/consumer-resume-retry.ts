export type ConsumerResumeRetryState = {
  consumerId: string;
  timeoutId: number | null;
  attempt: number;
};

export const getConsumerResumeEffectiveAttempt = (
  state: ConsumerResumeRetryState | undefined,
  consumerId: string,
  requestedAttempt: number,
): number =>
  state?.consumerId === consumerId
    ? Math.max(requestedAttempt, state.attempt)
    : requestedAttempt;

export const isConsumerResumeSettlementCurrent = (
  activeConsumerId: string | null | undefined,
  state: ConsumerResumeRetryState | undefined,
  settledConsumerId: string,
): boolean =>
  activeConsumerId === settledConsumerId &&
  state?.consumerId === settledConsumerId;

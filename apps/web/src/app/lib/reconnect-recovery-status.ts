import { MAX_RECONNECT_ATTEMPTS } from "./constants";
import { ROOM_UNAVAILABLE_RETRY_WINDOW_MS } from "./reconnect-request-policy";
import type { ReconnectRecoveryStatus } from "./types";

type RunningPhase = Exclude<ReconnectRecoveryStatus["phase"], "failed">;

/**
 * A reconnect that is running. `attempt` is the attempt in progress out of
 * the retry budget, or null for a retry that does not use one up, such as a
 * wait for the room to come back.
 */
export const buildReconnectRecoveryStatus = (
  phase: RunningPhase,
  attempt: number | null,
  message: string,
  lastError: string | null = null,
  retryAt: number | null = null,
): ReconnectRecoveryStatus => ({
  phase,
  attempt,
  maxAttempts: MAX_RECONNECT_ATTEMPTS,
  message,
  lastError,
  retryAt,
  updatedAt: Date.now(),
});

/** A reconnect that has stopped and waits for the user. It shows no count. */
export const buildStoppedRecoveryStatus = (
  message: string,
  lastError: string | null = null,
  { needsInviteCode = false }: { needsInviteCode?: boolean } = {},
): ReconnectRecoveryStatus => ({
  phase: "failed",
  attempt: null,
  maxAttempts: MAX_RECONNECT_ATTEMPTS,
  message,
  lastError,
  retryAt: null,
  updatedAt: Date.now(),
  ...(needsInviteCode ? { needsInviteCode } : {}),
});

/** "Attempt N of M", only while automatic retries are using up the budget. */
export const formatReconnectAttemptLabel = (
  status: ReconnectRecoveryStatus | null,
  { waitingForNetwork }: { waitingForNetwork: boolean },
): string | null =>
  status &&
  !waitingForNetwork &&
  status.phase !== "failed" &&
  status.attempt !== null &&
  status.attempt > 0
    ? `Attempt ${Math.min(status.attempt, status.maxAttempts)} of ${status.maxAttempts}`
    : null;

export const describeReconnectGiveUp = ({
  attempts,
  roomWaitExpired,
}: {
  attempts: number;
  roomWaitExpired: boolean;
}): string =>
  roomWaitExpired
    ? `The meeting was not available for ${Math.round(
        ROOM_UNAVAILABLE_RETRY_WINDOW_MS / 1000,
      )} seconds.`
    : `Could not reconnect after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`;

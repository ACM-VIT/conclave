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

export type RecoveryCardState = {
  isOffline: boolean;
  /** Signaling is back and the call is being restored. */
  isRestoring: boolean;
  /** The refusal's message when the meeting cannot be rejoined at all. */
  terminalMessage: string | null;
  needsInviteCode: boolean;
  status: ReconnectRecoveryStatus | null;
  /** Seconds until the next automatic retry, when one is scheduled. */
  countdownSeconds: number | null;
  canRetry: boolean;
  errorMessage: string | null;
};

export const describeRecoveryCard = ({
  isOffline,
  isRestoring,
  terminalMessage,
  needsInviteCode,
  status,
  countdownSeconds,
  canRetry,
  errorMessage,
}: RecoveryCardState): { title: string; detail: string; lastError: string | null } => {
  const title = isOffline
    ? "Waiting for internet"
    : terminalMessage !== null
      ? "Meeting unavailable"
      : needsInviteCode
        ? "Invite code needed"
        : isRestoring
          ? "Reconnecting"
          : status?.phase === "failed"
            ? "Reconnect failed"
            : canRetry
              ? "Connection interrupted"
              : "Reconnecting";
  const detail = isOffline
    ? "We are keeping the room open and will restore media when your connection returns."
    : isRestoring
      ? "Connection is back. Restoring media, participants, and room state."
      : terminalMessage !== null
        ? terminalMessage
        : status?.retryAt && countdownSeconds !== null
          ? countdownSeconds > 0
            ? `Retrying automatically in ${countdownSeconds}s.`
            : "Retrying reconnect now."
          : status?.message
            ? status.message
            : canRetry
              ? (errorMessage ?? "We could not restore the connection yet.")
              : "Keeping your meeting open while the connection is restored.";
  const lastError = status?.lastError?.trim() || null;
  // A stopped card often already says why in its body; saying it twice adds
  // nothing.
  return {
    title,
    detail,
    lastError: lastError === detail.trim() ? null : lastError,
  };
};

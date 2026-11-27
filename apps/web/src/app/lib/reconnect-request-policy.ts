import { ROOM_LEASE_UNCONFIRMED_ERROR } from "@conclave/meeting-core/host-commands";
import {
  advanceMediaPathRecovery,
  type MediaDirection,
  type MediaPathRecovery,
  type PathEvidence,
} from "./media-path-recovery";

export type ReconnectRequest = {
  immediate?: boolean;
  userInitiated?: boolean;
  /**
   * Ask the join route for current ICE servers before rebuilding, so rebuilt
   * transports get current TURN credentials instead of the ones that failed.
   */
  refreshIceServers?: boolean;
  /**
   * Build the new transports through TURN alone if the credentials fetched
   * for the rebuild have a relay, and the failure that asked for it.
   */
  relayOnly?: { reason: string };
  failedPath?: FailedMediaPath;
};

export type FailedMediaPath = {
  direction: MediaDirection;
  transportId: string;
  generation: number;
  ownsEscalation?: true;
};

/**
 * The one direction to rebuild on its own, or null to rejoin. While
 * signaling is up, a failure in one direction never takes the other down.
 */
export const planMediaRebuildScope = (
  request: ReconnectRequest | undefined,
  { socketConnected }: { socketConnected: boolean },
): FailedMediaPath | null => socketConnected ? (request?.failedPath ?? null) : null;

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

/**
 * What a reconnect run that is ending still owes. A Try again pressed while
 * it ran was queued behind it, and a run can end without the rejoin that Try
 * again means (one direction rebuilt on its own, or no rejoin at all), so the
 * queued Try again runs now unless the user is leaving. It rebuilds
 * everything, so rebuilds held for the rejoin are dropped with it.
 */
export const planReconnectSettlement = ({
  rejoined,
  userRetryQueued,
  leaving,
}: {
  rejoined: boolean;
  userRetryQueued: boolean;
  leaving: boolean;
}): { runUserRetry: boolean; replayDeferredRebuilds: boolean } => {
  const runUserRetry = userRetryQueued && !leaving;
  return {
    runUserRetry,
    replayDeferredRebuilds: rejoined && !leaving && !runUserRetry,
  };
};

export type PathProbe = "carrying" | "sending-nothing" | "not-carrying" | "cancelled";

export type PathProbeResult = { probe: PathProbe; evidence: PathEvidence | null };

export type ScopedRebuildPlan =
  | "rebuild"
  | "keep-proven-path"
  | "keep-quiet-path"
  | "keep-replaced-path"
  | "rejoin-after-cancelled-check";

export const planScopedRebuild = ({
  probe,
  failedPathChanged,
}: {
  probe: PathProbe;
  failedPathChanged: boolean;
}): ScopedRebuildPlan => {
  if (failedPathChanged) return "keep-replaced-path";
  if (probe === "cancelled") return "rejoin-after-cancelled-check";
  if (probe === "carrying") return "keep-proven-path";
  return probe === "sending-nothing" ? "keep-quiet-path" : "rebuild";
};

export type ScopedRebuildOutcome = "rebuilt" | "stale" | "failed";

export const nextStepAfterScopedRebuild = (
  outcome: ScopedRebuildOutcome,
  { socketConnected }: { socketConnected: boolean },
): "settle-recovered" | "settle-unchanged" | "rejoin" => {
  if (outcome === "rebuilt") return "settle-recovered";
  if (outcome === "stale" && socketConnected) return "settle-unchanged";
  return "rejoin";
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
  if (
    /no room found|shared room registry unavailable|still opening/i.test(text) ||
    text === ROOM_LEASE_UNCONFIRMED_ERROR
  ) {
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

export type RoomWait = {
  since: number | null;
  retries: number;
  expired: boolean;
};

export const FRESH_ROOM_WAIT: RoomWait = {
  since: null,
  retries: 0,
  expired: false,
};

export const noteRoomUnavailable = (
  wait: RoomWait,
  now: number,
): { wait: RoomWait; plan: RoomUnavailableRetryPlan } => {
  const since = wait.since ?? now;
  const plan = planRoomUnavailableRetry({
    unavailableSince: since,
    now,
    retries: wait.retries,
  });
  return {
    plan,
    wait: plan.retry
      ? { since, retries: wait.retries + 1, expired: false }
      : { since, retries: wait.retries, expired: true },
  };
};

export type ReconnectAttemptState = {
  roomWait: RoomWait;
  retryingForRoom: boolean;
  skipNextDelay: boolean;
  nextDelayOverrideMs: number | null;
  refreshIceServers: boolean;
  heldJoinInfoTried: boolean;
  mayReuseSocket: boolean;
  lastError: unknown;
  relayOnlyRequest: { reason: string } | null;
};

export const freshReconnectAttemptState = (
  request?: ReconnectRequest,
): ReconnectAttemptState => ({
  roomWait: FRESH_ROOM_WAIT,
  retryingForRoom: false,
  skipNextDelay: request?.immediate === true,
  nextDelayOverrideMs: null,
  refreshIceServers: request?.refreshIceServers === true,
  heldJoinInfoTried: request?.refreshIceServers === true,
  mayReuseSocket: true,
  lastError: null,
  relayOnlyRequest: request?.relayOnly ?? null,
});

export const USER_RETRY_REQUEST = {
  immediate: true,
  userInitiated: true,
  refreshIceServers: true,
} as const satisfies ReconnectRequest;

export type RetryScopedRecovery = {
  attempt: ReconnectAttemptState;
  attempts: number;
  relayOnly: boolean;
  mediaPaths: MediaPathRecovery;
};

export const restartForUserRetry = ({
  mediaPaths,
}: RetryScopedRecovery): RetryScopedRecovery => ({
  attempt: freshReconnectAttemptState(USER_RETRY_REQUEST),
  attempts: 0,
  relayOnly: false,
  mediaPaths: advanceMediaPathRecovery(mediaPaths, { type: "user-retry" }),
});

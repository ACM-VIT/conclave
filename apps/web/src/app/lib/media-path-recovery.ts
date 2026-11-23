/** How long a transport may carry no media before it is treated as stalled. */
export const MEDIA_PATH_STALL_MS = 15_000;
/** How long an ICE restart gets to bring a transport back. */
export const MEDIA_PATH_VERIFY_MS = 10_000;
/** How long media gets to move again after an ICE restart on a silent path. */
export const MEDIA_PATH_FLOW_CHECK_MS = 4_000;

export const NETWORK_BLOCKED_MESSAGE =
  "Your network is blocking audio and video.";

export type MediaPathDirection = "send" | "recv";

type RtpStat = {
  type?: string;
  bytesSent?: number;
  bytesReceived?: number;
};

/** RTP bytes a transport has moved in its direction, from a stats report. */
export const readRtpBytes = (
  stats: Iterable<RtpStat>,
  direction: MediaPathDirection,
): number => {
  let bytes = 0;
  for (const stat of stats) {
    if (direction === "send" && stat.type === "outbound-rtp") {
      bytes += stat.bytesSent ?? 0;
    } else if (direction === "recv" && stat.type === "inbound-rtp") {
      bytes += stat.bytesReceived ?? 0;
    }
  }
  return bytes;
};

export type MediaPathSample = {
  at: number;
  connectionState: string;
  /** A live, unpaused stream should be crossing this transport right now. */
  expectsMedia: boolean;
  rtpBytes: number;
};

export type MediaPathCondition =
  /** Nothing should be flowing, so there is nothing to judge. */
  | "idle"
  | "flowing"
  /** ICE and DTLS are up but no RTP moved since the last sample. */
  | "connected-without-media"
  | "not-connected";

export type MediaPathWatch = {
  troubleSince: number | null;
  lastRtpBytes: number | null;
};

export const INITIAL_MEDIA_PATH_WATCH: MediaPathWatch = {
  troubleSince: null,
  lastRtpBytes: null,
};

const getMediaPathCondition = (
  watch: MediaPathWatch,
  sample: MediaPathSample,
): MediaPathCondition => {
  if (!sample.expectsMedia) return "idle";
  if (sample.connectionState !== "connected") return "not-connected";
  return watch.lastRtpBytes !== null && sample.rtpBytes <= watch.lastRtpBytes
    ? "connected-without-media"
    : "flowing";
};

/**
 * Folds one sample into the watch. `stalledForMs` is how long the transport
 * has been expected to carry media without carrying any.
 */
export const advanceMediaPathWatch = (
  watch: MediaPathWatch,
  sample: MediaPathSample,
): {
  watch: MediaPathWatch;
  condition: MediaPathCondition;
  stalledForMs: number;
  /** RTP bytes grew since the last connected sample: media is really moving. */
  mediaMoved: boolean;
} => {
  const condition = getMediaPathCondition(watch, sample);
  const inTrouble =
    condition === "not-connected" || condition === "connected-without-media";
  const troubleSince = inTrouble ? (watch.troubleSince ?? sample.at) : null;
  return {
    watch: {
      troubleSince,
      lastRtpBytes:
        sample.connectionState === "connected" ? sample.rtpBytes : null,
    },
    condition,
    stalledForMs: troubleSince === null ? 0 : sample.at - troubleSince,
    mediaMoved:
      sample.connectionState === "connected" &&
      watch.lastRtpBytes !== null &&
      sample.rtpBytes > watch.lastRtpBytes,
  };
};

export type MediaPathEscalation =
  /**
   * Rebuild the transports through TURN alone, if the credentials current at
   * rebuild time have a relay.
   */
  | "reconnect-relay-only"
  | "reconnect"
  /**
   * A rejoin is already rebuilding the transports. Hold the rebuild until it
   * settles, because the transport it just built is the one that failed.
   */
  | "wait-for-reconnect"
  /** Rebuilding did not help either: tell the user. */
  | "report-blocked";

/**
 * What to do when an ICE restart could not bring a transport back. One
 * rebuild is tried, asking for TURN alone, because a direct path that half
 * works can keep ICE from settling on the relay. Whether TURN is there is
 * only known once the rebuild has fetched current credentials, so the plan
 * never depends on the credentials held now; see resolveRebuildRelayOnly.
 */
export const planMediaPathEscalation = ({
  hasReconnected,
  relayOnly,
  reconnectInFlight,
}: {
  hasReconnected: boolean;
  relayOnly: boolean;
  reconnectInFlight: boolean;
}): MediaPathEscalation => {
  if (hasReconnected) return "report-blocked";
  if (reconnectInFlight) return "wait-for-reconnect";
  return relayOnly ? "reconnect" : "reconnect-relay-only";
};

/**
 * The ICE policy for transports a rebuild is about to create, decided with
 * the credentials it just fetched: TURN alone when that was asked for and
 * there is a relay to use, otherwise the policy already in use.
 */
export const resolveRebuildRelayOnly = ({
  requested,
  relayOnly,
  hasTurnServers,
}: {
  requested: boolean;
  relayOnly: boolean;
  hasTurnServers: boolean;
}): boolean => (requested && hasTurnServers ? true : relayOnly);

export type MediaDirection = "producer" | "consumer";

/** What a producer sync got back: the server's list, or why there is none. */
export type ProducerListResult<P> =
  | { listed: true; producers: P[] }
  | { listed: false; reason: string };

/** Whether rebuilding one media direction worked, and why not. */
export type DirectionRebuildResult =
  | { rebuilt: true }
  | { rebuilt: false; reason: string };

/**
 * A rebuilt receive path counts only once the producer list arrived over the
 * same live socket and the new transport is still open. Without the list
 * nothing was consumed, so there is no media for the watchdog to check.
 */
export const judgeReceiveRebuild = <P>({
  list,
  socketStillConnected,
  transportOpen,
}: {
  list: ProducerListResult<P>;
  socketStillConnected: boolean;
  transportOpen: boolean;
}): DirectionRebuildResult => {
  if (!list.listed) return { rebuilt: false, reason: list.reason };
  if (!socketStillConnected) {
    return { rebuilt: false, reason: "signaling dropped during the rebuild" };
  }
  if (!transportOpen) {
    return { rebuilt: false, reason: "the new receive transport closed" };
  }
  return { rebuilt: true };
};

/**
 * What a stall on a connected transport calls for. ICE saying connected does
 * not mean media arrives, so it goes through the same escalation as a failed
 * transport, unless every sender this path expects reports that it is not
 * sending: then the silence is at the other end, not on this network.
 */
export const planSilentPathStep = ({
  direction,
  expectedProducerScores,
}: {
  direction: MediaDirection;
  expectedProducerScores: Array<number | null>;
}): "escalate" | "remote-not-sending" =>
  direction === "consumer" &&
  expectedProducerScores.length > 0 &&
  expectedProducerScores.every((score) => score === 0)
    ? "remote-not-sending"
    : "escalate";

export type MediaPathHealthState = "healthy" | "recovering" | "blocked";
export type MediaPathHealth = Record<MediaDirection, MediaPathHealthState>;

export const HEALTHY_MEDIA_PATHS: MediaPathHealth = {
  producer: "healthy",
  consumer: "healthy",
};

/**
 * Everything one direction's recovery knows, kept together so that media
 * seen flowing again resets all of it at once and a later failure always
 * starts the ladder from the first rebuild.
 */
export type DirectionRecovery = {
  health: MediaPathHealthState;
  /**
   * The transport this direction last escalated. Several watchers see the
   * same failure, and it is acted on once until that transport connects
   * again or media flows.
   */
  escalatedTransportId: string | null;
  /** A rebuild was tried since media last flowed, so the next failure is reported. */
  rebuildTried: boolean;
  /** A rebuild asked for while a rejoin was running, run once it settles. */
  deferredRebuild: { transportId: string; reason: string } | null;
};

export type MediaPathRecovery = Record<MediaDirection, DirectionRecovery>;

const FRESH_DIRECTION: DirectionRecovery = {
  health: "healthy",
  escalatedTransportId: null,
  rebuildTried: false,
  deferredRebuild: null,
};

export const INITIAL_MEDIA_PATH_RECOVERY: MediaPathRecovery = {
  producer: FRESH_DIRECTION,
  consumer: FRESH_DIRECTION,
};

const MEDIA_DIRECTIONS = ["producer", "consumer"] as const;

const patchDirection = (
  recovery: MediaPathRecovery,
  direction: MediaDirection,
  changes: Partial<DirectionRecovery>,
): MediaPathRecovery => {
  const current = recovery[direction];
  const keys = Object.keys(changes) as Array<keyof DirectionRecovery>;
  if (keys.every((key) => changes[key] === current[key])) return recovery;
  return { ...recovery, [direction]: { ...current, ...changes } };
};

const restartDirection = (
  recovery: MediaPathRecovery,
  direction: MediaDirection,
): MediaPathRecovery =>
  patchDirection(recovery, direction, FRESH_DIRECTION) === recovery
    ? recovery
    : { ...recovery, [direction]: FRESH_DIRECTION };

/**
 * Trouble starts recovery and keeps a blocked direction blocked. Only media
 * seen flowing makes a direction healthy and clears its recovery: a
 * transport connecting, an unmute or a device change never does. Try again
 * starts the ladder over but keeps the warning until media flows.
 */
export type MediaPathRecoveryEvent =
  | { type: "trouble"; direction: MediaDirection }
  | { type: "transport-connected"; direction: MediaDirection; transportId: string }
  | { type: "media-flowing"; direction: MediaDirection }
  | { type: "user-retry" }
  | { type: "reset" };

export const advanceMediaPathRecovery = (
  recovery: MediaPathRecovery,
  event: MediaPathRecoveryEvent,
): MediaPathRecovery => {
  switch (event.type) {
    case "reset":
      return MEDIA_DIRECTIONS.reduce(restartDirection, recovery);
    case "user-retry":
      return MEDIA_DIRECTIONS.reduce(
        (next, direction) =>
          patchDirection(next, direction, {
            escalatedTransportId: null,
            rebuildTried: false,
            deferredRebuild: null,
          }),
        recovery,
      );
    case "media-flowing":
      return restartDirection(recovery, event.direction);
    case "trouble":
      return patchDirection(recovery, event.direction, {
        health:
          recovery[event.direction].health === "blocked" ? "blocked" : "recovering",
      });
    case "transport-connected": {
      const current = recovery[event.direction];
      return patchDirection(recovery, event.direction, {
        escalatedTransportId:
          current.escalatedTransportId === event.transportId
            ? null
            : current.escalatedTransportId,
        deferredRebuild:
          current.deferredRebuild?.transportId === event.transportId
            ? null
            : current.deferredRebuild,
      });
    }
  }
};

export type MediaPathFailure = {
  direction: MediaDirection;
  transportId: string;
  reason: string;
  relayOnly: boolean;
  reconnectInFlight: boolean;
};

/**
 * The next step for a transport an ICE restart could not bring back, and
 * the recovery it leaves.
 */
export const planMediaPathFailure = (
  recovery: MediaPathRecovery,
  { direction, transportId, reason, ...network }: MediaPathFailure,
): {
  step: MediaPathEscalation | "already-escalated";
  recovery: MediaPathRecovery;
} => {
  const current = recovery[direction];
  if (current.escalatedTransportId === transportId) {
    return { step: "already-escalated", recovery };
  }
  const step = planMediaPathEscalation({
    hasReconnected: current.rebuildTried,
    ...network,
  });
  if (step === "wait-for-reconnect") {
    return {
      step,
      recovery: patchDirection(recovery, direction, {
        deferredRebuild: { transportId, reason },
      }),
    };
  }
  return {
    step,
    recovery: patchDirection(recovery, direction, {
      health:
        step === "report-blocked" || current.health === "blocked"
          ? "blocked"
          : "recovering",
      escalatedTransportId: transportId,
      rebuildTried: true,
      deferredRebuild: null,
    }),
  };
};

/** The rebuilds held for a rejoin that has settled, and the recovery without them. */
export const takeDeferredRebuilds = (
  recovery: MediaPathRecovery,
): {
  deferred: Array<{ direction: MediaDirection; transportId: string; reason: string }>;
  recovery: MediaPathRecovery;
} => ({
  deferred: MEDIA_DIRECTIONS.flatMap((direction) => {
    const held = recovery[direction].deferredRebuild;
    return held ? [{ direction, ...held }] : [];
  }),
  recovery: MEDIA_DIRECTIONS.reduce(
    (next, direction) => patchDirection(next, direction, { deferredRebuild: null }),
    recovery,
  ),
});

export const readMediaPathHealth = (recovery: MediaPathRecovery): MediaPathHealth =>
  recovery.producer.health === "healthy" && recovery.consumer.health === "healthy"
    ? HEALTHY_MEDIA_PATHS
    : { producer: recovery.producer.health, consumer: recovery.consumer.health };

export const blockedMediaDirections = (
  health: MediaPathHealth,
): MediaDirection[] =>
  MEDIA_DIRECTIONS.filter((direction) => health[direction] === "blocked");

export type ConsumedStream = {
  kind: "audio" | "video";
  source: "webcam" | "screen";
  consumerPaused: boolean;
  producerPaused: boolean;
};

export const streamShouldFlow = ({
  kind,
  source,
  consumerPaused,
  producerPaused,
}: ConsumedStream): boolean =>
  !consumerPaused && !producerPaused && (kind === "audio" || source === "webcam");

export const receivePathExpectsMedia = (
  streams: ConsumedStream[],
  connected: boolean,
): boolean => (connected ? streams.some(streamShouldFlow) : streams.length > 0);

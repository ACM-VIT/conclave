import {
  OWN_PACKET_COUNTS_MAX_PRODUCERS,
  ownPacketCountsRequestSchema,
  type OwnPacketCountsRequest,
  SENDER_PACKET_COUNTS_MAX_CONSUMERS,
  senderPacketCountsAnswerSchema,
  senderPacketCountsRequestSchema,
  type SenderPacketCountsAnswer,
  type SenderPacketCountsRequest,
} from "@conclave/meeting-core/sender-packet-counts";

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
  id?: string;
  mid?: string;
  localId?: string;
  bytesSent?: number;
  bytesReceived?: number;
  packetsSent?: number;
  timestamp?: number;
};

export type SentStreamReading = {
  packetsSent: number;
  receiverReportAt: number | null;
};

export type MediaPathReading = {
  direction: MediaPathDirection;
  rtpBytes: number;
  receiverReportAt: number | null;
  sent: Record<string, SentStreamReading>;
};

const finiteTimestamp = (stat: RtpStat): number | null =>
  typeof stat.timestamp === "number" && Number.isFinite(stat.timestamp)
    ? stat.timestamp
    : null;

export const readMediaPath = (
  stats: Iterable<RtpStat>,
  direction: MediaPathDirection,
): MediaPathReading => {
  let rtpBytes = 0;
  let receiverReportAt: number | null = null;
  const midByOutboundId = new Map<string, string>();
  const sent: Record<string, SentStreamReading> = {};
  const reports: RtpStat[] = [];
  for (const stat of stats) {
    if (direction === "send" && stat.type === "outbound-rtp") {
      rtpBytes += stat.bytesSent ?? 0;
      if (typeof stat.mid === "string" && stat.mid.length > 0) {
        if (stat.id) midByOutboundId.set(stat.id, stat.mid);
        const stream = (sent[stat.mid] ??= { packetsSent: 0, receiverReportAt: null });
        stream.packetsSent += stat.packetsSent ?? 0;
      }
    } else if (direction === "recv" && stat.type === "inbound-rtp") {
      rtpBytes += stat.bytesReceived ?? 0;
    } else if (direction === "send" && stat.type === "remote-inbound-rtp") {
      const at = finiteTimestamp(stat);
      if (at === null) continue;
      receiverReportAt = Math.max(receiverReportAt ?? at, at);
      reports.push(stat);
    }
  }
  for (const report of reports) {
    const mid = report.localId ? midByOutboundId.get(report.localId) : undefined;
    const at = finiteTimestamp(report);
    if (!mid || at === null) continue;
    const stream = sent[mid];
    stream.receiverReportAt = Math.max(stream.receiverReportAt ?? at, at);
  }
  return {
    direction,
    rtpBytes,
    receiverReportAt: direction === "send" ? receiverReportAt : null,
    sent: direction === "send" ? sent : {},
  };
};

const SENT_STREAMS = ["mic", "camera", "screen", "screen-audio"] as const;
export type SentStream = (typeof SENT_STREAMS)[number];

export type SendingProducer = {
  stream: SentStream;
  producerId: string;
  mid: string | null;
};

export type ProducerCounters = {
  sent: number | null;
  reportAt: number | null;
  arrived: number | null;
};

export type ProducerDeliveries = Record<string, ProducerCounters>;

export type SendingProducersSample = {
  producers: SendingProducer[];
  sfuCounts: SenderPacketCounts | null;
  sfuReports: boolean;
};

const newerReport = (now: number | null, before: number | null) =>
  now !== null && (before === null || now > before);

export type StreamDelivery = "delivered" | "undelivered" | "quiet" | "unconfirmed";
export type StreamDeliveries = Partial<Record<SentStream, StreamDelivery>>;

export const judgeProducerDelivery = ({
  before,
  after,
  arrivedBefore,
  arrivedAfter,
  sfuReports,
}: {
  before: SentStreamReading | undefined;
  after: SentStreamReading | undefined;
  arrivedBefore: number | undefined;
  arrivedAfter: number | undefined;
  sfuReports: boolean;
}): StreamDelivery => {
  if (sfuReports) {
    if (arrivedBefore === undefined || arrivedAfter === undefined) return "unconfirmed";
    if (arrivedAfter > arrivedBefore) return "delivered";
  }
  if (!before || !after) return "unconfirmed";
  if (!sfuReports && newerReport(after.receiverReportAt, before.receiverReportAt)) {
    return "delivered";
  }
  return after.packetsSent > before.packetsSent ? "undelivered" : "quiet";
};

const NOTHING_JUDGED: { counters: ProducerDeliveries; streams: StreamDeliveries } = {
  counters: {},
  streams: {},
};

export const advanceProducerDeliveries = (
  deliveries: ProducerDeliveries,
  reading: MediaPathReading,
  { producers, sfuCounts, sfuReports }: SendingProducersSample,
): { counters: ProducerDeliveries; streams: StreamDeliveries } => {
  const counters: ProducerDeliveries = {};
  const streams: StreamDeliveries = {};
  for (const { stream, producerId, mid } of producers) {
    const row = mid ? reading.sent[mid] : undefined;
    const known = deliveries[producerId];
    const arrivedNow = sfuCounts?.[producerId];
    if (!known) {
      counters[producerId] = {
        sent: row?.packetsSent ?? null,
        reportAt: row?.receiverReportAt ?? null,
        arrived: arrivedNow ?? null,
      };
      streams[stream] = "unconfirmed";
      continue;
    }
    const verdict = judgeProducerDelivery({
      before:
        known.sent === null
          ? undefined
          : { packetsSent: known.sent, receiverReportAt: known.reportAt },
      after: row,
      arrivedBefore: known.arrived ?? undefined,
      arrivedAfter: arrivedNow,
      sfuReports,
    });
    const startsCounting =
      (known.arrived === null && arrivedNow !== undefined) ||
      (known.sent === null && row !== undefined);
    counters[producerId] =
      verdict === "delivered" || verdict === "undelivered" || startsCounting
        ? {
            sent: row?.packetsSent ?? known.sent,
            reportAt: row?.receiverReportAt ?? known.reportAt,
            arrived: arrivedNow ?? known.arrived,
          }
        : known;
    streams[stream] = verdict;
  }
  return { counters, streams };
};

export type DeliveryWindow = {
  start: MediaPathReading;
  end: MediaPathReading;
  producers: SendingProducer[];
  sfuStart: SenderPacketCounts | null;
  sfuEnd: SenderPacketCounts | null;
  sfuReports: boolean;
};

export const judgeDeliveryWindow = ({
  start,
  end,
  producers,
  sfuStart,
  sfuEnd,
  sfuReports,
}: DeliveryWindow): StreamDeliveries => {
  const streams: StreamDeliveries = {};
  for (const { stream, producerId, mid } of producers) {
    streams[stream] = judgeProducerDelivery({
      before: mid ? start.sent[mid] : undefined,
      after: mid ? end.sent[mid] : undefined,
      arrivedBefore: sfuStart?.[producerId],
      arrivedAfter: sfuEnd?.[producerId],
      sfuReports,
    });
  }
  return streams;
};

export type PathEvidence = {
  reached: boolean;
  streams: StreamDeliveries;
};

const judgedStreams = (streams: StreamDeliveries) =>
  SENT_STREAMS.flatMap((stream) => {
    const delivery = streams[stream];
    return delivery ? [{ stream, delivery }] : [];
  });

const NO_FAILING_STREAMS: readonly SentStream[] = [];

export const failingStreamsAfter = (
  failing: readonly SentStream[],
  streams: StreamDeliveries,
): readonly SentStream[] => {
  const stillFailing = failing.filter((stream) => streams[stream] !== "delivered");
  const newlyFailing = judgedStreams(streams)
    .filter(({ stream, delivery }) => delivery === "undelivered" && !failing.includes(stream))
    .map(({ stream }) => stream);
  if (stillFailing.length === failing.length && newlyFailing.length === 0) return failing;
  const next = [...stillFailing, ...newlyFailing];
  return next.length === 0 ? NO_FAILING_STREAMS : next;
};

export const pathCarriesWhatIsSent = (
  { reached, streams }: PathEvidence,
  knownFailing: readonly SentStream[],
): boolean =>
  reached &&
  judgedStreams(streams).every(
    ({ stream, delivery }) =>
      delivery === "delivered" || (delivery === "quiet" && !knownFailing.includes(stream)),
  );

export const hasCarriedMedia = (reading: MediaPathReading): boolean =>
  reading.rtpBytes > 0 &&
  (reading.direction === "recv" || reading.receiverReportAt !== null);

export const deliveredRtpBytes = (
  previous: MediaPathReading | null,
  current: MediaPathReading,
): number => {
  if (!previous || previous.direction !== current.direction) return 0;
  const moved = current.rtpBytes - previous.rtpBytes;
  if (moved <= 0) return 0;
  if (current.direction === "recv") return moved;
  return current.receiverReportAt !== null &&
    (previous.receiverReportAt === null ||
      current.receiverReportAt > previous.receiverReportAt)
    ? moved
    : 0;
};

export type MediaPathSample = MediaPathReading & {
  at: number;
  connectionState: string;
  /** A live, unpaused stream should be crossing this transport right now. */
  expectsMedia: boolean;
  framesOptional: boolean;
  sending?: SendingProducersSample;
  knownFailing: readonly SentStream[];
};

export type PublishedStream = {
  kind: "audio" | "video";
  source: "webcam" | "screen";
  live: boolean;
  sending: boolean;
};

export const sendPathExpectation = (
  streams: PublishedStream[],
  connected: boolean,
): { expectsMedia: boolean; framesOptional: boolean } => {
  if (!connected) {
    return { expectsMedia: streams.some(({ live }) => live), framesOptional: false };
  }
  const sending = streams.filter((stream) => stream.sending);
  return {
    expectsMedia: sending.length > 0,
    framesOptional:
      sending.length > 0 &&
      sending.every(({ kind, source }) => kind === "video" && source === "screen"),
  };
};

export const mediaReachedFarEnd = (
  previous: MediaPathReading | null,
  current: MediaPathReading,
  framesOptional: boolean,
): boolean => {
  if (deliveredRtpBytes(previous, current) > 0) return true;
  return (
    framesOptional &&
    previous !== null &&
    previous.direction === "send" &&
    current.direction === "send" &&
    current.receiverReportAt !== null &&
    (previous.receiverReportAt === null ||
      current.receiverReportAt > previous.receiverReportAt)
  );
};

export type MediaPathCondition =
  /** Nothing should be flowing, so there is nothing to judge. */
  | "idle"
  | "flowing"
  /** ICE and DTLS are up but no media reached the far end since the last sample. */
  | "connected-without-media"
  | "not-connected";

export type MediaPathWatch = {
  troubleSince: number | null;
  lastReading: MediaPathReading | null;
  deliveries: ProducerDeliveries;
};

export const INITIAL_MEDIA_PATH_WATCH: MediaPathWatch = {
  troubleSince: null,
  lastReading: null,
  deliveries: {},
};

const toReading = ({
  direction,
  rtpBytes,
  receiverReportAt,
  sent,
}: MediaPathSample): MediaPathReading => ({
  direction,
  rtpBytes,
  receiverReportAt,
  sent,
});

/**
 * Folds one sample into the watch. `stalledForMs` is how long the transport
 * has been expected to carry media without any reaching the far end.
 */
export const advanceMediaPathWatch = (
  watch: MediaPathWatch,
  sample: MediaPathSample,
): {
  watch: MediaPathWatch;
  condition: MediaPathCondition;
  stalledForMs: number;
  /** RTP bytes that reached the far end since the last connected sample. */
  deliveredBytes: number;
  mediaMoved: boolean;
  evidence: PathEvidence;
} => {
  const connected = sample.connectionState === "connected";
  const reading = toReading(sample);
  const deliveredBytes = connected
    ? deliveredRtpBytes(watch.lastReading, reading)
    : 0;
  const judged =
    connected && sample.sending
      ? advanceProducerDeliveries(watch.deliveries, reading, sample.sending)
      : NOTHING_JUDGED;
  const evidence: PathEvidence = {
    reached:
      connected && mediaReachedFarEnd(watch.lastReading, reading, sample.framesOptional),
    streams: judged.streams,
  };
  const sendsFailingStream = failingStreamsAfter(sample.knownFailing, judged.streams).some(
    (stream) => judged.streams[stream] !== undefined,
  );
  const reached = evidence.reached && !sendsFailingStream;
  const condition: MediaPathCondition = !sample.expectsMedia
    ? "idle"
    : !connected
      ? "not-connected"
      : watch.lastReading === null || reached
        ? "flowing"
        : "connected-without-media";
  const inTrouble =
    condition === "not-connected" || condition === "connected-without-media";
  const troubleSince = inTrouble ? (watch.troubleSince ?? sample.at) : null;
  return {
    watch: {
      troubleSince,
      lastReading: connected ? reading : null,
      deliveries: judged.counters,
    },
    condition,
    stalledForMs: troubleSince === null ? 0 : sample.at - troubleSince,
    deliveredBytes,
    mediaMoved: reached,
    evidence,
  };
};

export type SenderPacketsReading =
  | { asked: false }
  | { asked: true; sent: SenderPacketCounts | null };

export type MediaExpectation = "expected" | "not-expected" | "unknown";

export const expectationAfterIceRestart = ({
  expectsMedia,
  senderBefore,
  senderAfter,
}: {
  expectsMedia: boolean;
  senderBefore: SenderPacketsReading;
  senderAfter: SenderPacketsReading;
}): MediaExpectation => {
  if (expectsMedia) return "expected";
  if (!senderAfter.asked) return "not-expected";
  if (!senderBefore.asked || senderBefore.sent === null || senderAfter.sent === null) {
    return "unknown";
  }
  return senderSentMore(senderBefore.sent, senderAfter.sent) ? "expected" : "not-expected";
};

export type IceRestartVerdict =
  | "replaced"
  | "media-arrived"
  | "nothing-expected"
  | "not-recovered";

export const judgeIceRestart = ({
  replaced,
  expectation,
  mediaReached,
}: {
  replaced: boolean;
  expectation: MediaExpectation;
  mediaReached: boolean;
}): IceRestartVerdict => {
  if (replaced) return "replaced";
  if (mediaReached) return "media-arrived";
  return expectation === "not-expected" ? "nothing-expected" : "not-recovered";
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
 * Whether TURN alone is wanted once a rebuild starts: asked for now or
 * before. Each transport still takes its policy from the relays it is
 * offered, so wanting TURN alone never leaves a transport without candidates.
 */
export const resolveRebuildRelayOnly = ({
  requested,
  relayOnly,
}: {
  requested: boolean;
  relayOnly: boolean;
}): boolean => requested || relayOnly;

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

export type FailedPath = {
  transportId: string;
  reason: string;
  silentWhileConnected: boolean;
};

export type DirectionRecovery = {
  health: MediaPathHealthState;
  escalation: FailedPath | null;
  rebuildTried: boolean;
  deferredRebuild: FailedPath | null;
  failingStreams: readonly SentStream[];
};

export type MediaPathRecovery = Record<MediaDirection, DirectionRecovery>;

const FRESH_DIRECTION: DirectionRecovery = {
  health: "healthy",
  escalation: null,
  rebuildTried: false,
  deferredRebuild: null,
  failingStreams: NO_FAILING_STREAMS,
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

const mergeFailedPath = (held: FailedPath, reported: FailedPath): FailedPath =>
  held.silentWhileConnected || !reported.silentWhileConnected
    ? held
    : { ...held, silentWhileConnected: true };

export type MediaPathRecoveryEvent =
  | { type: "trouble"; direction: MediaDirection }
  | { type: "transport-connected"; direction: MediaDirection; transportId: string }
  | { type: "path-sampled"; direction: MediaDirection; evidence: PathEvidence }
  | { type: "rebuild-started"; direction: MediaDirection; transportId: string }
  | { type: "escalation-settled"; direction: MediaDirection; transportId: string }
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
            escalation: null,
            rebuildTried: false,
            deferredRebuild: null,
            failingStreams: NO_FAILING_STREAMS,
          }),
        recovery,
      );
    case "path-sampled": {
      const known = recovery[event.direction].failingStreams;
      const failingStreams = failingStreamsAfter(known, event.evidence.streams);
      return failingStreams.length === 0 && pathCarriesWhatIsSent(event.evidence, known)
        ? restartDirection(recovery, event.direction)
        : patchDirection(recovery, event.direction, { failingStreams });
    }
    case "trouble":
      return patchDirection(recovery, event.direction, {
        health:
          recovery[event.direction].health === "blocked" ? "blocked" : "recovering",
      });
    case "rebuild-started":
      return recovery[event.direction].escalation?.transportId === event.transportId
        ? patchDirection(recovery, event.direction, { rebuildTried: true })
        : recovery;
    case "escalation-settled":
      return recovery[event.direction].escalation?.transportId === event.transportId
        ? patchDirection(recovery, event.direction, { escalation: null })
        : recovery;
    case "transport-connected": {
      const held = recovery[event.direction].deferredRebuild;
      return held?.transportId === event.transportId && !held.silentWhileConnected
        ? patchDirection(recovery, event.direction, { deferredRebuild: null })
        : recovery;
    }
  }
};

export type MediaPathFailure = FailedPath & {
  direction: MediaDirection;
  relayOnly: boolean;
  reconnectInFlight: boolean;
};

export const planMediaPathFailure = (
  recovery: MediaPathRecovery,
  { direction, relayOnly, reconnectInFlight, ...path }: MediaPathFailure,
): {
  step: MediaPathEscalation | "already-escalated";
  recovery: MediaPathRecovery;
} => {
  const current = recovery[direction];
  if (current.escalation?.transportId === path.transportId) {
    return {
      step: "already-escalated",
      recovery: patchDirection(recovery, direction, {
        escalation: mergeFailedPath(current.escalation, path),
      }),
    };
  }
  const step = planMediaPathEscalation({
    hasReconnected: current.rebuildTried,
    relayOnly,
    reconnectInFlight,
  });
  if (step === "report-blocked") {
    return {
      step,
      recovery: patchDirection(recovery, direction, {
        health: "blocked",
        deferredRebuild: null,
      }),
    };
  }
  const health = current.health === "blocked" ? "blocked" : "recovering";
  if (step === "wait-for-reconnect") {
    return {
      step,
      recovery: patchDirection(recovery, direction, {
        health,
        deferredRebuild:
          current.deferredRebuild?.transportId === path.transportId
            ? mergeFailedPath(current.deferredRebuild, path)
            : path,
      }),
    };
  }
  return {
    step,
    recovery: patchDirection(recovery, direction, {
      health,
      escalation: path,
      deferredRebuild: null,
    }),
  };
};

/** The rebuilds held for a rejoin that has settled, and the recovery without them. */
export const takeDeferredRebuilds = (
  recovery: MediaPathRecovery,
): {
  deferred: Array<FailedPath & { direction: MediaDirection }>;
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
  pausedHere: boolean;
  pausedOnServer: boolean;
  producerPaused: boolean;
};

export type ServerConsumerState = {
  paused?: boolean;
  producerPaused?: boolean;
};

export const describeConsumedStream = ({
  kind,
  source,
  consumerPaused,
  adaptivelyPaused,
  producerPausedHere,
  server,
}: {
  kind: "audio" | "video";
  source: "webcam" | "screen";
  consumerPaused: boolean;
  adaptivelyPaused: boolean;
  producerPausedHere: boolean;
  server: ServerConsumerState | undefined;
}): ConsumedStream => ({
  kind,
  source,
  pausedHere: consumerPaused,
  pausedOnServer: adaptivelyPaused || server?.paused === true,
  producerPaused: producerPausedHere || server?.producerPaused === true,
});

export const streamShouldFlow = ({
  kind,
  source,
  pausedHere,
  pausedOnServer,
  producerPaused,
}: ConsumedStream): boolean =>
  !pausedHere &&
  !pausedOnServer &&
  !producerPaused &&
  (kind === "audio" || source === "webcam");

export const receivePathExpectsMedia = (
  streams: ConsumedStream[],
  connected: boolean,
): boolean => (connected ? streams.some(streamShouldFlow) : streams.length > 0);

export const screenVideoAwaitingSenderCheck = (
  streams: Array<{ consumerId: string; stream: ConsumedStream }>,
  connected: boolean,
): string[] =>
  connected &&
  !receivePathExpectsMedia(
    streams.map(({ stream }) => stream),
    connected,
  )
    ? streams
        .filter(
          ({ stream }) =>
            stream.kind === "video" &&
            stream.source === "screen" &&
            !stream.pausedHere &&
            !stream.pausedOnServer &&
            !stream.producerPaused,
        )
        .map(({ consumerId }) => consumerId)
    : [];

export type SenderPacketCounts = SenderPacketCountsAnswer["counts"];

export const senderPacketCountsRequestFor = (
  consumerIds: string[],
): SenderPacketCountsRequest | null => {
  if (consumerIds.length === 0) return null;
  const parsed = senderPacketCountsRequestSchema.safeParse({
    consumerIds: [...new Set(consumerIds)].slice(0, SENDER_PACKET_COUNTS_MAX_CONSUMERS),
  });
  return parsed.success ? parsed.data : null;
};

export const ownPacketCountsRequestFor = (
  producerIds: string[],
): OwnPacketCountsRequest | null => {
  if (producerIds.length === 0) return null;
  const parsed = ownPacketCountsRequestSchema.safeParse({
    producerIds: [...new Set(producerIds)].slice(0, OWN_PACKET_COUNTS_MAX_PRODUCERS),
  });
  return parsed.success ? parsed.data : null;
};

export const readSenderPacketCounts = (answer: unknown): SenderPacketCounts | null => {
  const parsed = senderPacketCountsAnswerSchema.safeParse(answer);
  return parsed.success ? parsed.data.counts : null;
};

export const senderSentMore = (
  previous: SenderPacketCounts | null,
  current: SenderPacketCounts | null,
): boolean =>
  previous !== null &&
  current !== null &&
  Object.entries(current).some(
    ([consumerId, sent]) =>
      consumerId in previous && sent > previous[consumerId],
  );

export const SCREEN_PACKETS_LOST_SAMPLES = 2;

export type ScreenShareWatch = {
  sent: SenderPacketCounts | null;
  samplesSentWithoutArrival: number;
};

export const INITIAL_SCREEN_SHARE_WATCH: ScreenShareWatch = {
  sent: null,
  samplesSentWithoutArrival: 0,
};

export const advanceScreenShareWatch = (
  watch: ScreenShareWatch,
  { sent, received }: { sent: SenderPacketCounts | null; received: boolean },
): ScreenShareWatch => {
  if (sent === null) {
    return received ? { ...watch, samplesSentWithoutArrival: 0 } : watch;
  }
  if (received) return { sent, samplesSentWithoutArrival: 0 };
  return {
    sent,
    samplesSentWithoutArrival:
      watch.samplesSentWithoutArrival + (senderSentMore(watch.sent, sent) ? 1 : 0),
  };
};

export const screenPacketsGoMissing = (watch: ScreenShareWatch): boolean =>
  watch.samplesSentWithoutArrival >= SCREEN_PACKETS_LOST_SAMPLES;

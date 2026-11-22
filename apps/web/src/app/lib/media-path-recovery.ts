/** How long a transport may carry no media before it is treated as stalled. */
export const MEDIA_PATH_STALL_MS = 15_000;
/** How long an ICE restart gets to bring a transport back. */
export const MEDIA_PATH_VERIFY_MS = 10_000;

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
): { watch: MediaPathWatch; condition: MediaPathCondition; stalledForMs: number } => {
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
  };
};

export type MediaPathEscalation =
  /** Rebuild the transports, forcing every candidate through TURN. */
  | "reconnect-relay-only"
  | "reconnect"
  /** Rebuilding did not help either: tell the user. */
  | "report-blocked";

/**
 * What to do when an ICE restart could not bring a transport back. One
 * rebuild is tried, through TURN alone when TURN is configured, because a
 * direct path that half works can keep ICE from settling on the relay.
 */
export const planMediaPathEscalation = ({
  hasReconnected,
  relayOnly,
  hasTurnServers,
}: {
  hasReconnected: boolean;
  relayOnly: boolean;
  hasTurnServers: boolean;
}): MediaPathEscalation => {
  if (hasReconnected) return "report-blocked";
  return hasTurnServers && !relayOnly ? "reconnect-relay-only" : "reconnect";
};

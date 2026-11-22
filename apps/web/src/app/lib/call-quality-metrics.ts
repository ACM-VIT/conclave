import type { ConnectionState, MeetError, MeetFailureReason, VideoQuality } from "./types";

/**
 * Call-quality metrics for one browser tab, sent as at most three PostHog
 * events per call: `call_join`, `call_first_media` and `call_summary`
 * (documented in telemetry.md). Raw getStats counters are folded into
 * totals here, so a 12-person call costs the same three events per client
 * as a 2-person one.
 */

export type CallMetricProps = Record<string, string | number | boolean | null>;

export type CallMetricEvent = {
  name: "call_join" | "call_first_media" | "call_summary";
  props: CallMetricProps;
  /** Captured while the page unloads, so it must go out with sendBeacon. */
  immediate: boolean;
};

export type InboundStreamStats = {
  /** Unique per stream for the call: transport id plus stats id. */
  id: string;
  kind: "audio" | "video";
  packetsReceived: number;
  bytesReceived: number;
  framesDecoded: number;
  freezeCount: number | null;
  totalFreezesDurationSec: number | null;
  concealedSamples: number | null;
  totalSamplesReceived: number | null;
};

export type OutboundLayerStats = {
  /** Unique per simulcast layer for the call: camera producer id plus stats id. */
  id: string;
  bytesSent: number;
  frameHeight: number | null;
  /** Cumulative seconds the encoder was limited, from qualityLimitationDurations. */
  cpuLimitedSec: number;
  bandwidthLimitedSec: number;
};

export type CallStatsSample = {
  /** Null when the receive transport's stats could not be read this time. */
  inbound: InboundStreamStats[] | null;
  /** Camera layers being sent; null when the camera producer's stats could not be read. */
  outboundVideo: OutboundLayerStats[] | null;
  outboundProfile: VideoQuality;
};

export type JoinMode = "meeting" | "webinar_attendee";

export type ConnectionSnapshot = {
  state: ConnectionState;
  error: MeetError | null;
  joinMode: JoinMode;
  /** Reconnecting stopped for good: retries ran out or the failure cannot be retried. */
  reconnectGaveUp: boolean;
  /**
   * The reconnect loop is running. An error while it runs is a failed retry,
   * not the outcome; a redirect between SFUs is not a reconnect.
   */
  reconnecting: boolean;
};

export type JoinFailureReason = MeetFailureReason;

const FIRST_MEDIA_DEADLINE_MS = 20_000;
const REMOTE_AT_JOIN_GRACE_MS = 3_000;
const MAX_SAMPLE_GAP_MS = 15_000;
// Same threshold as the freeze watchdog in useMeetSocket: bytes arriving
// without decoded frames means the decoder is stuck, not that video paused.
const STALL_MIN_BYTE_DELTA = 8_000;
const MEDIASOUP_PROBATOR_MID = "probator";
export const FAST_SAMPLE_MS = 250;
export const STEADY_SAMPLE_MS = 5_000;

const FAILURE_PATTERNS: Array<[RegExp, JoinFailureReason]> = [
  [/denied your request|not allowed to join|guests are not allowed/i, "rejected"],
  [/invite code/i, "invite_code"],
  [/no room found|room closed/i, "room_not_found"],
  [/locked|is full|not live|not enabled|draining|another sfu/i, "room_unavailable"],
  [/authentication|token|session/i, "auth"],
  [/timed out|timeout/i, "timeout"],
];

const FAILURE_CODES: Record<MeetError["code"], JoinFailureReason> = {
  PERMISSION_DENIED: "permission_denied",
  MEDIA_ERROR: "media_error",
  TRANSPORT_ERROR: "transport_error",
  CONNECTION_FAILED: "connection_failed",
  UNKNOWN: "unknown",
};

/** The failure's category: its own reason when it carries one, else read from it. */
export function joinFailureReason(error: MeetError | null): JoinFailureReason {
  if (!error) return "unknown";
  if (error.reason) return error.reason;
  const match = FAILURE_PATTERNS.find(([pattern]) => pattern.test(error.message));
  return match ? match[1] : FAILURE_CODES[error.code];
}

type StreamMemory = {
  packetsReceived: number;
  bytesReceived: number;
  framesDecoded: number;
  freezeCount: number;
  freezesSec: number;
  concealedSamples: number;
  totalSamplesReceived: number;
  stalled: boolean;
  /**
   * Video time measured and freeze time counted for this stream since its
   * baseline (joined, the end of a dropped gap, or a missed sample): the
   * freeze time it may still add is the difference.
   */
  videoMs: number;
  freezeMs: number;
  /** The sample these counters were read in. */
  readAt: number;
};

type Attempt = {
  callId: string;
  startedAt: number;
  joinMode: JoinMode;
  waitingSince: number | null;
  /**
   * When the server let the user in: `joinApproved`, or a joinRoom accepted
   * without it (the room unlocked during a drop), whichever came first.
   */
  waitingEndedAt: number | null;
  /** Remote media can start flowing while the join is still finishing. */
  firstAudioAt: number | null;
  firstVideoAt: number | null;
  /**
   * When each direction was last read; a failed read leaves it in place, and
   * joining the call clears it, so nothing from before joined is counted.
   */
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  /**
   * Last counters per stream and layer id with the sample they were read in.
   * One counts only against its reading in the previous sample, so one that
   * drops out of a report, or was last read before joined, starts again from
   * a new baseline.
   */
  streams: Map<string, StreamMemory>;
  outboundLayers: Map<string, LayerReading>;
};

/** A camera layer's counters and the sample they were read in. */
type LayerReading = OutboundLayerStats & { readAt: number };

type MediaTotals = {
  remoteVideoMs: number;
  freezeCount: number;
  freezeMs: number;
  stallCount: number;
  stallMs: number;
  concealedSamples: number;
  totalSamples: number;
  sendingMs: number;
  profileMs: Record<VideoQuality, number>;
  profileSwitches: number;
  sentBytes: number;
  heightMs: Map<number, number>;
  cpuLimitedMs: number;
  bandwidthLimitedMs: number;
};

type Call = Attempt & {
  joinedAt: number;
  waitingMs: number | null;
  /** When the call left joined and has not come back. */
  reconnectingSince: number | null;
  reconnectCount: number;
  reconnectTotalMs: number;
  reconnectLongestMs: number;
  peakParticipants: number;
  remotePresentAt: number | null;
  firstMediaReported: boolean;
  lastProfile: VideoQuality | null;
  totals: MediaTotals;
};

type Phase =
  | { name: "idle" }
  | { name: "joining"; attempt: Attempt }
  | { name: "in_call"; call: Call };

export type CallMetricsTracker = {
  onConnectionState(snapshot: ConnectionSnapshot, at: number): void;
  onParticipants(count: number, at: number): void;
  onStats(sample: CallStatsSample, at: number): void;
  onPageHidden(at: number): void;
  /** The host let the user in from the waiting room. */
  onAdmitted(at: number): void;
  /** How long to wait before the next stats sample, or null when no call is up. */
  nextSampleDelayMs(at: number): number | null;
};

// Any of these starts an attempt. reconnecting is a retry after a give-up:
// with the socket still up it can go straight to joining after a media wait.
const JOINING_STATES = new Set<ConnectionState>([
  "connecting",
  "connected",
  "joining",
  "waiting",
  "reconnecting",
]);

const emptyTotals = (): MediaTotals => ({
  remoteVideoMs: 0,
  freezeCount: 0,
  freezeMs: 0,
  stallCount: 0,
  stallMs: 0,
  concealedSamples: 0,
  totalSamples: 0,
  sendingMs: 0,
  profileMs: { low: 0, standard: 0 },
  profileSwitches: 0,
  sentBytes: 0,
  heightMs: new Map(),
  cpuLimitedMs: 0,
  bandwidthLimitedMs: 0,
});

const counterDelta = (current: number, previous: number): number =>
  current >= previous ? current - previous : current;

const roundMs = (value: number): number => Math.round(value);
const percent = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
const sinceStart = (call: Call, at: number | null): number | null =>
  at === null ? null : roundMs(at - call.startedAt);

const waitedMs = (attempt: Attempt, at: number): number | null =>
  attempt.waitingSince === null
    ? null
    : roundMs((attempt.waitingEndedAt ?? at) - attempt.waitingSince);

const isWaiting = (attempt: Attempt): boolean =>
  attempt.waitingSince !== null && attempt.waitingEndedAt === null;

const noteFirstMedia = (
  media: Pick<Attempt, "firstAudioAt" | "firstVideoAt">,
  inbound: InboundStreamStats[],
  at: number,
) => {
  for (const stream of inbound) {
    if (stream.kind === "audio" && media.firstAudioAt === null && stream.packetsReceived > 0) {
      media.firstAudioAt = at;
    }
    if (stream.kind === "video" && media.firstVideoAt === null && stream.framesDecoded > 0) {
      media.firstVideoAt = at;
    }
  }
};

const mostCommonHeight = (heightMs: Map<number, number>): number | null => {
  let best: number | null = null;
  let bestMs = 0;
  heightMs.forEach((ms, height) => {
    if (ms > bestMs) {
      best = height;
      bestMs = ms;
    }
  });
  return best;
};

export function createCallMetricsTracker({
  emit,
  newCallId,
}: {
  emit: (event: CallMetricEvent) => void;
  newCallId: () => string;
}): CallMetricsTracker {
  let phase: Phase = { name: "idle" };
  let lastState: ConnectionState | null = null;
  let failedAttempts = 0;
  let participants = 1;

  const emitJoin = (
    attempt: Attempt,
    outcome: "joined" | "failed" | "abandoned",
    at: number,
    extra: { failureReason?: JoinFailureReason; immediate?: boolean } = {},
  ) => {
    emit({
      name: "call_join",
      immediate: extra.immediate ?? false,
      props: {
        call_id: attempt.callId,
        outcome,
        failure_reason: extra.failureReason ?? null,
        join_ms: roundMs(at - attempt.startedAt),
        waited: attempt.waitingSince !== null,
        waiting_ms: waitedMs(attempt, at),
        join_mode: attempt.joinMode,
        prior_failed_attempts: failedAttempts,
      },
    });
  };

  const reportFirstMedia = (call: Call, at: number) => {
    if (call.firstMediaReported || call.remotePresentAt === null) return;
    const complete = call.firstAudioAt !== null && call.firstVideoAt !== null;
    const timedOut = at - call.joinedAt >= FIRST_MEDIA_DEADLINE_MS;
    if (!complete && !timedOut) return;
    call.firstMediaReported = true;
    emit({
      name: "call_first_media",
      immediate: false,
      props: {
        call_id: call.callId,
        first_remote_audio_ms: sinceStart(call, call.firstAudioAt),
        first_remote_video_ms: sinceStart(call, call.firstVideoAt),
        join_ms: roundMs(call.joinedAt - call.startedAt),
        remote_present_at_join:
          call.remotePresentAt - call.joinedAt <= REMOTE_AT_JOIN_GRACE_MS,
        timed_out: !complete,
        join_mode: call.joinMode,
      },
    });
  };

  const endCall = (
    call: Call,
    reason: "left" | "error" | "reconnect_failed" | "reconnect_abandoned" | "page_closed",
    at: number,
    immediate: boolean,
  ) => {
    const unrecoveredMs =
      call.reconnectingSince === null ? 0 : at - call.reconnectingSince;
    const { totals } = call;
    emit({
      name: "call_summary",
      immediate,
      props: {
        call_id: call.callId,
        join_mode: call.joinMode,
        end_reason: reason,
        duration_ms: roundMs(at - call.joinedAt),
        peak_participants: call.peakParticipants,
        waited: call.waitingMs !== null,
        first_remote_audio_ms: sinceStart(call, call.firstAudioAt),
        first_remote_video_ms: sinceStart(call, call.firstVideoAt),
        reconnect_count:
          call.reconnectCount + (call.reconnectingSince === null ? 0 : 1),
        reconnect_total_ms: roundMs(call.reconnectTotalMs + unrecoveredMs),
        reconnect_longest_ms: roundMs(
          Math.max(call.reconnectLongestMs, unrecoveredMs),
        ),
        reconnect_unrecovered: call.reconnectingSince !== null,
        remote_video_ms: roundMs(totals.remoteVideoMs),
        video_freeze_count: totals.freezeCount,
        video_freeze_ms: roundMs(totals.freezeMs),
        video_stall_count: totals.stallCount,
        video_stall_ms: roundMs(totals.stallMs),
        audio_concealed_pct: percent(totals.concealedSamples, totals.totalSamples),
        outbound_video_ms: roundMs(totals.sendingMs),
        outbound_low_ms: roundMs(totals.profileMs.low),
        outbound_standard_ms: roundMs(totals.profileMs.standard),
        outbound_profile_switches: totals.profileSwitches,
        outbound_video_kbps:
          totals.sendingMs > 0
            ? Math.round((totals.sentBytes * 8) / totals.sendingMs)
            : null,
        outbound_video_height: mostCommonHeight(totals.heightMs),
        outbound_cpu_limited_pct: percent(totals.cpuLimitedMs, totals.sendingMs),
        outbound_bandwidth_limited_pct: percent(
          totals.bandwidthLimitedMs,
          totals.sendingMs,
        ),
      },
    });
    phase = { name: "idle" };
  };

  const startCall = (attempt: Attempt, at: number): Call => ({
    ...attempt,
    lastInboundAt: null,
    lastOutboundAt: null,
    joinedAt: at,
    waitingMs: waitedMs(attempt, at),
    reconnectingSince: null,
    reconnectCount: 0,
    reconnectTotalMs: 0,
    reconnectLongestMs: 0,
    peakParticipants: participants,
    remotePresentAt: participants > 1 ? at : null,
    firstMediaReported: false,
    lastProfile: null,
    totals: emptyTotals(),
  });

  type StreamProgress = Pick<StreamMemory, "stalled" | "videoMs" | "freezeMs">;
  const BASELINE: StreamProgress = { stalled: false, videoMs: 0, freezeMs: 0 };

  /** Adds one stream's progress over `dt` to the totals. */
  const addInbound = (
    totals: MediaTotals,
    stream: InboundStreamStats,
    previous: StreamMemory | undefined,
    dt: number,
  ): StreamProgress => {
    const delta = (current: number | null, prior: number | undefined) =>
      current === null ? 0 : counterDelta(current, prior ?? 0);
    if (stream.kind === "audio") {
      totals.concealedSamples += delta(
        stream.concealedSamples,
        previous?.concealedSamples,
      );
      totals.totalSamples += delta(
        stream.totalSamplesReceived,
        previous?.totalSamplesReceived,
      );
      return BASELINE;
    }
    const bytes = delta(stream.bytesReceived, previous?.bytesReceived);
    const frames = delta(stream.framesDecoded, previous?.framesDecoded);
    // Credits whole sample intervals: a consumer swapped out between two
    // samples leaves no stats, so its replacement covers the interval.
    const videoMs = (previous?.videoMs ?? 0) + (bytes > 0 || frames > 0 ? dt : 0);
    if (bytes > 0 || frames > 0) totals.remoteVideoMs += dt;
    totals.freezeCount += delta(stream.freezeCount, previous?.freezeCount);
    // Chrome adds a freeze's whole duration when video resumes, so one that
    // began before the stream's baseline (before joined, or across a dropped
    // gap) lands at once. A stream adds at most the video time it has
    // measured since that baseline, less the freeze time already counted.
    const counted = previous?.freezeMs ?? 0;
    const freezeMs = Math.min(
      delta(stream.totalFreezesDurationSec, previous?.freezesSec) * 1000,
      videoMs - counted,
    );
    totals.freezeMs += freezeMs;
    const stalled = dt > 0 && frames === 0 && bytes >= STALL_MIN_BYTE_DELTA;
    if (stalled) {
      totals.stallMs += dt;
      if (!previous?.stalled) totals.stallCount += 1;
    }
    return { stalled, videoMs, freezeMs: counted + freezeMs };
  };

  /**
   * `dt` is null for an interval that is not measured, and `totals` is null
   * before the call starts: then only the baseline moves. A stream counts
   * against its reading from the previous sample, read at `previousAt`; one
   * first seen now started since then, so it counts from zero.
   */
  const foldInbound = (
    media: Attempt,
    totals: MediaTotals | null,
    stream: InboundStreamStats,
    previousAt: number | null,
    dt: number | null,
    at: number,
  ) => {
    const previous = media.streams.get(stream.id);
    const measured =
      dt !== null && totals !== null && (previous === undefined || previous.readAt === previousAt);
    const progress = measured
      ? addInbound(totals, stream, previous, dt)
      : { ...BASELINE, stalled: dt === null && (previous?.stalled ?? false) };

    media.streams.set(stream.id, {
      packetsReceived: stream.packetsReceived,
      bytesReceived: stream.bytesReceived,
      framesDecoded: stream.framesDecoded,
      freezeCount: stream.freezeCount ?? 0,
      freezesSec: stream.totalFreezesDurationSec ?? 0,
      concealedSamples: stream.concealedSamples ?? 0,
      totalSamplesReceived: stream.totalSamplesReceived ?? 0,
      ...progress,
      readAt: at,
    });
  };

  const rememberLayers = (media: Attempt, layers: OutboundLayerStats[], at: number) => {
    layers.forEach((layer) => media.outboundLayers.set(layer.id, { ...layer, readAt: at }));
  };

  /**
   * Adds the camera's progress since the previous sample, read at
   * `previousAt`. A layer counts only when its last reading is from that
   * sample, so one that drops out of a report and comes back starts again
   * from a new baseline. Limited time is taken once per interval, as the most
   * any layer shows, and never more than the interval itself.
   */
  const foldOutbound = (
    call: Call,
    layers: OutboundLayerStats[],
    profile: VideoQuality,
    previousAt: number | null,
    at: number,
  ) => {
    const previous = new Map(call.outboundLayers);
    rememberLayers(call, layers, at);
    const dt = measuredInterval(previousAt, at);
    if (dt === null) return;

    let sentBytes = 0;
    let height = 0;
    let cpuSec = 0;
    let bandwidthSec = 0;
    layers.forEach((layer) => {
      const prior = previous.get(layer.id);
      if (!prior || prior.readAt !== previousAt) return;
      const bytes = counterDelta(layer.bytesSent, prior.bytesSent);
      if (bytes === 0) return;
      sentBytes += bytes;
      height = Math.max(height, layer.frameHeight ?? 0);
      // Every layer comes from one encoder, so they share one limitation clock.
      cpuSec = Math.max(cpuSec, counterDelta(layer.cpuLimitedSec, prior.cpuLimitedSec));
      bandwidthSec = Math.max(
        bandwidthSec,
        counterDelta(layer.bandwidthLimitedSec, prior.bandwidthLimitedSec),
      );
    });
    if (dt === 0 || sentBytes === 0) return;

    const { totals } = call;
    totals.sendingMs += dt;
    totals.sentBytes += sentBytes;
    totals.profileMs[profile] += dt;
    if (call.lastProfile !== null && call.lastProfile !== profile) {
      totals.profileSwitches += 1;
    }
    call.lastProfile = profile;
    if (height > 0) {
      totals.heightMs.set(height, (totals.heightMs.get(height) ?? 0) + dt);
    }
    // The stats clock and ours drift a little, so a fully limited interval can
    // read a few ms over.
    totals.cpuLimitedMs += Math.min(cpuSec * 1000, dt);
    totals.bandwidthLimitedMs += Math.min(bandwidthSec * 1000, dt);
  };

  /**
   * The time since a direction's last read, or null when there is nothing to
   * measure against: the first read is only a baseline, and a gap this long (a
   * throttled tab, failed reads) cannot say when its bytes and freezes
   * happened.
   */
  const measuredInterval = (since: number | null, at: number) => {
    if (since === null) return null;
    const dt = at - since;
    return dt > MAX_SAMPLE_GAP_MS ? null : dt;
  };

  return {
    onConnectionState({ state, error, joinMode, reconnectGaveUp, reconnecting }, at) {
      const previousState = lastState;
      lastState = state;
      if (phase.name === "idle") {
        if (!JOINING_STATES.has(state)) return;
        phase = {
          name: "joining",
          attempt: {
            callId: newCallId(),
            startedAt: at,
            joinMode,
            waitingSince: state === "waiting" ? at : null,
            waitingEndedAt: null,
            firstAudioAt: null,
            firstVideoAt: null,
            lastInboundAt: null,
            lastOutboundAt: null,
            streams: new Map(),
            outboundLayers: new Map(),
          },
        };
        return;
      }

      if (phase.name === "joining") {
        const { attempt } = phase;
        if (state === "waiting") {
          attempt.waitingSince ??= at;
          // Put back in the lobby after an earlier admission: waiting again.
          if (previousState !== "waiting") attempt.waitingEndedAt = null;
        }
        const retrying = reconnecting && !reconnectGaveUp;
        if (state === "joined") {
          emitJoin(attempt, "joined", at);
          failedAttempts = 0;
          phase = { name: "in_call", call: startCall(attempt, at) };
        } else if (state === "disconnected" || (state === "error" && !retrying)) {
          const failed = state === "error" || error !== null;
          emitJoin(attempt, failed ? "failed" : "abandoned", at, {
            failureReason: failed ? joinFailureReason(error) : undefined,
          });
          if (failed) failedAttempts += 1;
          phase = { name: "idle" };
        }
        return;
      }

      const { call } = phase;
      // A hidden tab reconnects without leaving joined, so the socket's own
      // signal starts the clock too, at the drop and before the first backoff.
      const backInCall = state === "joined" && !reconnecting;
      if (backInCall) {
        if (call.reconnectingSince !== null) {
          const lasted = at - call.reconnectingSince;
          call.reconnectCount += 1;
          call.reconnectTotalMs += lasted;
          call.reconnectLongestMs = Math.max(call.reconnectLongestMs, lasted);
          call.reconnectingSince = null;
        }
      } else if (state === "disconnected") {
        endCall(
          call,
          call.reconnectingSince !== null
            ? "reconnect_abandoned"
            : error
              ? "error"
              : "left",
          at,
          false,
        );
      } else if (state === "error" && reconnectGaveUp) {
        endCall(call, "reconnect_failed", at, false);
      } else {
        // Errors between retries are part of the reconnect; only giving up
        // or leaving ends the call.
        call.reconnectingSince ??= at;
      }
    },

    onParticipants(count, at) {
      participants = count;
      if (phase.name !== "in_call") return;
      const { call } = phase;
      call.peakParticipants = Math.max(call.peakParticipants, count);
      if (count > 1 && call.remotePresentAt === null) call.remotePresentAt = at;
    },

    onStats(sample, at) {
      if (phase.name === "idle") return;
      // During the join a sample only stamps first media and moves the
      // baselines; the call starts its own at joined and adds deltas after.
      const media = phase.name === "joining" ? phase.attempt : phase.call;
      const call = phase.name === "in_call" ? phase.call : null;
      if (sample.inbound) {
        noteFirstMedia(media, sample.inbound, at);
        const previousAt = media.lastInboundAt;
        const dt = call ? measuredInterval(previousAt, at) : null;
        media.lastInboundAt = at;
        sample.inbound.forEach((stream) =>
          foldInbound(media, call?.totals ?? null, stream, previousAt, dt, at),
        );
      }
      if (sample.outboundVideo) {
        if (call) {
          foldOutbound(call, sample.outboundVideo, sample.outboundProfile, call.lastOutboundAt, at);
        } else {
          rememberLayers(media, sample.outboundVideo, at);
        }
        media.lastOutboundAt = at;
      }
      if (call) reportFirstMedia(call, at);
    },

    onPageHidden(at) {
      if (phase.name === "joining") {
        emitJoin(phase.attempt, "abandoned", at, { immediate: true });
        phase = { name: "idle" };
      } else if (phase.name === "in_call") {
        const { call } = phase;
        endCall(
          call,
          call.reconnectingSince !== null ? "reconnect_abandoned" : "page_closed",
          at,
          true,
        );
      }
    },

    onAdmitted(at) {
      if (phase.name !== "joining" || phase.attempt.waitingSince === null) return;
      phase.attempt.waitingEndedAt ??= at;
    },

    nextSampleDelayMs(at) {
      if (phase.name === "joining") {
        return isWaiting(phase.attempt) ? null : FAST_SAMPLE_MS;
      }
      if (phase.name !== "in_call") return null;
      const { call } = phase;
      const waitingForFirstMedia =
        (call.firstAudioAt === null || call.firstVideoAt === null) &&
        at - call.joinedAt < FIRST_MEDIA_DEADLINE_MS;
      return waitingForFirstMedia ? FAST_SAMPLE_MS : STEADY_SAMPLE_MS;
    },
  };
}

type StatsReportLike = { forEach(callback: (stat: unknown) => void): void };

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const statKind = (stat: Record<string, unknown>): unknown =>
  stat.kind ?? stat.mediaType;

/** One getStats reading; `sourceId` keeps stats ids unique across sources. */
export type StatsRead = { sourceId: string; report: StatsReportLike };

/**
 * Reads the receive transport's report and the camera producer's report into
 * a sample. A null read is one whose getStats failed.
 */
export function parseCallStats({
  receive,
  camera,
  profile,
}: {
  receive: StatsRead | null;
  camera: StatsRead | null;
  profile: VideoQuality;
}): CallStatsSample {
  let inbound: InboundStreamStats[] | null = null;
  if (receive) {
    const streams: InboundStreamStats[] = [];
    receive.report.forEach((raw) => {
      const stat = raw as Record<string, unknown>;
      const kind = statKind(stat);
      if (stat.type !== "inbound-rtp" || (kind !== "audio" && kind !== "video")) {
        return;
      }
      // mediasoup's bandwidth probe: padding bytes, never frames.
      if (stat.mid === MEDIASOUP_PROBATOR_MID) return;
      streams.push({
        id: `${receive.sourceId}:${String(stat.id)}`,
        kind,
        packetsReceived: finite(stat.packetsReceived) ?? 0,
        bytesReceived: finite(stat.bytesReceived) ?? 0,
        framesDecoded: finite(stat.framesDecoded) ?? 0,
        freezeCount: finite(stat.freezeCount),
        totalFreezesDurationSec: finite(stat.totalFreezesDuration),
        concealedSamples: finite(stat.concealedSamples),
        totalSamplesReceived: finite(stat.totalSamplesReceived),
      });
    });
    inbound = streams;
  }

  let outboundVideo: OutboundLayerStats[] | null = null;
  if (camera) {
    const layers: OutboundLayerStats[] = [];
    camera.report.forEach((raw) => {
      const stat = raw as Record<string, unknown>;
      if (stat.type !== "outbound-rtp" || statKind(stat) !== "video") return;
      const limits = (stat.qualityLimitationDurations ?? {}) as Record<
        string,
        unknown
      >;
      layers.push({
        id: `${camera.sourceId}:${String(stat.id)}`,
        bytesSent: finite(stat.bytesSent) ?? 0,
        frameHeight: finite(stat.frameHeight),
        cpuLimitedSec: finite(limits.cpu) ?? 0,
        bandwidthLimitedSec: finite(limits.bandwidth) ?? 0,
      });
    });
    outboundVideo = layers;
  }

  return { inbound, outboundVideo, outboundProfile: profile };
}

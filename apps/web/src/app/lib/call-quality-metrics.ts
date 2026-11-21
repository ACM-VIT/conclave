import type { ConnectionState, MeetError, VideoQuality } from "./types";

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

export type OutboundVideoStats = {
  /** Summed across simulcast layers. */
  bytesSent: number;
  frameHeight: number | null;
  /** Cumulative seconds the encoder was limited, from qualityLimitationDurations. */
  limitedSec: { cpu: number; bandwidth: number } | null;
};

export type CallStatsSample = {
  inbound: InboundStreamStats[];
  outboundVideo: OutboundVideoStats | null;
  outboundProfile: VideoQuality;
};

export type JoinMode = "meeting" | "webinar_attendee";

export type JoinFailureReason =
  | "rejected"
  | "invite_code"
  | "room_not_found"
  | "room_unavailable"
  | "auth"
  | "timeout"
  | "permission_denied"
  | "media_error"
  | "transport_error"
  | "connection_failed"
  | "unknown";

const FIRST_MEDIA_DEADLINE_MS = 20_000;
const REMOTE_AT_JOIN_GRACE_MS = 3_000;
const MAX_SAMPLE_GAP_MS = 15_000;
// Same threshold as the freeze watchdog in useMeetSocket: bytes arriving
// without decoded frames means the decoder is stuck, not that video paused.
const STALL_MIN_BYTE_DELTA = 8_000;
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

export function joinFailureReason(error: MeetError | null): JoinFailureReason {
  if (!error) return "unknown";
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
};

type Attempt = {
  callId: string;
  startedAt: number;
  joinMode: JoinMode;
  waitingSince: number | null;
};

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
  reconnectingSince: number | null;
  reconnectCount: number;
  reconnectTotalMs: number;
  reconnectLongestMs: number;
  peakParticipants: number;
  remotePresentAt: number | null;
  firstAudioAt: number | null;
  firstVideoAt: number | null;
  firstMediaReported: boolean;
  lastSampleAt: number | null;
  streams: Map<string, StreamMemory>;
  lastOutbound: OutboundVideoStats | null;
  lastProfile: VideoQuality | null;
  totals: MediaTotals;
};

type Phase =
  | { name: "idle" }
  | { name: "joining"; attempt: Attempt }
  | { name: "in_call"; call: Call };

export type CallMetricsTracker = {
  onConnectionState(
    state: ConnectionState,
    error: MeetError | null,
    joinMode: JoinMode,
    at: number,
  ): void;
  onParticipants(count: number, at: number): void;
  onStats(sample: CallStatsSample, at: number): void;
  onPageHidden(at: number): void;
  /** How long to wait before the next stats sample, or null when no call is up. */
  nextSampleDelayMs(at: number): number | null;
};

const JOINING_STATES = new Set<ConnectionState>([
  "connecting",
  "connected",
  "joining",
  "waiting",
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
        waiting_ms:
          attempt.waitingSince === null ? null : roundMs(at - attempt.waitingSince),
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
    endReason: "left" | "error" | "reconnect_failed" | "page_closed",
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
        end_reason: endReason,
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
    joinedAt: at,
    waitingMs: attempt.waitingSince === null ? null : at - attempt.waitingSince,
    reconnectingSince: null,
    reconnectCount: 0,
    reconnectTotalMs: 0,
    reconnectLongestMs: 0,
    peakParticipants: participants,
    remotePresentAt: participants > 1 ? at : null,
    firstAudioAt: null,
    firstVideoAt: null,
    firstMediaReported: false,
    lastSampleAt: null,
    streams: new Map(),
    lastOutbound: null,
    lastProfile: null,
    totals: emptyTotals(),
  });

  const foldInbound = (call: Call, stream: InboundStreamStats, dt: number, at: number) => {
    const previous = call.streams.get(stream.id);
    const delta = (current: number | null, prior: number | undefined) =>
      current === null ? 0 : counterDelta(current, prior ?? 0);
    const bytes = delta(stream.bytesReceived, previous?.bytesReceived);
    const frames = delta(stream.framesDecoded, previous?.framesDecoded);
    const { totals } = call;
    let stalled = false;

    if (stream.kind === "audio") {
      if (call.firstAudioAt === null && stream.packetsReceived > 0) {
        call.firstAudioAt = at;
      }
      totals.concealedSamples += delta(
        stream.concealedSamples,
        previous?.concealedSamples,
      );
      totals.totalSamples += delta(
        stream.totalSamplesReceived,
        previous?.totalSamplesReceived,
      );
    } else {
      if (call.firstVideoAt === null && stream.framesDecoded > 0) {
        call.firstVideoAt = at;
      }
      if (bytes > 0 || frames > 0) totals.remoteVideoMs += dt;
      totals.freezeCount += delta(stream.freezeCount, previous?.freezeCount);
      totals.freezeMs +=
        delta(stream.totalFreezesDurationSec, previous?.freezesSec) * 1000;
      stalled = dt > 0 && frames === 0 && bytes >= STALL_MIN_BYTE_DELTA;
      if (stalled) {
        totals.stallMs += dt;
        if (!previous?.stalled) totals.stallCount += 1;
      }
    }

    call.streams.set(stream.id, {
      packetsReceived: stream.packetsReceived,
      bytesReceived: stream.bytesReceived,
      framesDecoded: stream.framesDecoded,
      freezeCount: stream.freezeCount ?? 0,
      freezesSec: stream.totalFreezesDurationSec ?? 0,
      concealedSamples: stream.concealedSamples ?? 0,
      totalSamplesReceived: stream.totalSamplesReceived ?? 0,
      stalled,
    });
  };

  const foldOutbound = (call: Call, sample: CallStatsSample, dt: number) => {
    const current = sample.outboundVideo;
    const previous = call.lastOutbound;
    call.lastOutbound = current;
    if (!current) return;
    const sentBytes = counterDelta(current.bytesSent, previous?.bytesSent ?? 0);
    if (dt === 0 || sentBytes === 0) return;

    const { totals } = call;
    totals.sendingMs += dt;
    totals.sentBytes += sentBytes;
    totals.profileMs[sample.outboundProfile] += dt;
    if (call.lastProfile !== null && call.lastProfile !== sample.outboundProfile) {
      totals.profileSwitches += 1;
    }
    call.lastProfile = sample.outboundProfile;
    if (current.frameHeight) {
      totals.heightMs.set(
        current.frameHeight,
        (totals.heightMs.get(current.frameHeight) ?? 0) + dt,
      );
    }
    if (current.limitedSec && previous?.limitedSec) {
      totals.cpuLimitedMs +=
        counterDelta(current.limitedSec.cpu, previous.limitedSec.cpu) * 1000;
      totals.bandwidthLimitedMs +=
        counterDelta(current.limitedSec.bandwidth, previous.limitedSec.bandwidth) *
        1000;
    }
  };

  return {
    onConnectionState(state, error, joinMode, at) {
      if (phase.name === "idle") {
        if (!JOINING_STATES.has(state)) return;
        phase = {
          name: "joining",
          attempt: {
            callId: newCallId(),
            startedAt: at,
            joinMode,
            waitingSince: state === "waiting" ? at : null,
          },
        };
        return;
      }

      if (phase.name === "joining") {
        const { attempt } = phase;
        if (state === "waiting" && attempt.waitingSince === null) {
          attempt.waitingSince = at;
        } else if (state === "joined") {
          emitJoin(attempt, "joined", at);
          failedAttempts = 0;
          phase = { name: "in_call", call: startCall(attempt, at) };
        } else if (state === "error" || state === "disconnected") {
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
      if (state === "joined") {
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
            ? "reconnect_failed"
            : error
              ? "error"
              : "left",
          at,
          false,
        );
      } else if (call.reconnectingSince === null) {
        call.reconnectingSince = at;
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
      if (phase.name !== "in_call") return;
      const { call } = phase;
      const dt =
        call.lastSampleAt === null
          ? 0
          : Math.min(at - call.lastSampleAt, MAX_SAMPLE_GAP_MS);
      call.lastSampleAt = at;

      const seen = new Set<string>();
      sample.inbound.forEach((stream) => {
        seen.add(stream.id);
        foldInbound(call, stream, dt, at);
      });
      call.streams.forEach((_memory, id) => {
        if (!seen.has(id)) call.streams.delete(id);
      });
      foldOutbound(call, sample, dt);
      reportFirstMedia(call, at);
    },

    onPageHidden(at) {
      if (phase.name === "joining") {
        emitJoin(phase.attempt, "abandoned", at, { immediate: true });
        phase = { name: "idle" };
      } else if (phase.name === "in_call") {
        endCall(phase.call, "page_closed", at, true);
      }
    },

    nextSampleDelayMs(at) {
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

/** Reads the getStats reports of the receive and send transports into a sample. */
export function parseCallStats({
  receive,
  send,
  profile,
}: {
  receive: { transportId: string; report: StatsReportLike } | null;
  send: StatsReportLike | null;
  profile: VideoQuality;
}): CallStatsSample {
  const inbound: InboundStreamStats[] = [];
  receive?.report.forEach((raw) => {
    const stat = raw as Record<string, unknown>;
    const kind = statKind(stat);
    if (stat.type !== "inbound-rtp" || (kind !== "audio" && kind !== "video")) {
      return;
    }
    inbound.push({
      id: `${receive.transportId}:${String(stat.id)}`,
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

  let outboundVideo: OutboundVideoStats | null = null;
  send?.forEach((raw) => {
    const stat = raw as Record<string, unknown>;
    if (stat.type !== "outbound-rtp" || statKind(stat) !== "video") return;
    const limits = stat.qualityLimitationDurations as
      | Record<string, unknown>
      | undefined;
    const height = finite(stat.frameHeight);
    const previous: OutboundVideoStats = outboundVideo ?? {
      bytesSent: 0,
      frameHeight: null,
      limitedSec: null,
    };
    outboundVideo = {
      bytesSent: previous.bytesSent + (finite(stat.bytesSent) ?? 0),
      frameHeight:
        height === null
          ? previous.frameHeight
          : Math.max(height, previous.frameHeight ?? 0),
      limitedSec: limits
        ? {
            cpu: Math.max(finite(limits.cpu) ?? 0, previous.limitedSec?.cpu ?? 0),
            bandwidth: Math.max(
              finite(limits.bandwidth) ?? 0,
              previous.limitedSec?.bandwidth ?? 0,
            ),
          }
        : previous.limitedSec,
    };
  });

  return { inbound, outboundVideo, outboundProfile: profile };
}

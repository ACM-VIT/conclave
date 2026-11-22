import { describe, expect, it } from "vitest";
import {
  createCallMetricsTracker,
  FAST_SAMPLE_MS,
  parseCallStats,
  STEADY_SAMPLE_MS,
  type CallMetricEvent,
  type CallStatsSample,
  type InboundStreamStats,
  type OutboundLayerStats,
} from "../src/app/lib/call-quality-metrics";
import type { ConnectionState, MeetError } from "../src/app/lib/types";

const setup = () => {
  const events: CallMetricEvent[] = [];
  let ids = 0;
  const tracker = createCallMetricsTracker({
    emit: (event) => events.push(event),
    newCallId: () => `call-${++ids}`,
  });
  const state = (
    next: ConnectionState,
    at: number,
    error: MeetError | null = null,
    reconnectGaveUp = false,
    reconnecting = false,
  ) =>
    tracker.onConnectionState(
      { state: next, error, joinMode: "meeting", reconnectGaveUp, reconnecting },
      at,
    );
  const named = (name: CallMetricEvent["name"]) =>
    events.filter((event) => event.name === name);
  return { tracker, events, state, named };
};

const audio = (overrides: Partial<InboundStreamStats> = {}): InboundStreamStats => ({
  id: "recv:audio-1",
  kind: "audio",
  packetsReceived: 0,
  bytesReceived: 0,
  framesDecoded: 0,
  freezeCount: null,
  totalFreezesDurationSec: null,
  concealedSamples: 0,
  totalSamplesReceived: 0,
  ...overrides,
});

const video = (overrides: Partial<InboundStreamStats> = {}): InboundStreamStats => ({
  id: "recv:video-1",
  kind: "video",
  packetsReceived: 0,
  bytesReceived: 0,
  framesDecoded: 0,
  freezeCount: 0,
  totalFreezesDurationSec: 0,
  concealedSamples: null,
  totalSamplesReceived: null,
  ...overrides,
});

const layer = (overrides: Partial<OutboundLayerStats> = {}): OutboundLayerStats => ({
  id: "send:L1",
  bytesSent: 0,
  frameHeight: 180,
  cpuLimitedSec: 0,
  bandwidthLimitedSec: 0,
  ...overrides,
});

const sample = (
  inbound: InboundStreamStats[] | null,
  outbound: Partial<CallStatsSample> = {},
): CallStatsSample => ({
  inbound,
  outboundVideo: [],
  outboundProfile: "standard",
  ...outbound,
});

describe("call_join", () => {
  it("reports a join through the waiting room with its timings", () => {
    const { tracker, state, named } = setup();

    state("connecting", 1000);
    state("joining", 1400);
    state("waiting", 1500);
    tracker.onAdmitted(9000);
    state("joining", 9500);
    state("joined", 10_000);

    expect(named("call_join")).toEqual([
      {
        name: "call_join",
        immediate: false,
        props: {
          call_id: "call-1",
          outcome: "joined",
          failure_reason: null,
          join_ms: 9000,
          waited: true,
          waiting_ms: 7500,
          join_mode: "meeting",
          prior_failed_attempts: 0,
        },
      },
    ]);
  });

  it("stops the waiting clock when the host lets the user in, not after media", () => {
    const { tracker, state, named } = setup();

    state("connecting", 0);
    state("waiting", 500);
    tracker.onAdmitted(1700);
    // Camera and microphone are reacquired while the state still says waiting.
    state("joining", 5400);
    state("joined", 11_500);

    expect(named("call_join")[0].props).toMatchObject({
      waited: true,
      waiting_ms: 1200,
      join_ms: 11_500,
    });
  });

  it("keeps the waiting clock running through a drop in the waiting room", () => {
    const { tracker, state, named } = setup();

    state("connecting", 0);
    state("waiting", 500);
    state("reconnecting", 2000, null, false, true);
    expect(tracker.nextSampleDelayMs(2500)).toBeNull();
    state("connecting", 2200, null, false, true);
    state("joining", 3000, null, false, true);
    state("waiting", 3500);
    expect(tracker.nextSampleDelayMs(4000)).toBeNull();
    tracker.onAdmitted(5300);
    state("joining", 5500);
    state("joined", 15_500);

    expect(named("call_join")[0].props).toMatchObject({
      waited: true,
      waiting_ms: 4800,
      join_ms: 15_500,
    });
  });

  it("keeps one attempt through a reconnect error in the waiting room", () => {
    const { tracker, state, named } = setup();

    state("connecting", 0);
    state("waiting", 500);
    state("reconnecting", 2000, null, false, true);
    state("connecting", 2100, null, false, true);
    state("error", 2600, {
      code: "CONNECTION_FAILED",
      message: "The meeting server did not respond before the timeout.",
      recoverable: true,
    }, false, true);
    state("reconnecting", 3000, null, false, true);
    state("connecting", 3100, null, false, true);
    state("joining", 3300, null, false, true);
    state("waiting", 3500);
    tracker.onAdmitted(6000);
    state("joining", 6500);
    state("joined", 9000);

    expect(named("call_join").map(({ props }) => props)).toEqual([
      expect.objectContaining({
        call_id: "call-1",
        outcome: "joined",
        waiting_ms: 5500,
        prior_failed_attempts: 0,
      }),
    ]);
  });

  it("fails a waiting-room attempt only when reconnecting gives up", () => {
    const { state, named } = setup();

    state("connecting", 0);
    state("waiting", 500);
    state("reconnecting", 2000, null, false, true);
    state("error", 2600, null, false, true);
    state("reconnecting", 3000, null, false, true);
    state("error", 40_000, {
      code: "CONNECTION_FAILED",
      message: "The meeting server did not respond before the timeout.",
      recoverable: true,
    }, true);

    expect(named("call_join").map(({ props }) => [props.outcome, props.failure_reason])).toEqual([
      ["failed", "timeout"],
    ]);
  });

  it("classifies failures and counts the retries before a success", () => {
    const { state, named } = setup();

    state("connecting", 0);
    state("error", 2000, {
      code: "UNKNOWN",
      message: "Invalid meeting invite code.",
      recoverable: true,
    });
    state("connecting", 5000);
    state("disconnected", 5200, {
      code: "PERMISSION_DENIED",
      message: "The host has denied your request to join.",
      recoverable: false,
    });
    state("connecting", 8000);
    state("error", 9000, {
      code: "PERMISSION_DENIED",
      message: "Camera/microphone permission denied",
      recoverable: true,
    });
    state("connecting", 10_000);
    state("joined", 11_000);

    expect(
      named("call_join").map(({ props }) => [
        props.outcome,
        props.failure_reason,
        props.prior_failed_attempts,
      ]),
    ).toEqual([
      ["failed", "invite_code", 0],
      ["failed", "rejected", 1],
      ["failed", "permission_denied", 2],
      ["joined", null, 3],
    ]);
  });

  it("reports a join that fails after following an SFU redirect", () => {
    const { tracker, state, named } = setup();
    const noRoom = {
      code: "UNKNOWN" as const,
      message: "No room found for this code.",
      recoverable: false,
    };

    state("connecting", 0);
    state("joining", 400);
    // startJoin follows the redirect to the room's SFU: not a reconnect.
    state("connecting", 600);
    state("connected", 700);
    state("joining", 800);
    state("error", 1200, noRoom);
    tracker.onPageHidden(5000);

    expect(named("call_join").map(({ props }) => [props.outcome, props.failure_reason])).toEqual([
      ["failed", "room_not_found"],
    ]);
  });

  it("ends the wait when a rejoin is accepted after the room unlocks mid-drop", () => {
    const { tracker, state, named } = setup();
    tracker.onParticipants(2, 0);

    state("connecting", 0);
    state("waiting", 500);
    state("reconnecting", 2000, null, false, true);
    state("connecting", 2100, null, false, true);
    state("joining", 2600, null, false, true);
    // The host unlocked meanwhile: joinRoom succeeds with no joinApproved.
    tracker.onAdmitted(2900);
    expect(tracker.nextSampleDelayMs(3000)).not.toBeNull();
    tracker.onStats(
      sample([audio({ packetsReceived: 40 }), video({ bytesReceived: 30_000, framesDecoded: 20 })]),
      3200,
    );
    state("joined", 8000);
    tracker.onStats(sample([audio({ packetsReceived: 400 }), video({ bytesReceived: 300_000, framesDecoded: 200 })]), 8250);

    expect(named("call_join")[0].props).toMatchObject({ waited: true, waiting_ms: 2400, join_ms: 8000 });
    expect(named("call_first_media")[0].props).toMatchObject({
      first_remote_audio_ms: 3200,
      first_remote_video_ms: 3200,
    });
  });

  it("keeps the first admission when the accepted join follows joinApproved", () => {
    const { tracker, state, named } = setup();

    state("connecting", 0);
    state("waiting", 500);
    tracker.onAdmitted(1700);
    state("joining", 5000);
    tracker.onAdmitted(5400);
    state("joined", 9000);

    expect(named("call_join")[0].props).toMatchObject({ waiting_ms: 1200 });
  });

  it("still fails a first join whose error arrives with a repeated connecting state", () => {
    const { state, named } = setup();
    const timeout = {
      code: "CONNECTION_FAILED" as const,
      message: "The meeting server did not respond before the timeout.",
      recoverable: true,
    };

    state("connecting", 0);
    // The hook re-reports the same state when only the error changes.
    state("connecting", 400, timeout);
    state("error", 500, timeout);

    expect(named("call_join").map(({ props }) => props.outcome)).toEqual(["failed"]);
  });

  it("marks a join the user walked away from as abandoned", () => {
    const { tracker, state, named } = setup();

    state("connecting", 0);
    state("disconnected", 3000);
    state("connecting", 4000);
    tracker.onPageHidden(4500);

    expect(named("call_join").map(({ props, immediate }) => [props.outcome, immediate])).toEqual([
      ["abandoned", false],
      ["abandoned", true],
    ]);
  });
});

describe("call_first_media", () => {
  it("times the first remote audio and video from the join click", () => {
    const { tracker, state, named } = setup();
    tracker.onParticipants(3, 0);

    state("connecting", 0);
    state("joined", 1200);
    tracker.onStats(sample([audio(), video()]), 1450);
    tracker.onStats(sample([audio({ packetsReceived: 12 }), video()]), 1700);
    tracker.onStats(
      sample([
        audio({ packetsReceived: 40 }),
        video({ bytesReceived: 30_000, framesDecoded: 2 }),
      ]),
      2200,
    );

    expect(named("call_first_media")).toEqual([
      {
        name: "call_first_media",
        immediate: false,
        props: {
          call_id: "call-1",
          first_remote_audio_ms: 1700,
          first_remote_video_ms: 2200,
          join_ms: 1200,
          remote_present_at_join: true,
          timed_out: false,
          join_mode: "meeting",
        },
      },
    ]);
  });

  it("times remote media that arrives before the join finishes", () => {
    const { tracker, state, named } = setup();
    tracker.onParticipants(2, 0);

    state("connecting", 0);
    state("joining", 400);
    expect(tracker.nextSampleDelayMs(500)).toBe(FAST_SAMPLE_MS);
    tracker.onStats(sample([audio(), video()]), 2750);
    tracker.onStats(
      sample([
        audio({ packetsReceived: 40 }),
        video({ bytesReceived: 30_000, framesDecoded: 20 }),
      ]),
      3000,
    );
    state("joined", 12_500);
    tracker.onStats(
      sample([
        audio({ packetsReceived: 500 }),
        video({ bytesReceived: 900_000, framesDecoded: 300 }),
      ]),
      12_750,
    );

    expect(named("call_first_media")[0].props).toMatchObject({
      first_remote_audio_ms: 3000,
      first_remote_video_ms: 3000,
      join_ms: 12_500,
      timed_out: false,
    });
  });

  it("reports missing video after the deadline instead of waiting forever", () => {
    const { tracker, state, named } = setup();
    tracker.onParticipants(2, 0);

    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([audio({ packetsReceived: 5 }), video()]), 1500);
    tracker.onStats(sample([audio({ packetsReceived: 90 }), video()]), 21_000);

    expect(named("call_first_media")[0].props).toMatchObject({
      first_remote_audio_ms: 1500,
      first_remote_video_ms: null,
      timed_out: true,
    });
  });

  it("stays quiet for someone alone in the room", () => {
    const { tracker, state, named } = setup();

    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([]), 30_000);

    expect(named("call_first_media")).toEqual([]);
  });
});

describe("call_summary", () => {
  it("adds up reconnects, freezes, stalls and the outbound profile", () => {
    const { tracker, state, named } = setup();
    tracker.onParticipants(2, 0);
    state("connecting", 0);
    state("joined", 1000);
    tracker.onParticipants(5, 2000);
    tracker.onParticipants(4, 3000);

    tracker.onStats(
      sample([audio({ totalSamplesReceived: 0 }), video()], {
        outboundVideo: [layer()],
        outboundProfile: "low",
      }),
      5000,
    );
    tracker.onStats(
      sample(
        [
          audio({ concealedSamples: 480, totalSamplesReceived: 48_000 }),
          video({
            bytesReceived: 400_000,
            framesDecoded: 150,
            freezeCount: 1,
            totalFreezesDurationSec: 0.6,
          }),
        ],
        {
          outboundVideo: [layer({ bytesSent: 250_000, bandwidthLimitedSec: 2 })],
          outboundProfile: "low",
        },
      ),
      10_000,
    );
    tracker.onStats(
      sample(
        [
          audio({ concealedSamples: 480, totalSamplesReceived: 96_000 }),
          video({
            bytesReceived: 450_000,
            framesDecoded: 150,
            freezeCount: 1,
            totalFreezesDurationSec: 0.6,
          }),
        ],
        {
          outboundVideo: [
            layer({ bytesSent: 875_000, frameHeight: 720, bandwidthLimitedSec: 2 }),
          ],
          outboundProfile: "standard",
        },
      ),
      15_000,
    );

    state("reconnecting", 20_000);
    state("connecting", 21_000);
    state("joined", 23_000);
    state("error", 30_000);
    state("reconnecting", 31_000);
    state("joined", 34_000);
    state("disconnected", 61_000);

    expect(named("call_summary")).toEqual([
      {
        name: "call_summary",
        immediate: false,
        props: {
          call_id: "call-1",
          join_mode: "meeting",
          end_reason: "left",
          duration_ms: 60_000,
          peak_participants: 5,
          waited: false,
          first_remote_audio_ms: null,
          first_remote_video_ms: 10_000,
          reconnect_count: 2,
          reconnect_total_ms: 7000,
          reconnect_longest_ms: 4000,
          reconnect_unrecovered: false,
          remote_video_ms: 10_000,
          video_freeze_count: 1,
          video_freeze_ms: 600,
          video_stall_count: 1,
          video_stall_ms: 5000,
          audio_concealed_pct: 0.5,
          outbound_video_ms: 10_000,
          outbound_low_ms: 5000,
          outbound_standard_ms: 5000,
          outbound_profile_switches: 1,
          outbound_video_kbps: 700,
          outbound_video_height: 180,
          outbound_cpu_limited_pct: 0,
          outbound_bandwidth_limited_pct: 20,
        },
      },
    ]);
  });

  it("counts a consumer swapped between samples once", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);

    tracker.onStats(sample([video({ id: "recv:v1" })]), 2000);
    tracker.onStats(
      sample([video({ id: "recv:v1", bytesReceived: 90_000, framesDecoded: 60 })]),
      7000,
    );
    tracker.onStats(
      sample([video({ id: "recv:v2", bytesReceived: 60_000, framesDecoded: 40 })]),
      12_000,
    );
    tracker.onStats(
      sample([video({ id: "recv:v2", bytesReceived: 60_000, framesDecoded: 40 })]),
      17_000,
    );
    state("disconnected", 18_000);

    expect(named("call_summary")[0].props.remote_video_ms).toBe(10_000);
  });

  it("sends the summary with sendBeacon when the tab closes mid-reconnect", () => {
    const { state, tracker, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 10_000);
    tracker.onPageHidden(16_000);

    const [summary] = named("call_summary");
    expect(summary.immediate).toBe(true);
    expect(summary.props).toMatchObject({
      end_reason: "reconnect_abandoned",
      reconnect_count: 1,
      reconnect_total_ms: 6000,
      reconnect_unrecovered: true,
    });
  });

  it("reports the real reconnect time when the tab closes during retry backoff", () => {
    const { state, tracker, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000);
    state("error", 7000);
    state("reconnecting", 9000);
    tracker.onPageHidden(25_000);

    expect(named("call_summary")).toHaveLength(1);
    expect(named("call_summary")[0]).toMatchObject({
      immediate: true,
      props: {
        end_reason: "reconnect_abandoned",
        duration_ms: 24_000,
        reconnect_count: 1,
        reconnect_total_ms: 20_000,
        reconnect_longest_ms: 20_000,
        reconnect_unrecovered: true,
      },
    });
  });

  it("counts a background reconnect while the UI stays joined", () => {
    const { state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    // A hidden tab reconnects without leaving joined; only the socket says so.
    state("joined", 5000, null, false, true);
    state("joined", 9000);
    state("disconnected", 20_000);

    expect(named("call_summary")[0].props).toMatchObject({
      end_reason: "left",
      reconnect_count: 1,
      reconnect_total_ms: 4000,
      reconnect_unrecovered: false,
    });
  });

  it.each([
    ["in the background", "joined"],
    ["in the foreground", "reconnecting"],
  ] as const)("reports a pagehide during the first backoff %s as an abandoned reconnect", (_where, uiState) => {
    const { state, tracker, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state(uiState, 5000, null, false, true);
    tracker.onPageHidden(8000);

    expect(named("call_summary")[0]).toMatchObject({
      immediate: true,
      props: {
        end_reason: "reconnect_abandoned",
        reconnect_count: 1,
        reconnect_total_ms: 3000,
        reconnect_unrecovered: true,
      },
    });
  });

  it("sends the summary the moment reconnecting gives up", () => {
    const { state, named, events } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000);
    state("error", 40_000, null, true);

    expect(named("call_summary")).toHaveLength(1);
    expect(named("call_summary")[0]).toMatchObject({
      immediate: false,
      props: {
        end_reason: "reconnect_failed",
        duration_ms: 39_000,
        reconnect_count: 1,
        reconnect_total_ms: 35_000,
        reconnect_unrecovered: true,
      },
    });

    state("disconnected", 60_000);
    expect(named("call_summary")).toHaveLength(1);
    expect(events.map((event) => event.name)).toEqual(["call_join", "call_summary"]);
  });

  it("times a retry after a give-up from the tap, even before it reaches joining", () => {
    const { state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000, null, false, true);
    state("error", 40_000, null, true);
    // Try again: the socket is still up, so the retry waits for media and
    // goes straight from reconnecting to joining.
    state("reconnecting", 50_000, null, false, true);
    state("joining", 53_000, null, false, true);
    state("joined", 54_000);

    expect(named("call_join").map(({ props }) => [props.call_id, props.outcome, props.join_ms])).toEqual([
      ["call-1", "joined", 1000],
      ["call-2", "joined", 4000],
    ]);
  });

  it("reports a retry that fails before it reaches joining", () => {
    const { state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000, null, false, true);
    state("error", 40_000, null, true);
    state("reconnecting", 50_000, null, false, true);
    state("error", 52_000, {
      code: "CONNECTION_FAILED",
      message: "Failed to connect to server",
      recoverable: true,
      reason: "timeout",
    }, true);

    expect(named("call_join").map(({ props }) => [props.outcome, props.failure_reason, props.join_ms])).toEqual([
      ["joined", null, 1000],
      ["failed", "timeout", 2000],
    ]);
  });

  it("counts a manual retry after giving up as a new call", () => {
    const { state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000);
    state("error", 40_000, null, true);
    state("reconnecting", 50_000);
    state("connecting", 50_100);
    state("joined", 51_000);
    state("disconnected", 61_000);

    expect(named("call_join").map((event) => event.props.call_id)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(named("call_summary").map((event) => event.props.duration_ms)).toEqual([
      39_000,
      10_000,
    ]);
  });

  it("keeps one call and measures from the drop through a reconnect error that recovers", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([video({ id: "recv:v1" })]), 2000);
    tracker.onStats(sample([video({ id: "recv:v1", bytesReceived: 100_000, framesDecoded: 150 })]), 7000);
    state("reconnecting", 8000);
    state("error", 9000);
    tracker.onStats(sample([]), 12_000);
    state("reconnecting", 12_500);
    state("joined", 14_000);
    tracker.onStats(sample([video({ id: "recv2:v1", bytesReceived: 90_000, framesDecoded: 120 })]), 17_000);
    state("disconnected", 18_000);

    expect(named("call_join")).toHaveLength(1);
    expect(named("call_summary")).toHaveLength(1);
    expect(named("call_summary")[0].props).toMatchObject({
      end_reason: "left",
      duration_ms: 17_000,
      reconnect_count: 1,
      reconnect_total_ms: 6000,
      reconnect_unrecovered: false,
      remote_video_ms: 10_000,
    });
  });

  it("calls leaving during a reconnect an abandoned reconnect", () => {
    const { state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000);
    state("disconnected", 9000);

    expect(named("call_summary")[0].props).toMatchObject({
      end_reason: "reconnect_abandoned",
      reconnect_total_ms: 4000,
      reconnect_unrecovered: true,
    });
  });

  it("counts only freezes after the first sample, even when it came before joined", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joining", 400);
    tracker.onStats(
      sample([video({ bytesReceived: 100_000, framesDecoded: 100, freezeCount: 3, totalFreezesDurationSec: 1.5 })]),
      2000,
    );
    state("joined", 5000);
    tracker.onStats(
      sample([video({ bytesReceived: 110_000, framesDecoded: 110, freezeCount: 3, totalFreezesDurationSec: 1.5 })]),
      5250,
    );
    tracker.onStats(
      sample([video({ bytesReceived: 260_000, framesDecoded: 260, freezeCount: 4, totalFreezesDurationSec: 1.8 })]),
      10_250,
    );
    state("disconnected", 11_000);

    expect(named("call_summary")[0].props).toMatchObject({
      video_freeze_count: 1,
      video_freeze_ms: 300,
    });
  });

  it("charges nothing from before joined to a call", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    tracker.onStats(
      sample([video({ bytesReceived: 1000, framesDecoded: 10 })], { outboundVideo: [layer()] }),
      0,
    );
    state("joined", 4800);
    tracker.onStats(
      sample([video({ bytesReceived: 500_000, framesDecoded: 300, freezeCount: 2, totalFreezesDurationSec: 4 })], {
        outboundVideo: [layer({ bytesSent: 400_000, cpuLimitedSec: 4.8 })],
      }),
      4850,
    );
    state("disconnected", 5000);

    expect(named("call_summary")[0].props).toMatchObject({
      duration_ms: 200,
      remote_video_ms: 0,
      video_freeze_count: 0,
      video_freeze_ms: 0,
      outbound_video_ms: 0,
      outbound_cpu_limited_pct: null,
    });
  });

  it("takes the first sample of a call as the baseline, not as a delta from zero", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(
      sample([audio({ packetsReceived: 50, concealedSamples: 4800, totalSamplesReceived: 9600 })]),
      1250,
    );
    tracker.onStats(
      sample([audio({ packetsReceived: 300, concealedSamples: 4800, totalSamplesReceived: 249_600 })]),
      6250,
    );
    state("disconnected", 7000);

    expect(named("call_summary")[0].props.audio_concealed_pct).toBe(0);
  });

  it("measures the sample after a failed read over the whole interval", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([], { outboundVideo: [layer()] }), 2000);
    tracker.onStats(sample([], { outboundVideo: null }), 7000);
    tracker.onStats(
      sample([], {
        outboundVideo: [layer({ bytesSent: 1_000_000, cpuLimitedSec: 10 })],
      }),
      12_000,
    );
    state("disconnected", 13_000);

    expect(named("call_summary")[0].props).toMatchObject({
      outbound_video_ms: 10_000,
      outbound_video_kbps: 800,
      outbound_cpu_limited_pct: 100,
    });
  });

  it("takes a layer that returns after a gap as a new baseline, so no share passes 100%", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    const limited = (id: string, sec: number, bytesSent: number) =>
      layer({ id, bytesSent, cpuLimitedSec: sec, bandwidthLimitedSec: sec });
    tracker.onStats(sample([], { outboundVideo: [limited("send:L1", 0, 0), limited("send:L2", 0, 0)] }), 1000);
    tracker.onStats(sample([], { outboundVideo: [limited("send:L1", 5, 50_000)] }), 6000);
    tracker.onStats(sample([], { outboundVideo: [limited("send:L1", 10, 100_000)] }), 11_000);
    tracker.onStats(
      sample([], { outboundVideo: [limited("send:L1", 15, 150_000), limited("send:L2", 15, 150_000)] }),
      16_000,
    );
    tracker.onStats(
      sample([], { outboundVideo: [limited("send:L1", 20, 200_000), limited("send:L2", 20, 200_000)] }),
      21_000,
    );
    state("disconnected", 22_000);

    expect(named("call_summary")[0].props).toMatchObject({
      outbound_video_ms: 20_000,
      outbound_video_kbps: 100,
      outbound_cpu_limited_pct: 100,
      outbound_bandwidth_limited_pct: 100,
    });
  });

  it.each(["cpuLimitedSec", "bandwidthLimitedSec"] as const)(
    "keeps %s within the send time over 15 s when a layer misses two samples",
    (counter) => {
      const { tracker, state, named } = setup();
      state("connecting", 0);
      state("joined", 1000);
      const limited = (id: string, sec: number, bytesSent: number) =>
        layer({ id, bytesSent, [counter]: sec });
      tracker.onStats(sample([], { outboundVideo: [limited("send:L1", 0, 0), limited("send:L2", 0, 0)] }), 1000);
      tracker.onStats(sample([], { outboundVideo: [limited("send:L1", 5, 50_000)] }), 6000);
      tracker.onStats(sample([], { outboundVideo: [limited("send:L1", 10, 100_000)] }), 11_000);
      tracker.onStats(
        sample([], { outboundVideo: [limited("send:L1", 15, 150_000), limited("send:L2", 15, 150_000)] }),
        16_000,
      );
      state("disconnected", 17_000);

      const { props } = named("call_summary")[0];
      expect(props.outbound_video_ms).toBe(15_000);
      expect({
        cpu: props.outbound_cpu_limited_pct,
        bandwidth: props.outbound_bandwidth_limited_pct,
      }).toEqual(counter === "cpuLimitedSec" ? { cpu: 100, bandwidth: 0 } : { cpu: 0, bandwidth: 100 });
    },
  );

  it("never counts more limited time than the interval it falls in", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([], { outboundVideo: [layer()] }), 1000);
    tracker.onStats(
      sample([], { outboundVideo: [layer({ bytesSent: 500_000, cpuLimitedSec: 5.2, bandwidthLimitedSec: 5.1 })] }),
      6000,
    );
    state("disconnected", 7000);

    const { props } = named("call_summary")[0];
    expect(props.outbound_cpu_limited_pct).toBe(100);
    expect(props.outbound_bandwidth_limited_pct).toBe(100);
  });

  it("drops a sample gap too long to measure instead of inflating rates", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([video()], { outboundVideo: [layer()] }), 2000);
    tracker.onStats(
      sample([video({ bytesReceived: 900_000, framesDecoded: 1800 })], {
        outboundVideo: [layer({ bytesSent: 6_000_000, cpuLimitedSec: 60 })],
      }),
      62_000,
    );
    tracker.onStats(
      sample([video({ bytesReceived: 1_000_000, framesDecoded: 1950 })], {
        outboundVideo: [layer({ bytesSent: 6_500_000, cpuLimitedSec: 60 })],
      }),
      67_000,
    );
    state("disconnected", 68_000);

    expect(named("call_summary")[0].props).toMatchObject({
      remote_video_ms: 5000,
      outbound_video_ms: 5000,
      outbound_video_kbps: 800,
      outbound_cpu_limited_pct: 0,
    });
  });

  it("does not double count after a sample whose stats could not be read", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    const frozenOnce = video({
      bytesReceived: 200_000,
      framesDecoded: 100,
      freezeCount: 1,
      totalFreezesDurationSec: 0.4,
    });

    tracker.onStats(sample([video()], { outboundVideo: [layer()] }), 2000);
    tracker.onStats(
      sample([frozenOnce], { outboundVideo: [layer({ bytesSent: 500_000 })] }),
      7000,
    );
    tracker.onStats(sample(null, { outboundVideo: null }), 12_000);
    tracker.onStats(
      sample([frozenOnce], { outboundVideo: [layer({ bytesSent: 500_000 })] }),
      17_000,
    );
    state("disconnected", 18_000);

    expect(named("call_summary")[0].props).toMatchObject({
      video_freeze_count: 1,
      video_freeze_ms: 400,
      outbound_video_ms: 5000,
      outbound_video_kbps: 800,
    });
  });

  it("does not re-count a layer that drops out of one report and comes back", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    const low = (bytesSent: number) => layer({ id: "send:L0", bytesSent });
    const high = (bytesSent: number) => layer({ id: "send:L2", bytesSent, frameHeight: 720 });

    tracker.onStats(sample([], { outboundVideo: [low(0), high(0)] }), 2000);
    tracker.onStats(sample([], { outboundVideo: [low(100_000), high(500_000)] }), 7000);
    tracker.onStats(sample([], { outboundVideo: [low(200_000)] }), 12_000);
    tracker.onStats(sample([], { outboundVideo: [low(300_000), high(600_000)] }), 17_000);
    state("disconnected", 18_000);

    // The high layer's first reading back is a baseline: what it sent while
    // missing from the report is left out, never counted from zero.
    expect(named("call_summary")[0].props).toMatchObject({
      outbound_video_ms: 15_000,
      outbound_video_kbps: 427,
    });
  });

  it("keeps outbound bitrate right when a simulcast layer stops", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    const low = (bytesSent: number) => layer({ id: "send:L0", bytesSent, frameHeight: 180 });
    const high = (bytesSent: number) => layer({ id: "send:L2", bytesSent, frameHeight: 720 });

    tracker.onStats(sample([], { outboundVideo: [low(0), high(0)] }), 2000);
    tracker.onStats(sample([], { outboundVideo: [low(100_000), high(500_000)] }), 7000);
    tracker.onStats(sample([], { outboundVideo: [low(200_000)] }), 12_000);
    state("disconnected", 13_000);

    expect(named("call_summary")[0].props).toMatchObject({
      outbound_video_ms: 10_000,
      outbound_video_kbps: 560,
    });
  });

  it("keeps a long 12-person call to three events per client", () => {
    const { tracker, state, events } = setup();
    tracker.onParticipants(12, 0);
    state("connecting", 0);
    state("joined", 1000);

    const streams = (step: number) =>
      Array.from({ length: 11 }, (_, index) => [
        audio({
          id: `recv:a${index}`,
          packetsReceived: 50 * step,
          totalSamplesReceived: 240_000 * step,
        }),
        video({
          id: `recv:v${index}`,
          bytesReceived: 300_000 * step,
          framesDecoded: 150 * step,
        }),
      ]).flat();
    for (let step = 1; step <= 720; step += 1) {
      tracker.onStats(sample(streams(step)), 1000 + step * STEADY_SAMPLE_MS);
    }
    state("disconnected", 1000 + 3_600_000);

    expect(events.map((event) => event.name)).toEqual([
      "call_join",
      "call_first_media",
      "call_summary",
    ]);
  });
});

describe("parseCallStats", () => {
  it("reads inbound streams and outbound layers and skips the mediasoup probator", () => {
    const receive = new Map<string, unknown>([
      ["a", { type: "inbound-rtp", id: "IA1", kind: "audio", packetsReceived: 9, bytesReceived: 900, concealedSamples: 3, totalSamplesReceived: 960 }],
      ["v", { type: "inbound-rtp", id: "IV1", kind: "video", packetsReceived: 20, bytesReceived: 20_000, framesDecoded: 30, freezeCount: 2, totalFreezesDuration: 1.25 }],
      ["c", { type: "candidate-pair", id: "CP1", bytesReceived: 1 }],
      ["p", { type: "inbound-rtp", id: "IT01V1234", kind: "video", mid: "probator", bytesReceived: 76_100, framesDecoded: 0 }],
    ]);
    const camera = new Map<string, unknown>([
      ["l", { type: "outbound-rtp", id: "OT0", kind: "video", bytesSent: 1000, frameHeight: 180, qualityLimitationDurations: { cpu: 0, bandwidth: 4, none: 10 } }],
      ["h", { type: "outbound-rtp", id: "OT2", kind: "video", bytesSent: 5000, frameHeight: 720, qualityLimitationDurations: { cpu: 1, bandwidth: 4, none: 9 } }],
      ["m", { type: "outbound-rtp", id: "OA", kind: "audio", bytesSent: 800 }],
    ]);

    expect(
      parseCallStats({
        receive: { sourceId: "recv", report: receive },
        camera: { sourceId: "send", report: camera },
        profile: "standard",
      }),
    ).toEqual({
      inbound: [
        {
          id: "recv:IA1",
          kind: "audio",
          packetsReceived: 9,
          bytesReceived: 900,
          framesDecoded: 0,
                  freezeCount: null,
          totalFreezesDurationSec: null,
          concealedSamples: 3,
          totalSamplesReceived: 960,
        },
        {
          id: "recv:IV1",
          kind: "video",
          packetsReceived: 20,
          bytesReceived: 20_000,
          framesDecoded: 30,
          freezeCount: 2,
          totalFreezesDurationSec: 1.25,
          concealedSamples: null,
          totalSamplesReceived: null,
        },
      ],
      outboundVideo: [
        { id: "send:OT0", bytesSent: 1000, frameHeight: 180, cpuLimitedSec: 0, bandwidthLimitedSec: 4 },
        { id: "send:OT2", bytesSent: 5000, frameHeight: 720, cpuLimitedSec: 1, bandwidthLimitedSec: 4 },
      ],
      outboundProfile: "standard",
    });
  });
});

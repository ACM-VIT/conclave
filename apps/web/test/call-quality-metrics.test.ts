import { describe, expect, it } from "vitest";
import {
  createCallMetricsTracker,
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
  ) =>
    tracker.onConnectionState(
      { state: next, error, joinMode: "meeting", reconnectGaveUp },
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
    const { state, named } = setup();

    state("connecting", 1000);
    state("joining", 1400);
    state("waiting", 1500);
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
          waiting_ms: 8500,
          join_mode: "meeting",
          prior_failed_attempts: 0,
        },
      },
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
      end_reason: "page_closed",
      reconnect_count: 1,
      reconnect_total_ms: 6000,
      reconnect_unrecovered: true,
    });
  });

  it("ends a call that gave up reconnecting when it gave up, not when the tab closed", () => {
    const { state, tracker, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000);
    state("error", 12_000);
    state("reconnecting", 13_000);
    state("error", 40_000);
    tracker.onPageHidden(300_000);

    expect(named("call_summary")[0].props).toMatchObject({
      end_reason: "reconnect_failed",
      duration_ms: 39_000,
      reconnect_count: 1,
      reconnect_total_ms: 35_000,
      reconnect_unrecovered: true,
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

  it("stops media totals where a call stuck in error ended", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([video()], { outboundVideo: [layer()] }), 2000);
    tracker.onStats(
      sample([video({ bytesReceived: 100_000, framesDecoded: 150 })], {
        outboundVideo: [layer({ bytesSent: 500_000 })],
      }),
      7000,
    );
    state("error", 8000);
    tracker.onStats(
      sample([video({ bytesReceived: 200_000, framesDecoded: 300 })], {
        outboundVideo: [layer({ bytesSent: 1_000_000 })],
      }),
      12_000,
    );
    tracker.onPageHidden(20_000);

    expect(named("call_summary")[0].props).toMatchObject({
      end_reason: "reconnect_failed",
      duration_ms: 7000,
      remote_video_ms: 5000,
      outbound_video_ms: 5000,
    });
  });

  it("measures again once a call stuck in error recovers", () => {
    const { tracker, state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    tracker.onStats(sample([video()]), 2000);
    tracker.onStats(sample([video({ bytesReceived: 100_000, framesDecoded: 150 })]), 7000);
    state("error", 8000);
    tracker.onStats(sample([video({ bytesReceived: 200_000, framesDecoded: 300 })]), 12_000);
    state("reconnecting", 13_000);
    state("joined", 14_000);
    tracker.onStats(sample([video({ bytesReceived: 300_000, framesDecoded: 450 })]), 17_000);
    state("disconnected", 18_000);

    expect(named("call_summary")[0].props).toMatchObject({
      end_reason: "left",
      remote_video_ms: 10_000,
    });
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

    expect(named("call_summary")[0].props).toMatchObject({
      outbound_video_ms: 15_000,
      outbound_video_kbps: 480,
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
    const send = new Map<string, unknown>([
      ["l", { type: "outbound-rtp", id: "OT0", kind: "video", bytesSent: 1000, frameHeight: 180, qualityLimitationDurations: { cpu: 0, bandwidth: 4, none: 10 } }],
      ["h", { type: "outbound-rtp", id: "OT2", kind: "video", bytesSent: 5000, frameHeight: 720, qualityLimitationDurations: { cpu: 1, bandwidth: 4, none: 9 } }],
      ["m", { type: "outbound-rtp", id: "OA", kind: "audio", bytesSent: 800 }],
    ]);

    expect(
      parseCallStats({
        receive: { transportId: "recv", report: receive },
        send: { transportId: "send", report: send },
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

import { describe, expect, it } from "vitest";
import {
  createCallMetricsTracker,
  parseCallStats,
  STEADY_SAMPLE_MS,
  type CallMetricEvent,
  type CallStatsSample,
  type InboundStreamStats,
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
  ) => tracker.onConnectionState(next, error, "meeting", at);
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

const sample = (
  inbound: InboundStreamStats[],
  outbound: Partial<CallStatsSample> = {},
): CallStatsSample => ({
  inbound,
  outboundVideo: null,
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
        outboundVideo: { bytesSent: 0, frameHeight: 180, limitedSec: { cpu: 0, bandwidth: 0 } },
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
          outboundVideo: { bytesSent: 250_000, frameHeight: 180, limitedSec: { cpu: 0, bandwidth: 2 } },
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
          outboundVideo: { bytesSent: 875_000, frameHeight: 720, limitedSec: { cpu: 0, bandwidth: 2 } },
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

  it("calls a call that never came back from a reconnect a failed reconnect", () => {
    const { state, named } = setup();
    state("connecting", 0);
    state("joined", 1000);
    state("reconnecting", 5000);
    state("error", 40_000);
    state("disconnected", 45_000);

    expect(named("call_summary")[0].props.end_reason).toBe("reconnect_failed");
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
  it("reads inbound streams and folds simulcast layers into one outbound entry", () => {
    const receive = new Map<string, unknown>([
      ["a", { type: "inbound-rtp", id: "IA1", kind: "audio", packetsReceived: 9, bytesReceived: 900, concealedSamples: 3, totalSamplesReceived: 960 }],
      ["v", { type: "inbound-rtp", id: "IV1", kind: "video", packetsReceived: 20, bytesReceived: 20_000, framesDecoded: 30, freezeCount: 2, totalFreezesDuration: 1.25 }],
      ["c", { type: "candidate-pair", id: "CP1", bytesReceived: 1 }],
    ]);
    const send = new Map<string, unknown>([
      ["l", { type: "outbound-rtp", kind: "video", bytesSent: 1000, frameHeight: 180, qualityLimitationDurations: { cpu: 0, bandwidth: 4, none: 10 } }],
      ["h", { type: "outbound-rtp", kind: "video", bytesSent: 5000, frameHeight: 720, qualityLimitationDurations: { cpu: 1, bandwidth: 4, none: 9 } }],
      ["m", { type: "outbound-rtp", kind: "audio", bytesSent: 800 }],
    ]);

    expect(
      parseCallStats({
        receive: { transportId: "recv", report: receive },
        send,
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
      outboundVideo: {
        bytesSent: 6000,
        frameHeight: 720,
        limitedSec: { cpu: 1, bandwidth: 4 },
      },
      outboundProfile: "standard",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  INITIAL_MEDIA_PATH_WATCH,
  MEDIA_PATH_STALL_MS,
  advanceMediaPathWatch,
  HEALTHY_MEDIA_PATHS,
  advanceMediaPathHealth,
  blockedMediaDirections,
  judgeReceiveRebuild,
  planSilentPathStep,
  planMediaPathEscalation,
  readRtpBytes,
  type MediaPathSample,
  type MediaPathWatch,
} from "../src/app/lib/media-path-recovery";

const sample = (overrides: Partial<MediaPathSample>): MediaPathSample => ({
  at: 0,
  connectionState: "connected",
  expectsMedia: true,
  rtpBytes: 0,
  ...overrides,
});

const run = (samples: Partial<MediaPathSample>[]) => {
  let watch: MediaPathWatch = INITIAL_MEDIA_PATH_WATCH;
  return samples.map((next) => {
    const result = advanceMediaPathWatch(watch, sample(next));
    watch = result.watch;
    return { condition: result.condition, stalledForMs: result.stalledForMs };
  });
};

describe("reading RTP bytes from a stats report", () => {
  const stats = [
    { type: "outbound-rtp", bytesSent: 1_000 },
    { type: "outbound-rtp", bytesSent: 250 },
    { type: "inbound-rtp", bytesReceived: 70 },
    { type: "candidate-pair", bytesSent: 9_999, bytesReceived: 9_999 },
    { type: "remote-inbound-rtp" },
  ];

  it("counts only what this transport sends or receives as media", () => {
    expect(readRtpBytes(stats, "send")).toBe(1_250);
    expect(readRtpBytes(stats, "recv")).toBe(70);
  });

  it("reads zero from an empty report", () => {
    expect(readRtpBytes([], "send")).toBe(0);
  });
});

describe("watching a transport for media", () => {
  it("is healthy while it is connected and bytes keep moving", () => {
    expect(
      run([
        { at: 0, rtpBytes: 100 },
        { at: 2_500, rtpBytes: 900 },
        { at: 5_000, rtpBytes: 1_800 },
      ]),
    ).toEqual([
      { condition: "flowing", stalledForMs: 0 },
      { condition: "flowing", stalledForMs: 0 },
      { condition: "flowing", stalledForMs: 0 },
    ]);
  });

  it("times a transport that never connects", () => {
    const results = run([
      { at: 0, connectionState: "connecting" },
      { at: 10_000, connectionState: "connecting" },
      { at: MEDIA_PATH_STALL_MS, connectionState: "failed" },
    ]);

    expect(results.map((result) => result.condition)).toEqual([
      "not-connected",
      "not-connected",
      "not-connected",
    ]);
    expect(results.at(-1)?.stalledForMs).toBe(MEDIA_PATH_STALL_MS);
  });

  it("times a connected transport whose media stopped moving", () => {
    expect(
      run([
        { at: 0, rtpBytes: 5_000 },
        { at: 2_500, rtpBytes: 5_000 },
        { at: 17_500, rtpBytes: 5_000 },
      ]),
    ).toEqual([
      { condition: "flowing", stalledForMs: 0 },
      { condition: "connected-without-media", stalledForMs: 0 },
      { condition: "connected-without-media", stalledForMs: 15_000 },
    ]);
  });

  it("gives a transport that just connected a fresh window to show media", () => {
    expect(
      run([
        { at: 0, connectionState: "connecting" },
        { at: 5_000, connectionState: "connected", rtpBytes: 0 },
        { at: 7_500, connectionState: "connected", rtpBytes: 0 },
        { at: 10_000, connectionState: "connected", rtpBytes: 0 },
      ]),
    ).toEqual([
      { condition: "not-connected", stalledForMs: 0 },
      { condition: "flowing", stalledForMs: 0 },
      { condition: "connected-without-media", stalledForMs: 0 },
      { condition: "connected-without-media", stalledForMs: 2_500 },
    ]);
  });

  it("starts over once media moves again", () => {
    const results = run([
      { at: 0, connectionState: "connecting" },
      { at: 12_000, connectionState: "connected", rtpBytes: 10 },
      { at: 14_500, connectionState: "connected", rtpBytes: 900 },
      { at: 17_000, connectionState: "disconnected" },
    ]);

    expect(results.map((result) => result.stalledForMs)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(results.at(-1)?.condition).toBe("not-connected");
  });

  it("does not judge a transport that has nothing to carry", () => {
    expect(
      run([
        { at: 0, connectionState: "new", expectsMedia: false },
        { at: 60_000, connectionState: "new", expectsMedia: false },
        { at: 62_500, connectionState: "connecting", expectsMedia: true },
      ]),
    ).toEqual([
      { condition: "idle", stalledForMs: 0 },
      { condition: "idle", stalledForMs: 0 },
      { condition: "not-connected", stalledForMs: 0 },
    ]);
  });
});

describe("escalating when an ICE restart did not help", () => {
  it("rebuilds through TURN alone when TURN is configured", () => {
    expect(
      planMediaPathEscalation({
        hasReconnected: false,
        relayOnly: false,
        hasTurnServers: true,
        reconnectInFlight: false,
      }),
    ).toBe("reconnect-relay-only");
  });

  it.each([
    { relayOnly: false, hasTurnServers: true },
    { relayOnly: false, hasTurnServers: false },
    { relayOnly: true, hasTurnServers: true },
  ])("waits for a rejoin in progress rather than dropping the rebuild: %o", (state) => {
    expect(
      planMediaPathEscalation({
        hasReconnected: false,
        reconnectInFlight: true,
        ...state,
      }),
    ).toBe("wait-for-reconnect");
  });

  it("reports a blocked path at once, even while a rejoin is running", () => {
    expect(
      planMediaPathEscalation({
        hasReconnected: true,
        relayOnly: true,
        hasTurnServers: true,
        reconnectInFlight: true,
      }),
    ).toBe("report-blocked");
  });

  it("rebuilds once without TURN", () => {
    expect(
      planMediaPathEscalation({
        hasReconnected: false,
        relayOnly: false,
        hasTurnServers: false,
        reconnectInFlight: false,
      }),
    ).toBe("reconnect");
  });

  it.each([
    { relayOnly: true, hasTurnServers: true },
    { relayOnly: false, hasTurnServers: false },
    { relayOnly: false, hasTurnServers: true },
  ])("tells the user once a rebuild has also failed: %o", (state) => {
    expect(
      planMediaPathEscalation({
        hasReconnected: true,
        reconnectInFlight: false,
        ...state,
      }),
    ).toBe("report-blocked");
  });
});

describe("judging a rebuilt receive path", () => {
  const listed = { listed: true as const, producers: [{ producerId: "p1" }] };

  it("counts it as rebuilt only once the producer list arrived on a live socket", () => {
    expect(
      judgeReceiveRebuild({ list: listed, socketStillConnected: true, transportOpen: true }),
    ).toEqual({ rebuilt: true });
  });

  it("is not rebuilt when the producer list never arrived", () => {
    expect(
      judgeReceiveRebuild({
        list: { listed: false, reason: "signaling dropped before the list arrived" },
        socketStillConnected: true,
        transportOpen: true,
      }),
    ).toEqual({ rebuilt: false, reason: "signaling dropped before the list arrived" });
  });

  it("is not rebuilt when signaling dropped, even with a list", () => {
    expect(
      judgeReceiveRebuild({ list: listed, socketStillConnected: false, transportOpen: true }).rebuilt,
    ).toBe(false);
  });

  it("is not rebuilt when the new transport closed", () => {
    expect(
      judgeReceiveRebuild({ list: listed, socketStillConnected: true, transportOpen: false }).rebuilt,
    ).toBe(false);
  });
});

describe("per-direction media health", () => {
  const blockedReceive = advanceMediaPathHealth(HEALTHY_MEDIA_PATHS, {
    type: "blocked",
    direction: "consumer",
  });

  it("stays blocked through new trouble and other rebuilds", () => {
    let health = advanceMediaPathHealth(blockedReceive, { type: "trouble", direction: "consumer" });
    health = advanceMediaPathHealth(health, { type: "trouble", direction: "producer" });

    expect(health).toEqual({ producer: "recovering", consumer: "blocked" });
  });

  it("is cleared for a direction only when media flows in that direction", () => {
    const sendFlowing = advanceMediaPathHealth(blockedReceive, {
      type: "media-flowing",
      direction: "producer",
    });
    expect(sendFlowing.consumer).toBe("blocked");

    expect(
      advanceMediaPathHealth(sendFlowing, { type: "media-flowing", direction: "consumer" }),
    ).toEqual(HEALTHY_MEDIA_PATHS);
  });

  it("starts fresh for a new join", () => {
    expect(advanceMediaPathHealth(blockedReceive, { type: "reset" })).toEqual(HEALTHY_MEDIA_PATHS);
  });

  it("lists the blocked directions", () => {
    expect(blockedMediaDirections(blockedReceive)).toEqual(["consumer"]);
    expect(blockedMediaDirections(HEALTHY_MEDIA_PATHS)).toEqual([]);
  });
});

describe("a stall while the transport says connected", () => {
  it("escalates the receive path when the remote side is still sending", () => {
    expect(
      planSilentPathStep({ direction: "consumer", expectedProducerScores: [10, null] }),
    ).toBe("escalate");
  });

  it("escalates the send path", () => {
    expect(planSilentPathStep({ direction: "producer", expectedProducerScores: [] })).toBe(
      "escalate",
    );
  });

  it("does not blame this network when every expected sender reports no media", () => {
    expect(
      planSilentPathStep({ direction: "consumer", expectedProducerScores: [0, 0] }),
    ).toBe("remote-not-sending");
  });
});

describe("knowing that media moved", () => {
  it("needs bytes to grow between two connected samples", () => {
    const first = advanceMediaPathWatch(INITIAL_MEDIA_PATH_WATCH, sample({ at: 0, rtpBytes: 100 }));
    expect(first.mediaMoved).toBe(false);
    expect(advanceMediaPathWatch(first.watch, sample({ at: 1, rtpBytes: 100 })).mediaMoved).toBe(false);
    expect(advanceMediaPathWatch(first.watch, sample({ at: 1, rtpBytes: 250 })).mediaMoved).toBe(true);
  });
});

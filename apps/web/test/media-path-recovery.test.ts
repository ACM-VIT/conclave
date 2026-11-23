import { describe, expect, it } from "vitest";
import {
  INITIAL_MEDIA_PATH_WATCH,
  MEDIA_PATH_STALL_MS,
  advanceMediaPathWatch,
  HEALTHY_MEDIA_PATHS,
  INITIAL_MEDIA_PATH_RECOVERY,
  advanceMediaPathRecovery,
  blockedMediaDirections,
  judgeReceiveRebuild,
  planMediaPathFailure,
  planSilentPathStep,
  planMediaPathEscalation,
  readMediaPathHealth,
  receivePathExpectsMedia,
  type ConsumedStream,
  readRtpBytes,
  resolveRebuildRelayOnly,
  takeDeferredRebuilds,
  type MediaPathFailure,
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
  it("asks for TURN alone on the first rebuild, before the refresh says whether TURN is there", () => {
    expect(
      planMediaPathEscalation({
        hasReconnected: false,
        relayOnly: false,
        reconnectInFlight: false,
      }),
    ).toBe("reconnect-relay-only");
  });

  it("rebuilds on the same policy when TURN alone is already in use", () => {
    expect(
      planMediaPathEscalation({
        hasReconnected: false,
        relayOnly: true,
        reconnectInFlight: false,
      }),
    ).toBe("reconnect");
  });

  it.each([{ relayOnly: false }, { relayOnly: true }])(
    "waits for a rejoin in progress rather than dropping the rebuild: %o",
    (state) => {
      expect(
        planMediaPathEscalation({
          hasReconnected: false,
          reconnectInFlight: true,
          ...state,
        }),
      ).toBe("wait-for-reconnect");
    },
  );

  it("reports a blocked path at once, even while a rejoin is running", () => {
    expect(
      planMediaPathEscalation({
        hasReconnected: true,
        relayOnly: true,
        reconnectInFlight: true,
      }),
    ).toBe("report-blocked");
  });

  it.each([{ relayOnly: true }, { relayOnly: false }])(
    "tells the user once a rebuild has also failed: %o",
    (state) => {
      expect(
        planMediaPathEscalation({
          hasReconnected: true,
          reconnectInFlight: false,
          ...state,
        }),
      ).toBe("report-blocked");
    },
  );
});

describe("the ICE policy of a rebuild", () => {
  it("uses TURN alone when it was asked for and the current credentials have a relay", () => {
    expect(
      resolveRebuildRelayOnly({ requested: true, relayOnly: false, hasTurnServers: true }),
    ).toBe(true);
  });

  it("stays on every path when the current credentials have no relay", () => {
    expect(
      resolveRebuildRelayOnly({ requested: true, relayOnly: false, hasTurnServers: false }),
    ).toBe(false);
  });

  it("keeps the policy in use when TURN alone was not asked for", () => {
    expect(
      resolveRebuildRelayOnly({ requested: false, relayOnly: true, hasTurnServers: true }),
    ).toBe(true);
    expect(
      resolveRebuildRelayOnly({ requested: false, relayOnly: false, hasTurnServers: true }),
    ).toBe(false);
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

describe("a direction's media path recovery", () => {
  const failure = (
    transportId: string,
    overrides: Partial<MediaPathFailure> = {},
  ): MediaPathFailure => ({
    direction: "consumer",
    transportId,
    reason: "Consumer transport carried no media",
    relayOnly: false,
    reconnectInFlight: false,
    ...overrides,
  });
  const connected = (transportId: string) =>
    ({ type: "transport-connected", direction: "consumer", transportId }) as const;

  // t1 fails, its rebuild t2 connects but carries nothing, so the receive
  // path ends blocked on t2.
  const blockedOnT2 = () => {
    const rebuild = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1"));
    expect(rebuild.step).toBe("reconnect-relay-only");
    const blocked = planMediaPathFailure(
      advanceMediaPathRecovery(rebuild.recovery, connected("t2")),
      failure("t2", { relayOnly: true }),
    );
    expect(blocked.step).toBe("report-blocked");
    expect(readMediaPathHealth(blocked.recovery).consumer).toBe("blocked");
    return blocked.recovery;
  };

  it("starts the ladder again when media resumes on a blocked transport that never reconnected", () => {
    const flowing = advanceMediaPathRecovery(blockedOnT2(), {
      type: "media-flowing",
      direction: "consumer",
    });
    expect(readMediaPathHealth(flowing)).toEqual(HEALTHY_MEDIA_PATHS);

    const rebuildAgain = planMediaPathFailure(flowing, failure("t2", { relayOnly: true }));
    expect(rebuildAgain.step).toBe("reconnect");

    const blockedAgain = planMediaPathFailure(
      advanceMediaPathRecovery(rebuildAgain.recovery, connected("t3")),
      failure("t3", { relayOnly: true }),
    );
    expect(blockedAgain.step).toBe("report-blocked");
    expect(blockedMediaDirections(readMediaPathHealth(blockedAgain.recovery))).toEqual([
      "consumer",
    ]);
  });

  it("resets every part of a direction together once media flows", () => {
    const held = planMediaPathFailure(
      blockedOnT2(),
      failure("t9", { direction: "producer", reconnectInFlight: true }),
    ).recovery;
    expect(
      advanceMediaPathRecovery(held, { type: "media-flowing", direction: "consumer" }),
    ).toEqual({ ...held, consumer: INITIAL_MEDIA_PATH_RECOVERY.consumer });
  });

  it("acts once on a failure that several watchers report", () => {
    const first = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1"));
    const second = planMediaPathFailure(first.recovery, failure("t1"));

    expect(second.step).toBe("already-escalated");
    expect(second.recovery).toBe(first.recovery);
  });

  it("acts on a transport again once it reconnects", () => {
    const reconnected = advanceMediaPathRecovery(blockedOnT2(), connected("t2"));

    expect(planMediaPathFailure(reconnected, failure("t2", { relayOnly: true })).step).toBe(
      "report-blocked",
    );
  });

  it("holds a rebuild asked for during a rejoin, one per direction, until the rejoin settles", () => {
    let recovery = planMediaPathFailure(
      INITIAL_MEDIA_PATH_RECOVERY,
      failure("r1", { reconnectInFlight: true }),
    ).recovery;
    recovery = planMediaPathFailure(
      recovery,
      failure("s1", { direction: "producer", reason: "send failed", reconnectInFlight: true }),
    ).recovery;

    const taken = takeDeferredRebuilds(recovery);
    expect(taken.deferred).toEqual([
      { direction: "producer", transportId: "s1", reason: "send failed" },
      { direction: "consumer", transportId: "r1", reason: "Consumer transport carried no media" },
    ]);
    expect(taken.recovery).toEqual(INITIAL_MEDIA_PATH_RECOVERY);
  });

  it("drops a held rebuild once its transport connects", () => {
    const held = planMediaPathFailure(
      INITIAL_MEDIA_PATH_RECOVERY,
      failure("r1", { reconnectInFlight: true }),
    ).recovery;

    expect(takeDeferredRebuilds(advanceMediaPathRecovery(held, connected("r1"))).deferred).toEqual(
      [],
    );
  });

  it("gives Try again a fresh ladder but keeps the warning until media flows", () => {
    const retried = advanceMediaPathRecovery(blockedOnT2(), { type: "user-retry" });

    expect(readMediaPathHealth(retried).consumer).toBe("blocked");
    expect(planMediaPathFailure(retried, failure("t2", { relayOnly: true })).step).toBe("reconnect");
  });

  it("keeps a rebuild's ladder when the new transport only connects", () => {
    const rebuilt = advanceMediaPathRecovery(
      planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1")).recovery,
      connected("t2"),
    );

    expect(readMediaPathHealth(rebuilt).consumer).toBe("recovering");
    expect(planMediaPathFailure(rebuilt, failure("t2", { relayOnly: true })).step).toBe(
      "report-blocked",
    );
  });

  it("stays blocked through new trouble and other directions' rebuilds", () => {
    let recovery = advanceMediaPathRecovery(blockedOnT2(), {
      type: "trouble",
      direction: "consumer",
    });
    recovery = planMediaPathFailure(recovery, failure("s1", { direction: "producer" })).recovery;

    expect(readMediaPathHealth(recovery)).toEqual({ producer: "recovering", consumer: "blocked" });
  });

  it("is cleared for a direction only when media flows in that direction", () => {
    const sendFlowing = advanceMediaPathRecovery(blockedOnT2(), {
      type: "media-flowing",
      direction: "producer",
    });
    expect(readMediaPathHealth(sendFlowing).consumer).toBe("blocked");
  });

  it("starts fresh for a new join", () => {
    expect(advanceMediaPathRecovery(blockedOnT2(), { type: "reset" })).toEqual(
      INITIAL_MEDIA_PATH_RECOVERY,
    );
  });

  it("lists the blocked directions", () => {
    expect(blockedMediaDirections(readMediaPathHealth(blockedOnT2()))).toEqual(["consumer"]);
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

describe("which received streams should keep media flowing", () => {
  const stream = (
    kind: ConsumedStream["kind"],
    source: ConsumedStream["source"],
    on: boolean,
  ): ConsumedStream => ({ kind, source, consumerPaused: false, producerPaused: !on });
  const table = [false, true].flatMap((micOn) =>
    [false, true].flatMap((cameraOn) =>
      [false, true].map((screenOn) => ({ micOn, cameraOn, screenOn })),
    ),
  );

  it.each(table)(
    "expects media on a connected path when a mic or a camera is on: %o",
    ({ micOn, cameraOn, screenOn }) => {
      const streams = [
        stream("audio", "webcam", micOn),
        stream("video", "webcam", cameraOn),
        stream("video", "screen", screenOn),
        stream("audio", "screen", false),
      ];

      expect(receivePathExpectsMedia(streams, true)).toBe(micOn || cameraOn);
    },
  );

  it("expects media on a path that is not connected whenever it carries any stream", () => {
    expect(receivePathExpectsMedia([stream("video", "screen", false)], false)).toBe(true);
    expect(receivePathExpectsMedia([], false)).toBe(false);
  });

  it("does not expect media from a stream this client paused", () => {
    expect(
      receivePathExpectsMedia(
        [{ kind: "video", source: "webcam", consumerPaused: true, producerPaused: false }],
        true,
      ),
    ).toBe(false);
  });

  it("expects screen share audio, which keeps sending through silence", () => {
    expect(receivePathExpectsMedia([stream("audio", "screen", true)], true)).toBe(true);
  });
});

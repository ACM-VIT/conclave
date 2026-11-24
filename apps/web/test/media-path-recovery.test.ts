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
  describeConsumedStream,
  receivePathExpectsMedia,
  streamShouldFlow,
  type ConsumedStream,
  deliveredRtpBytes,
  iceRestartBroughtMediaBack,
  readMediaPath,
  mediaReachedFarEnd,
  sendPathExpectation,
  type PublishedStream,
  resolveRebuildRelayOnly,
  takeDeferredRebuilds,
  type MediaPathFailure,
  type MediaPathSample,
  type MediaPathWatch,
} from "../src/app/lib/media-path-recovery";
import { icePolicyForOffers, relayProvenByMedia } from "../src/app/lib/relay-credentials";

const sample = (overrides: Partial<MediaPathSample>): MediaPathSample => ({
  at: 0,
  connectionState: "connected",
  expectsMedia: true,
  framesOptional: false,
  direction: "recv",
  rtpBytes: 0,
  receiverReportAt: null,
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

describe("reading a transport's media from a stats report", () => {
  const stats = [
    { type: "outbound-rtp", bytesSent: 1_000 },
    { type: "outbound-rtp", bytesSent: 250 },
    { type: "inbound-rtp", bytesReceived: 70 },
    { type: "candidate-pair", bytesSent: 9_999, bytesReceived: 9_999 },
    { type: "remote-inbound-rtp", timestamp: 1_795_490_306_879 },
    { type: "remote-inbound-rtp", timestamp: 1_795_490_305_778 },
    { type: "remote-inbound-rtp" },
  ];

  it("counts only what this transport sends or receives as media", () => {
    expect(readMediaPath(stats, "send").rtpBytes).toBe(1_250);
    expect(readMediaPath(stats, "recv").rtpBytes).toBe(70);
  });

  it("keeps the newest receiver report the SFU sent about the streams going out", () => {
    expect(readMediaPath(stats, "send").receiverReportAt).toBe(1_795_490_306_879);
    expect(readMediaPath(stats, "recv").receiverReportAt).toBeNull();
  });

  it("reads nothing from an empty report", () => {
    expect(readMediaPath([], "send")).toEqual({
      direction: "send",
      rtpBytes: 0,
      receiverReportAt: null,
    });
  });
});

describe("knowing that sent media reached the SFU", () => {
  const sent = (at: number, rtpBytes: number, receiverReportAt: number | null) =>
    sample({ at, direction: "send", rtpBytes, receiverReportAt });

  it("finds a send path stalled when bytes leave but no receiver report comes back", () => {
    let watch: MediaPathWatch = INITIAL_MEDIA_PATH_WATCH;
    const results = [
      sent(0, 1_000_000, 5_000),
      sent(2_500, 1_074_000, 5_000),
      sent(5_000, 1_148_000, 5_000),
      sent(10_000, 1_296_000, 5_000),
      sent(17_500, 1_296_084, 5_000),
    ].map((next) => {
      const result = advanceMediaPathWatch(watch, next);
      watch = result.watch;
      return result;
    });

    expect(results.map((result) => result.condition)).toEqual([
      "flowing",
      "connected-without-media",
      "connected-without-media",
      "connected-without-media",
      "connected-without-media",
    ]);
    expect(results.at(-1)?.stalledForMs).toBe(MEDIA_PATH_STALL_MS);
    expect(results.some((result) => result.mediaMoved)).toBe(false);
  });

  it("counts sent media once a newer receiver report shows the SFU heard from this transport", () => {
    const first = advanceMediaPathWatch(INITIAL_MEDIA_PATH_WATCH, sent(0, 1_000, 5_000));
    const next = advanceMediaPathWatch(first.watch, sent(2_500, 80_000, 6_100));

    expect(next.condition).toBe("flowing");
    expect(next.deliveredBytes).toBe(79_000);
    expect(next.mediaMoved).toBe(true);
  });

  it("needs bytes to leave as well as a newer receiver report", () => {
    expect(deliveredRtpBytes(sent(0, 1_000, 5_000), sent(2_500, 1_000, 6_100))).toBe(0);
    expect(deliveredRtpBytes(sent(0, 1_000, 5_000), sent(2_500, 9_000, 6_100))).toBe(8_000);
  });

  it("counts received bytes as delivered without a receiver report", () => {
    expect(deliveredRtpBytes(sample({ rtpBytes: 1_000 }), sample({ at: 2_500, rtpBytes: 9_000 }))).toBe(8_000);
    expect(deliveredRtpBytes(sample({ rtpBytes: 1_000 }), sample({ at: 2_500, rtpBytes: 1_000 }))).toBe(0);
  });

  it("never compares readings from opposite directions", () => {
    expect(deliveredRtpBytes(sample({ rtpBytes: 1_000 }), sent(2_500, 9_000, 6_100))).toBe(0);
  });

  it("counts the first receiver report a transport gets", () => {
    expect(deliveredRtpBytes(sent(0, 1_000, null), sent(2_500, 9_000, 400))).toBe(8_000);
    expect(deliveredRtpBytes(sent(0, 1_000, null), sent(2_500, 9_000, null))).toBe(0);
  });

  it("never proves a relay with bytes the SFU did not get", () => {
    const relay = "turn:127.0.0.1:6519?transport=udp";
    const previous = advanceMediaPathWatch(INITIAL_MEDIA_PATH_WATCH, sent(0, 1_000_000, 5_000));
    const blocked = advanceMediaPathWatch(previous.watch, sent(2_500, 1_296_084, 5_000));
    const delivered = advanceMediaPathWatch(previous.watch, sent(2_500, 1_296_084, 6_100));
    const relayBytes = { [relay]: 1_330_000 };
    const previousRelayBytes = { [relay]: 1_020_000 };

    expect(
      relayProvenByMedia({ mediaBytes: blocked.deliveredBytes, relayBytes, previousRelayBytes }),
    ).toBeNull();
    expect(
      relayProvenByMedia({ mediaBytes: delivered.deliveredBytes, relayBytes, previousRelayBytes }),
    ).toBe(relay);
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

describe("wanting TURN alone after a rebuild", () => {
  it("wants TURN alone once asked, even while no relay is usable", () => {
    const wanted = resolveRebuildRelayOnly({ requested: true, relayOnly: false });

    expect(wanted).toBe(true);
    expect(icePolicyForOffers(wanted, [])).toBe("all");
  });

  it("keeps wanting it until something resets it", () => {
    expect(resolveRebuildRelayOnly({ requested: false, relayOnly: true })).toBe(true);
    expect(resolveRebuildRelayOnly({ requested: false, relayOnly: false })).toBe(false);
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

describe("verifying an ICE restart on a silent path", () => {
  const lastCamera = (producerPaused: boolean) =>
    describeConsumedStream({
      kind: "video",
      source: "webcam",
      consumerPaused: false,
      adaptivelyPaused: false,
      producerPausedHere: false,
      server: { producerPaused },
    });

  it("passes once media reaches the far end again", () => {
    expect(
      iceRestartBroughtMediaBack({ replaced: false, expectsMedia: true, mediaReached: true }),
    ).toBe(true);
  });

  it("fails while media is still expected and none arrived", () => {
    expect(
      iceRestartBroughtMediaBack({
        replaced: false,
        expectsMedia: receivePathExpectsMedia([lastCamera(false)], true),
        mediaReached: false,
      }),
    ).toBe(false);
  });

  it("does not fail when the last camera paused during the check", () => {
    expect(
      iceRestartBroughtMediaBack({
        replaced: false,
        expectsMedia: receivePathExpectsMedia([lastCamera(true)], true),
        mediaReached: false,
      }),
    ).toBe(true);
  });

  it("leaves a transport replaced during the check to the rebuild that replaced it", () => {
    expect(
      iceRestartBroughtMediaBack({ replaced: true, expectsMedia: true, mediaReached: false }),
    ).toBe(true);
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
  type Pause = "none" | "here" | "adaptive" | "server" | "producer" | "producer-on-server";
  const stream = ({
    kind,
    source,
    on,
    pause = "none",
  }: {
    kind: "audio" | "video";
    source: "webcam" | "screen";
    on: boolean;
    pause?: Pause;
  }): ConsumedStream =>
    describeConsumedStream({
      kind,
      source,
      consumerPaused: pause === "here",
      adaptivelyPaused: pause === "adaptive",
      producerPausedHere: !on || pause === "producer",
      server: {
        paused: pause === "server",
        producerPaused: pause === "producer-on-server",
      },
    });
  const pauses: Pause[] = ["none", "here", "adaptive", "server", "producer", "producer-on-server"];
  const table = [false, true].flatMap((micOn) =>
    [false, true].flatMap((cameraOn) =>
      [false, true].flatMap((screenOn) =>
        pauses.map((cameraPause) => ({ micOn, cameraOn, screenOn, cameraPause })),
      ),
    ),
  );

  it.each(table)(
    "expects media on a connected path only from a live mic or an unpaused live camera: %o",
    ({ micOn, cameraOn, screenOn, cameraPause }) => {
      const streams = [
        stream({ kind: "audio", source: "webcam", on: micOn }),
        stream({ kind: "video", source: "webcam", on: cameraOn, pause: cameraPause }),
        stream({ kind: "video", source: "screen", on: screenOn }),
        stream({ kind: "audio", source: "screen", on: false }),
      ];

      expect(receivePathExpectsMedia(streams, true)).toBe(
        micOn || (cameraOn && cameraPause === "none"),
      );
    },
  );

  it("does not expect cameras the receiver parked on the server during a quiet screen share", () => {
    const streams = [
      stream({ kind: "audio", source: "webcam", on: false }),
      stream({ kind: "video", source: "webcam", on: true, pause: "adaptive" }),
      stream({ kind: "video", source: "webcam", on: true, pause: "adaptive" }),
      stream({ kind: "video", source: "screen", on: true }),
    ];

    expect(receivePathExpectsMedia(streams, true)).toBe(false);
    expect(streams.filter(streamShouldFlow)).toEqual([]);
  });

  it("still expects a camera whose layers the server stopped forwarding", () => {
    const forwardingNothing = {
      paused: false,
      producerPaused: false,
      preferredLayers: { spatialLayer: 2 },
      currentLayers: undefined,
    };

    expect(
      streamShouldFlow(
        describeConsumedStream({
          kind: "video",
          source: "webcam",
          consumerPaused: false,
          adaptivelyPaused: false,
          producerPausedHere: false,
          server: forwardingNothing,
        }),
      ),
    ).toBe(true);
  });

  it("expects a stream whose server state has not arrived yet", () => {
    expect(
      streamShouldFlow(
        describeConsumedStream({
          kind: "video",
          source: "webcam",
          consumerPaused: false,
          adaptivelyPaused: false,
          producerPausedHere: false,
          server: undefined,
        }),
      ),
    ).toBe(true);
  });

  it("expects media on a path that is not connected whenever it carries any stream", () => {
    expect(
      receivePathExpectsMedia([stream({ kind: "video", source: "screen", on: false })], false),
    ).toBe(true);
    expect(receivePathExpectsMedia([], false)).toBe(false);
  });

  it("expects screen share audio, which keeps sending through silence", () => {
    expect(
      receivePathExpectsMedia([stream({ kind: "audio", source: "screen", on: true })], true),
    ).toBe(true);
  });
});

describe("what a send path is expected to carry", () => {
  const stream = (kind: "audio" | "video", source: "webcam" | "screen", sending: boolean): PublishedStream => ({
    kind,
    source,
    live: true,
    sending,
  });
  const cases: Array<[string, boolean, boolean, boolean, boolean, { expectsMedia: boolean; framesOptional: boolean }]> = [];
  for (const mic of [false, true])
    for (const camera of [false, true])
      for (const screenVideo of [false, true])
        for (const screenAudio of [false, true]) {
          const sending = mic || camera || screenVideo || screenAudio;
          cases.push([
            `mic ${mic}, camera ${camera}, screen video ${screenVideo}, screen audio ${screenAudio}`,
            mic,
            camera,
            screenVideo,
            screenAudio,
            { expectsMedia: sending, framesOptional: screenVideo && !mic && !camera && !screenAudio },
          ]);
        }

  it.each(cases)("%s", (_name, mic, camera, screenVideo, screenAudio, expected) => {
    expect(
      sendPathExpectation(
        [
          stream("audio", "webcam", mic),
          stream("video", "webcam", camera),
          stream("video", "screen", screenVideo),
          stream("audio", "screen", screenAudio),
        ],
        true,
      ),
    ).toEqual(expected);
  });

  it("expects media from any live producer before the path connects", () => {
    expect(sendPathExpectation([{ kind: "audio", source: "screen", live: true, sending: false }], false)).toEqual({
      expectsMedia: true,
      framesOptional: false,
    });
    expect(sendPathExpectation([{ kind: "audio", source: "screen", live: false, sending: false }], false).expectsMedia).toBe(
      false,
    );
  });
});

describe("knowing that a static screen share still reaches the SFU", () => {
  const sent = (rtpBytes: number, receiverReportAt: number | null) => ({
    direction: "send" as const,
    rtpBytes,
    receiverReportAt,
  });

  it("counts a newer receiver report as delivery when frames are optional", () => {
    expect(mediaReachedFarEnd(sent(1_000, 5_000), sent(1_000, 6_100), true)).toBe(true);
  });

  it("still needs a newer receiver report when frames are optional", () => {
    expect(mediaReachedFarEnd(sent(1_000, 5_000), sent(9_000, 5_000), true)).toBe(false);
  });

  it("needs bytes as well as a report while other streams are sending", () => {
    expect(mediaReachedFarEnd(sent(1_000, 5_000), sent(1_000, 6_100), false)).toBe(false);
    expect(mediaReachedFarEnd(sent(1_000, 5_000), sent(9_000, 6_100), false)).toBe(true);
  });
});

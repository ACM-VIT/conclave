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
  INITIAL_SCREEN_SHARE_WATCH,
  advanceScreenShareWatch,
  screenPacketsGoMissing,
  screenVideoAwaitingSenderCheck,
  readSenderPacketCounts,
  senderPacketCountsRequestFor,
  type ConsumedStream,
  type ScreenShareWatch,
  rtpBytesMoved,
  checkPath,
  hasCarriedMedia,
  expectationAfterIceRestart,
  judgeIceRestart,
  type MediaPathRecovery,
  type SenderPacketsReading,
  advanceProducerDeliveries,
  failingStreamsAfter,
  judgeDeliveryWindow,
  judgeProducerDelivery,
  pathCarriesWhatIsSent,
  readMediaPath,
  type PathEvidence,
  type SendingProducer,
  type SentStream,
  type StreamDeliveries,
  pathShowsLife,
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
  sent: {},
  knownFailing: [],
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
      sent: {},
    });
  });
});

describe("signs of life on a send path, which are never proof", () => {
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
    expect(results.some(({ evidence }) => pathCarriesWhatIsSent(evidence, []))).toBe(false);
  });

  it("keeps the stall clock off, and proves nothing, when bytes leave and a newer receiver report comes back", () => {
    const first = advanceMediaPathWatch(INITIAL_MEDIA_PATH_WATCH, sent(0, 1_000, 5_000));
    const next = advanceMediaPathWatch(first.watch, sent(2_500, 80_000, 6_100));

    expect(next.condition).toBe("flowing");
    expect(next.rtpBytesMoved).toBe(79_000);
    expect(next.evidence).toEqual({ sent: {} });
    expect(pathCarriesWhatIsSent(next.evidence, [])).toBe(false);
  });

  it("needs bytes to leave as well as a newer receiver report", () => {
    expect(pathShowsLife(sent(0, 1_000, 5_000), sent(2_500, 1_000, 6_100), false)).toBe(false);
    expect(pathShowsLife(sent(0, 1_000, 5_000), sent(2_500, 9_000, 6_100), false)).toBe(true);
    expect(pathShowsLife(sent(0, 1_000, 5_000), sent(2_500, 9_000, 5_000), false)).toBe(false);
  });

  it("counts the first receiver report a transport gets", () => {
    expect(pathShowsLife(sent(0, 1_000, null), sent(2_500, 9_000, 400), false)).toBe(true);
    expect(pathShowsLife(sent(0, 1_000, null), sent(2_500, 9_000, null), false)).toBe(false);
  });

  it("reads received bytes as life without any receiver report", () => {
    expect(pathShowsLife(sample({ rtpBytes: 1_000 }), sample({ at: 2_500, rtpBytes: 9_000 }), false)).toBe(true);
    expect(pathShowsLife(sample({ rtpBytes: 1_000 }), sample({ at: 2_500, rtpBytes: 1_000 }), false)).toBe(false);
  });

  it("counts the bytes that moved between two readings of the same direction", () => {
    expect(rtpBytesMoved(sent(0, 1_000, 5_000), sent(2_500, 9_000, 5_000))).toBe(8_000);
    expect(rtpBytesMoved(sample({ rtpBytes: 1_000 }), sample({ at: 2_500, rtpBytes: 9_000 }))).toBe(8_000);
    expect(rtpBytesMoved(sample({ rtpBytes: 9_000 }), sample({ at: 2_500, rtpBytes: 1_000 }))).toBe(0);
    expect(rtpBytesMoved(null, sent(2_500, 9_000, 6_100))).toBe(0);
  });

  it("never compares readings from opposite directions", () => {
    expect(rtpBytesMoved(sample({ rtpBytes: 1_000 }), sent(2_500, 9_000, 6_100))).toBe(0);
    expect(pathShowsLife(sample({ rtpBytes: 1_000 }), sent(2_500, 9_000, 6_100), true)).toBe(false);
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
    silentWhileConnected: true,
    relayOnly: false,
    reconnectInFlight: false,
    ...overrides,
  });
  const sampled = (
    direction: "producer" | "consumer",
    streams: StreamDeliveries = {},
    received = true,
  ) =>
    ({
      type: "path-sampled",
      direction,
      evidence: direction === "consumer" ? { received } : { sent: streams },
    }) as const;
  const connected = (transportId: string) =>
    ({ type: "transport-connected", direction: "consumer", transportId }) as const;
  const started = (transportId: string, direction: "producer" | "consumer" = "consumer") =>
    ({ type: "rebuild-started", direction, transportId }) as const;
  const settled = (transportId: string, direction: "producer" | "consumer" = "consumer") =>
    ({ type: "escalation-settled", direction, transportId }) as const;
  const flowing = sampled("consumer");

  const rebuiltAfter = (recovery: MediaPathRecovery, failed: MediaPathFailure) => {
    const asked = planMediaPathFailure(recovery, failed);
    expect(["reconnect", "reconnect-relay-only"]).toContain(asked.step);
    return [started, settled].reduce(
      (next, event) => advanceMediaPathRecovery(next, event(failed.transportId, failed.direction)),
      asked.recovery,
    );
  };

  const blockedOnT2 = () => {
    const blocked = planMediaPathFailure(
      rebuiltAfter(INITIAL_MEDIA_PATH_RECOVERY, failure("t1")),
      failure("t2", { relayOnly: true }),
    );
    expect(blocked.step).toBe("report-blocked");
    expect(readMediaPathHealth(blocked.recovery).consumer).toBe("blocked");
    return blocked.recovery;
  };

  it("starts the ladder again when media resumes on a blocked transport that never reconnected", () => {
    const resumed = advanceMediaPathRecovery(blockedOnT2(), flowing);
    expect(readMediaPathHealth(resumed)).toEqual(HEALTHY_MEDIA_PATHS);

    const rebuildAgain = planMediaPathFailure(resumed, failure("t2", { relayOnly: true }));
    expect(rebuildAgain.step).toBe("reconnect");

    const blockedAgain = planMediaPathFailure(
      rebuiltAfter(resumed, failure("t2", { relayOnly: true })),
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
    expect(advanceMediaPathRecovery(held, flowing)).toEqual({
      ...held,
      consumer: INITIAL_MEDIA_PATH_RECOVERY.consumer,
    });

    const handling = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1")).recovery;
    expect(advanceMediaPathRecovery(handling, flowing)).toEqual(INITIAL_MEDIA_PATH_RECOVERY);
  });

  it("acts once on a failure that several watchers report while it is being handled", () => {
    const first = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1"));
    const second = planMediaPathFailure(first.recovery, failure("t1"));

    expect(second.step).toBe("already-escalated");
    expect(second.recovery).toBe(first.recovery);
  });

  it("notes that the failure being handled also went silent while connected", () => {
    const first = planMediaPathFailure(
      INITIAL_MEDIA_PATH_RECOVERY,
      failure("s1", { direction: "producer", silentWhileConnected: false }),
    );
    const second = planMediaPathFailure(
      first.recovery,
      failure("s1", { direction: "producer", reconnectInFlight: true }),
    );

    expect(second.step).toBe("already-escalated");
    expect(second.recovery.producer.escalation).toMatchObject({
      transportId: "s1",
      silentWhileConnected: true,
    });
  });

  it("counts a rebuild only once it starts", () => {
    const asked = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1"));
    expect(asked.step).toBe("reconnect-relay-only");
    expect(asked.recovery.consumer.rebuildTried).toBe(false);

    const skipped = advanceMediaPathRecovery(asked.recovery, settled("t1"));
    expect(planMediaPathFailure(skipped, failure("t1")).step).toBe("reconnect-relay-only");

    const rebuilt = advanceMediaPathRecovery(
      advanceMediaPathRecovery(asked.recovery, started("t1")),
      settled("t1"),
    );
    expect(planMediaPathFailure(rebuilt, failure("t2", { relayOnly: true })).step).toBe(
      "report-blocked",
    );
  });

  it("acts on a transport again once the run that handled it ends without replacing it", () => {
    const asked = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1"));
    const ended = advanceMediaPathRecovery(asked.recovery, settled("t1"));

    expect(ended.consumer.escalation).toBeNull();
    expect(readMediaPathHealth(ended).consumer).toBe("recovering");
    expect(planMediaPathFailure(ended, failure("t1")).step).toBe("reconnect-relay-only");
  });

  it("ignores a rebuild start or an end that belongs to a failure it no longer handles", () => {
    const asked = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, failure("t1"));
    const retried = advanceMediaPathRecovery(asked.recovery, { type: "user-retry" });
    expect(advanceMediaPathRecovery(retried, started("t1"))).toBe(retried);
    expect(advanceMediaPathRecovery(retried, settled("t1"))).toBe(retried);

    const other = planMediaPathFailure(retried, failure("t2")).recovery;
    expect(advanceMediaPathRecovery(other, started("t1"))).toBe(other);
    expect(advanceMediaPathRecovery(other, settled("t1"))).toBe(other);
    expect(advanceMediaPathRecovery(other, started("t2", "producer"))).toBe(other);
  });

  it("keeps the failure being handled when its transport only connects", () => {
    const asked = planMediaPathFailure(
      INITIAL_MEDIA_PATH_RECOVERY,
      failure("t1", { silentWhileConnected: false }),
    ).recovery;

    expect(advanceMediaPathRecovery(asked, connected("t1"))).toBe(asked);
  });

  it("holds a rebuild asked for during a rejoin, one per direction, until the rejoin settles", () => {
    let recovery = planMediaPathFailure(
      INITIAL_MEDIA_PATH_RECOVERY,
      failure("r1", { reconnectInFlight: true }),
    ).recovery;
    recovery = planMediaPathFailure(
      recovery,
      failure("s1", {
        direction: "producer",
        reason: "send failed",
        reconnectInFlight: true,
      }),
    ).recovery;

    const taken = takeDeferredRebuilds(recovery);
    expect(taken.deferred).toEqual([
      {
        direction: "producer",
        transportId: "s1",
        reason: "send failed",
        silentWhileConnected: true,
      },
      {
        direction: "consumer",
        transportId: "r1",
        reason: "Consumer transport carried no media",
        silentWhileConnected: true,
      },
    ]);
    expect(readMediaPathHealth(recovery)).toEqual({ producer: "recovering", consumer: "recovering" });
    expect(takeDeferredRebuilds(taken.recovery).deferred).toEqual([]);
    expect(readMediaPathHealth(taken.recovery)).toEqual(readMediaPathHealth(recovery));
  });

  it("holds the newest transport's rebuild when a second one is asked for during the same rejoin", () => {
    const held = (recovery: MediaPathRecovery, transportId: string) =>
      planMediaPathFailure(
        recovery,
        failure(transportId, { direction: "producer", reconnectInFlight: true }),
      ).recovery;

    expect(
      held(held(INITIAL_MEDIA_PATH_RECOVERY, "s1"), "s2").producer.deferredRebuild?.transportId,
    ).toBe("s2");
  });

  it("drops a held rebuild for a transport that could not connect once it connects", () => {
    const held = planMediaPathFailure(
      INITIAL_MEDIA_PATH_RECOVERY,
      failure("r1", { reconnectInFlight: true, silentWhileConnected: false }),
    ).recovery;

    expect(takeDeferredRebuilds(advanceMediaPathRecovery(held, connected("r1"))).deferred).toEqual(
      [],
    );
  });

  it("keeps a held rebuild for a connected path that carried nothing when it reports connected again", () => {
    const held = planMediaPathFailure(
      INITIAL_MEDIA_PATH_RECOVERY,
      failure("s1", { direction: "producer", reconnectInFlight: true }),
    ).recovery;
    const reconnected = advanceMediaPathRecovery(held, {
      type: "transport-connected",
      direction: "producer",
      transportId: "s1",
    });

    expect(takeDeferredRebuilds(reconnected).deferred).toHaveLength(1);
  });

  it("gives Try again a fresh ladder but keeps the warning until media flows", () => {
    const retried = advanceMediaPathRecovery(blockedOnT2(), { type: "user-retry" });

    expect(readMediaPathHealth(retried).consumer).toBe("blocked");
    expect(planMediaPathFailure(retried, failure("t2", { relayOnly: true })).step).toBe("reconnect");
  });

  it("keeps a rebuild's ladder when the new transport only connects", () => {
    const rebuilt = advanceMediaPathRecovery(
      rebuiltAfter(INITIAL_MEDIA_PATH_RECOVERY, failure("t1")),
      connected("t2"),
    );

    expect(readMediaPathHealth(rebuilt).consumer).toBe("recovering");
    expect(planMediaPathFailure(rebuilt, failure("t2", { relayOnly: true })).step).toBe(
      "report-blocked",
    );
  });

  it("reports a blocked direction once and holds nothing for it", () => {
    const blocked = blockedOnT2();
    expect(blocked.consumer.escalation).toBeNull();

    const again = planMediaPathFailure(blocked, failure("t2", { relayOnly: true }));
    expect(again.step).toBe("report-blocked");
    expect(again.recovery).toBe(blocked);
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
    const sendFlowing = advanceMediaPathRecovery(
      blockedOnT2(),
      sampled("producer", { mic: "delivered" }),
    );
    expect(readMediaPathHealth(sendFlowing).consumer).toBe("blocked");
  });

  it("stays blocked on a sample in which nothing reached the far end", () => {
    const blocked = blockedOnT2();
    expect(advanceMediaPathRecovery(blocked, sampled("consumer", {}, false))).toBe(blocked);
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

  const notAsked: SenderPacketsReading = { asked: false };
  const reply = (sent: Record<string, number> | null, ids = ["screen"]) =>
    ({ asked: true, ids, sent }) as const;
  const counted = (sent: number | null) => reply(sent === null ? null : { screen: sent });

  it("passes once media reaches the far end again", () => {
    expect(judgeIceRestart({ replaced: false, expectation: "expected", mediaReached: true })).toBe(
      "media-arrived",
    );
  });

  it("fails while media is still expected and none arrived", () => {
    expect(
      judgeIceRestart({
        replaced: false,
        expectation: expectationAfterIceRestart({
          expectsMedia: receivePathExpectsMedia([lastCamera(false)], true),
          senderBefore: notAsked,
          senderAfter: notAsked,
        }),
        mediaReached: false,
      }),
    ).toBe("not-recovered");
  });

  it("does not fail when the last camera paused during the check", () => {
    expect(
      judgeIceRestart({
        replaced: false,
        expectation: expectationAfterIceRestart({
          expectsMedia: receivePathExpectsMedia([lastCamera(true)], true),
          senderBefore: notAsked,
          senderAfter: notAsked,
        }),
        mediaReached: false,
      }),
    ).toBe("nothing-expected");
  });

  it("leaves a transport replaced during the check to the rebuild that replaced it", () => {
    expect(judgeIceRestart({ replaced: true, expectation: "expected", mediaReached: false })).toBe(
      "replaced",
    );
  });

  it("never takes an expectation it could not establish for a recovery", () => {
    expect(judgeIceRestart({ replaced: false, expectation: "unknown", mediaReached: false })).toBe(
      "not-recovered",
    );
    expect(judgeIceRestart({ replaced: false, expectation: "unknown", mediaReached: true })).toBe(
      "media-arrived",
    );
  });

  it.each<[string, boolean, SenderPacketsReading, SenderPacketsReading, string]>([
    ["a stream that should flow", true, notAsked, notAsked, "expected"],
    ["a stream that should flow, whatever the sharer's counts say", true, counted(null), counted(null), "expected"],
    ["nothing to ask the sharer about", false, notAsked, notAsked, "not-expected"],
    ["a share that stopped being checked", false, counted(4), notAsked, "not-expected"],
    ["a sharer that sent more", false, counted(4), counted(9), "expected"],
    ["a sharer that sent nothing more", false, counted(4), counted(4), "not-expected"],
    ["a first count that never arrived", false, counted(null), counted(9), "unknown"],
    ["a second count that never arrived", false, counted(4), counted(null), "unknown"],
    ["no counts at all", false, counted(null), counted(null), "unknown"],
    ["a share first checked after the restart", false, notAsked, counted(9), "unknown"],
    ["a requested count omitted before the restart", false, reply({}), counted(0), "unknown"],
    ["a requested count omitted after the restart", false, counted(0), reply({}), "unknown"],
    ["two readable zero counts", false, counted(0), counted(0), "not-expected"],
    ["one unchanged count and one omitted count", false, reply({ screen: 0, slides: 2 }, ["screen", "slides"]), reply({ screen: 0 }, ["screen", "slides"]), "unknown"],
    ["one growing count and one omitted count", false, reply({ screen: 0, slides: 2 }, ["screen", "slides"]), reply({ screen: 1 }, ["screen", "slides"]), "expected"],
    ["a newly watched consumer", false, counted(9), reply({ slides: 9 }, ["slides"]), "unknown"],
    ["growth on a consumer no longer watched", false, reply({ screen: 5, slides: 1 }, ["screen", "slides"]), reply({ screen: 5, slides: 2 }), "not-expected"],
  ])("reads %s", (_name, expectsMedia, senderBefore, senderAfter, expectation) => {
    expect(expectationAfterIceRestart({ expectsMedia, senderBefore, senderAfter })).toBe(expectation);
  });
});

describe("knowing that media arrived on a receive path", () => {
  it("needs bytes to grow between two connected samples", () => {
    const first = advanceMediaPathWatch(INITIAL_MEDIA_PATH_WATCH, sample({ at: 0, rtpBytes: 100 }));
    expect(first.evidence).toEqual({ received: false });
    expect(advanceMediaPathWatch(first.watch, sample({ at: 1, rtpBytes: 100 })).evidence).toEqual({
      received: false,
    });
    expect(advanceMediaPathWatch(first.watch, sample({ at: 1, rtpBytes: 250 })).evidence).toEqual({
      received: true,
    });
  });

  it("takes nothing from bytes that grew while the transport was not connected", () => {
    const first = advanceMediaPathWatch(INITIAL_MEDIA_PATH_WATCH, sample({ at: 0, rtpBytes: 100 }));
    const next = advanceMediaPathWatch(
      first.watch,
      sample({ at: 1, rtpBytes: 250, connectionState: "disconnected" }),
    );

    expect(next.evidence).toEqual({ received: false });
    expect(next.rtpBytesMoved).toBe(0);
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

describe("signs of life from a static screen share", () => {
  const sent = (rtpBytes: number, receiverReportAt: number | null) => ({
    direction: "send" as const,
    rtpBytes,
    receiverReportAt,
    sent: {},
  });

  it("counts a newer receiver report as life when frames are optional", () => {
    expect(pathShowsLife(sent(1_000, 5_000), sent(1_000, 6_100), true)).toBe(true);
  });

  it("still needs a newer receiver report when frames are optional", () => {
    expect(pathShowsLife(sent(1_000, 5_000), sent(9_000, 5_000), true)).toBe(false);
  });

  it("needs bytes as well as a report while other streams are sending", () => {
    expect(pathShowsLife(sent(1_000, 5_000), sent(1_000, 6_100), false)).toBe(false);
    expect(pathShowsLife(sent(1_000, 5_000), sent(9_000, 6_100), false)).toBe(true);
  });
});

describe("telling a still screen share apart from one whose packets never arrive", () => {
  const screen = (pause: "none" | "here" | "server" | "producer" = "none"): ConsumedStream =>
    describeConsumedStream({
      kind: "video",
      source: "screen",
      consumerPaused: pause === "here",
      adaptivelyPaused: false,
      producerPausedHere: pause === "producer",
      server: { paused: pause === "server" },
    });
  const mic = (on: boolean): ConsumedStream =>
    describeConsumedStream({
      kind: "audio",
      source: "webcam",
      consumerPaused: false,
      adaptivelyPaused: false,
      producerPausedHere: !on,
      server: undefined,
    });

  it("asks the SFU about a screen share only when nothing else on a connected path should flow", () => {
    expect(screenVideoAwaitingSenderCheck([{ consumerId: "s", stream: screen() }], true)).toEqual(["s"]);
    expect(
      screenVideoAwaitingSenderCheck(
        [
          { consumerId: "s", stream: screen() },
          { consumerId: "m", stream: mic(false) },
        ],
        true,
      ),
    ).toEqual(["s"]);
    expect(
      screenVideoAwaitingSenderCheck(
        [
          { consumerId: "s", stream: screen() },
          { consumerId: "m", stream: mic(true) },
        ],
        true,
      ),
    ).toEqual([]);
    expect(screenVideoAwaitingSenderCheck([{ consumerId: "s", stream: screen() }], false)).toEqual([]);
    for (const pause of ["here", "server", "producer"] as const) {
      expect(screenVideoAwaitingSenderCheck([{ consumerId: "s", stream: screen(pause) }], true)).toEqual([]);
    }
  });

  it("asks for at most as many consumers as one request may name, and never for none", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `consumer-${index}`);

    expect(senderPacketCountsRequestFor([])).toBeNull();
    expect(senderPacketCountsRequestFor(["s"])).toEqual({ consumerIds: ["s"] });
    expect(senderPacketCountsRequestFor(ids)).toEqual({ consumerIds: ids.slice(0, 16) });
    expect(senderPacketCountsRequestFor([""])).toBeNull();
    expect(senderPacketCountsRequestFor(["s", "t", "s"])).toEqual({ consumerIds: ["s", "t"] });
  });

  it("reads only a well formed answer from the SFU", () => {
    expect(readSenderPacketCounts({ counts: { s: 12 } })).toEqual({ s: 12 });
    expect(readSenderPacketCounts({ counts: {} })).toEqual({});
    expect(readSenderPacketCounts({ error: "Too many requests" })).toBeNull();
    expect(readSenderPacketCounts({ counts: { s: -1 } })).toBeNull();
    expect(readSenderPacketCounts({ counts: { s: "12" } })).toBeNull();
    expect(readSenderPacketCounts(undefined)).toBeNull();
  });

  type Step = { sent: Record<string, number> | null; received: boolean; ids?: string[] };
  const run = (steps: Step[]): { watch: ScreenShareWatch; missing: boolean[] } => {
    let watch = INITIAL_SCREEN_SHARE_WATCH;
    let ids = ["s"];
    const missing: boolean[] = [];
    for (const step of steps) {
      ids = step.ids ?? ids;
      watch = advanceScreenShareWatch(watch, { ...step, asked: true, ids });
      missing.push(screenPacketsGoMissing(watch));
    }
    return { watch, missing };
  };

  it.each<[string, Step[], boolean[]]>([
    [
      "a static share: the sharer sends nothing and nothing arrives",
      Array.from({ length: 120 }, () => ({ sent: { s: 40 }, received: false })),
      Array.from({ length: 120 }, () => false),
    ],
    [
      "a changing share that arrives",
      [1, 2, 3, 4].map((n) => ({ sent: { s: n * 25 }, received: true })),
      [false, false, false, false],
    ],
    [
      "a changing share whose packets stop arriving",
      [
        { sent: { s: 25 }, received: true },
        { sent: { s: 50 }, received: false },
        { sent: { s: 75 }, received: false },
        { sent: { s: 100 }, received: false },
      ],
      [false, false, true, true],
    ],
    [
      "a share that pauses between bursts that never arrive",
      [
        { sent: { s: 25 }, received: true },
        { sent: { s: 30 }, received: false },
        { sent: { s: 30 }, received: false },
        { sent: { s: 30 }, received: false },
        { sent: { s: 31 }, received: false },
        { sent: { s: 31 }, received: false },
      ],
      [false, false, false, false, true, true],
    ],
    [
      "one burst counted before it arrives, then a static share",
      [
        { sent: { s: 25 }, received: true },
        { sent: { s: 27 }, received: false },
        { sent: { s: 27 }, received: true },
        ...Array.from({ length: 60 }, () => ({ sent: { s: 27 }, received: false })),
      ],
      Array.from({ length: 63 }, () => false),
    ],
    [
      "one lost burst, then a static share",
      [
        { sent: { s: 25 }, received: true },
        { sent: { s: 27 }, received: false },
        ...Array.from({ length: 60 }, () => ({ sent: { s: 27 }, received: false })),
      ],
      Array.from({ length: 62 }, () => false),
    ],
    [
      "an SFU that never answers stays exempt",
      Array.from({ length: 20 }, () => ({ sent: null, received: false })),
      Array.from({ length: 20 }, () => false),
    ],
    [
      "a lost answer keeps the watch where it was",
      [
        { sent: { s: 25 }, received: false },
        { sent: { s: 50 }, received: false },
        { sent: null, received: false },
        { sent: { s: 75 }, received: false },
        { sent: null, received: false },
      ],
      [false, false, false, true, true],
    ],
    [
      "bytes that arrive during a lost answer still clear the count",
      [
        { sent: { s: 25 }, received: false },
        { sent: { s: 50 }, received: false },
        { sent: null, received: true },
        { sent: { s: 75 }, received: false },
      ],
      [false, false, false, false],
    ],
    [
      "a partial answer preserves each omitted consumer's last readable count",
      [
        { sent: { s: 0, t: 7 }, received: false, ids: ["s", "t"] },
        { sent: { t: 7 }, received: false },
        { sent: { s: 1 }, received: false },
        { sent: {}, received: false },
        { sent: { t: 8 }, received: false },
      ],
      [false, false, false, false, true],
    ],
    [
      "a replaced consumer starts from its own first count",
      [
        { sent: { s: 25 }, received: false },
        { sent: { t: 900 }, received: false, ids: ["t"] },
        { sent: { t: 900 }, received: false },
        { sent: { t: 950 }, received: false },
      ],
      [false, false, false, false],
    ],
  ])("%s", (_name, steps, expected) => {
    expect(run(steps).missing).toEqual(expected);
  });
});

const micProducer: SendingProducer = { stream: "mic", producerId: "mic", mid: "0" };
const cameraProducer: SendingProducer = { stream: "camera", producerId: "camera", mid: "1" };
const bothProducers = [micProducer, cameraProducer];

const sendSampled = (streams: StreamDeliveries) =>
  ({ type: "path-sampled", direction: "producer", evidence: { sent: streams } }) as const;

const sendFailure = (transportId: string, relayOnly: boolean): MediaPathFailure => ({
  direction: "producer",
  transportId,
  reason: "Producer transport carried no media",
  silentWhileConnected: true,
  relayOnly,
  reconnectInFlight: false,
});

const rebuiltSendPath = (recovery: MediaPathRecovery, transportId: string) =>
  (["rebuild-started", "escalation-settled"] as const).reduce(
    (next, type) => advanceMediaPathRecovery(next, { type, direction: "producer", transportId }),
    planMediaPathFailure(recovery, sendFailure(transportId, false)).recovery,
  );

const CAMERA_SEEN_FAILING = advanceMediaPathRecovery(
  INITIAL_MEDIA_PATH_RECOVERY,
  sendSampled({ mic: "delivered", camera: "undelivered" }),
);
const REBUILT_FOR_CAMERA = rebuiltSendPath(CAMERA_SEEN_FAILING, "s1");
const BLOCKED_ON_CAMERA = planMediaPathFailure(REBUILT_FOR_CAMERA, sendFailure("s2", true)).recovery;

describe("the streams a send path is known to be failing", () => {
  it("records a stream as soon as it is seen not arriving, before any stall", () => {
    expect(CAMERA_SEEN_FAILING.producer).toEqual({
      ...INITIAL_MEDIA_PATH_RECOVERY.producer,
      failingStreams: ["camera"],
    });
  });

  it("keeps the record through the rebuild made for it and the report that it is blocked", () => {
    expect(REBUILT_FOR_CAMERA.producer).toMatchObject({
      health: "recovering",
      rebuildTried: true,
      failingStreams: ["camera"],
    });
    expect(BLOCKED_ON_CAMERA.producer).toMatchObject({
      health: "blocked",
      rebuildTried: true,
      failingStreams: ["camera"],
    });
  });

  it.each<[string, (recovery: MediaPathRecovery) => MediaPathRecovery]>([
    ["new trouble", (recovery) => advanceMediaPathRecovery(recovery, { type: "trouble", direction: "producer" })],
    [
      "its transport connecting",
      (recovery) =>
        advanceMediaPathRecovery(recovery, {
          type: "transport-connected",
          direction: "producer",
          transportId: "s2",
        }),
    ],
    [
      "a rebuild held behind a rejoin and then taken",
      (recovery) =>
        takeDeferredRebuilds(
          planMediaPathFailure(recovery, { ...sendFailure("s2", true), reconnectInFlight: true }).recovery,
        ).recovery,
    ],
    ["the other direction being proven", (recovery) => advanceMediaPathRecovery(recovery, {
      type: "path-sampled",
      direction: "consumer",
      evidence: { received: true },
    })],
  ])("keeps the record through %s", (_name, apply) => {
    for (const recovery of [CAMERA_SEEN_FAILING, REBUILT_FOR_CAMERA, BLOCKED_ON_CAMERA]) {
      expect(apply(recovery).producer.failingStreams).toEqual(["camera"]);
    }
  });

  it.each<[string, StreamDeliveries]>([
    ["the camera sends nothing", { mic: "delivered", camera: "quiet" }],
    ["the camera's count reply is missing", { mic: "delivered", camera: "unconfirmed" }],
    ["the camera is not being sent", { mic: "delivered" }],
    ["nothing is being sent", {}],
    ["the camera still does not arrive", { mic: "delivered", camera: "undelivered" }],
  ])("stays blocked, with its one rebuild spent, while %s", (_name, streams) => {
    expect(advanceMediaPathRecovery(BLOCKED_ON_CAMERA, sendSampled(streams))).toBe(
      BLOCKED_ON_CAMERA,
    );
    expect(advanceMediaPathRecovery(REBUILT_FOR_CAMERA, sendSampled(streams))).toBe(
      REBUILT_FOR_CAMERA,
    );
  });

  it.each<[string, StreamDeliveries]>([
    ["with the microphone arriving too", { mic: "delivered", camera: "delivered" }],
    ["with the microphone sending nothing", { mic: "quiet", camera: "delivered" }],
    ["on its own", { camera: "delivered" }],
  ])("starts over once the camera is seen arriving %s", (_name, streams) => {
    expect(advanceMediaPathRecovery(BLOCKED_ON_CAMERA, sendSampled(streams))).toEqual(
      INITIAL_MEDIA_PATH_RECOVERY,
    );
  });

  it("takes an arrived camera off the record, then waits until everything sent is accounted for", () => {
    const cameraArrived = advanceMediaPathRecovery(
      BLOCKED_ON_CAMERA,
      sendSampled({ mic: "unconfirmed", camera: "delivered" }),
    );
    expect(cameraArrived.producer).toMatchObject({ health: "blocked", failingStreams: [] });

    expect(
      advanceMediaPathRecovery(cameraArrived, sendSampled({ mic: "delivered", camera: "quiet" })),
    ).toEqual(INITIAL_MEDIA_PATH_RECOVERY);
  });

  it("adds a second stream that stops arriving and needs both to arrive again", () => {
    const both = advanceMediaPathRecovery(
      BLOCKED_ON_CAMERA,
      sendSampled({ mic: "undelivered", camera: "quiet" }),
    );
    expect(both.producer.failingStreams).toEqual(["camera", "mic"]);

    const micBack = advanceMediaPathRecovery(both, sendSampled({ mic: "delivered", camera: "quiet" }));
    expect(micBack.producer).toMatchObject({ health: "blocked", failingStreams: ["camera"] });
  });

  it("takes no proof from a send sample that judged no stream", () => {
    const rebuilt = rebuiltSendPath(INITIAL_MEDIA_PATH_RECOVERY, "s1");
    const blocked = planMediaPathFailure(rebuilt, sendFailure("s2", true)).recovery;

    expect(advanceMediaPathRecovery(rebuilt, sendSampled({}))).toBe(rebuilt);
    expect(advanceMediaPathRecovery(blocked, sendSampled({}))).toBe(blocked);
    expect(advanceMediaPathRecovery(blocked, sendSampled({ mic: "delivered" }))).toEqual(
      INITIAL_MEDIA_PATH_RECOVERY,
    );
  });

  it("needs every stream being sent to be accounted for even with nothing on record", () => {
    const rebuilt = rebuiltSendPath(INITIAL_MEDIA_PATH_RECOVERY, "s1");

    expect(
      advanceMediaPathRecovery(rebuilt, sendSampled({ mic: "delivered", camera: "unconfirmed" })),
    ).toBe(rebuilt);
    expect(
      advanceMediaPathRecovery(rebuilt, sendSampled({ mic: "delivered", camera: "quiet" })),
    ).toEqual(INITIAL_MEDIA_PATH_RECOVERY);
  });

  it("takes no proof from a send sample in which every stream sent nothing", () => {
    const rebuilt = rebuiltSendPath(INITIAL_MEDIA_PATH_RECOVERY, "s1");
    const blocked = planMediaPathFailure(rebuilt, sendFailure("s2", true)).recovery;

    expect(advanceMediaPathRecovery(rebuilt, sendSampled({ screen: "quiet" }))).toBe(rebuilt);
    expect(advanceMediaPathRecovery(blocked, sendSampled({ mic: "quiet", screen: "quiet" }))).toBe(
      blocked,
    );
    expect(
      advanceMediaPathRecovery(blocked, sendSampled({ mic: "quiet", screen: "delivered" })),
    ).toEqual(INITIAL_MEDIA_PATH_RECOVERY);
  });

  it("lets Try again clear the record while the warning stays until media is proven", () => {
    const retried = advanceMediaPathRecovery(BLOCKED_ON_CAMERA, { type: "user-retry" });
    expect(retried.producer).toMatchObject({
      health: "blocked",
      rebuildTried: false,
      failingStreams: [],
    });

    expect(advanceMediaPathRecovery(retried, sendSampled({ mic: "delivered" }))).toEqual(
      INITIAL_MEDIA_PATH_RECOVERY,
    );
  });

  it("forgets the record for a new call", () => {
    expect(advanceMediaPathRecovery(BLOCKED_ON_CAMERA, { type: "reset" })).toEqual(
      INITIAL_MEDIA_PATH_RECOVERY,
    );
  });

  it("returns the same record when a sample changes nothing", () => {
    const known: SentStream[] = ["camera"];

    expect(failingStreamsAfter(known, { mic: "delivered", camera: "quiet" })).toBe(known);
    expect(failingStreamsAfter(known, { camera: "delivered" })).toEqual([]);
    expect(
      advanceMediaPathRecovery(INITIAL_MEDIA_PATH_RECOVERY, sendSampled({ mic: "delivered" })),
    ).toBe(INITIAL_MEDIA_PATH_RECOVERY);
  });
});

describe("judging each sending producer on its own", () => {
  type Stream = { mid: string; packetsSent: number; reportAt: number | null; layers?: number };
  type Step = {
    streams: Stream[];
    sfu?: Record<string, number> | null;
    producers?: SendingProducer[];
    sfuReports?: boolean;
    watchReset?: boolean;
  };
  const sendStats = (streams: Stream[]) =>
    streams.flatMap(({ mid, packetsSent, reportAt, layers = 1 }) =>
      Array.from({ length: layers }, (_, layer) => {
        const id = `OUT-${mid}-${layer}`;
        return [
          { type: "outbound-rtp", id, mid, packetsSent: packetsSent / layers, bytesSent: packetsSent * 100 / layers },
          ...(reportAt === null ? [] : [{ type: "remote-inbound-rtp", id: `RI-${mid}-${layer}`, localId: id, timestamp: reportAt }]),
        ];
      }).flat(),
    );
  const mic = (packetsSent: number, reportAt: number): Stream => ({ mid: "0", packetsSent, reportAt });
  const camera = (packetsSent: number, reportAt: number | null): Stream => ({ mid: "1", packetsSent, reportAt });
  const watchSend = (steps: Step[], from: MediaPathRecovery = INITIAL_MEDIA_PATH_RECOVERY) => {
    let watch: MediaPathWatch = INITIAL_MEDIA_PATH_WATCH;
    let recovery = from;
    return steps.map(
      ({ streams, sfu = null, producers = bothProducers, sfuReports = sfu !== null, watchReset = false }, index) => {
        if (watchReset) watch = INITIAL_MEDIA_PATH_WATCH;
        const result = advanceMediaPathWatch(watch, {
          ...readMediaPath(sendStats(streams), "send"),
          at: index * 2_500,
          connectionState: "connected",
          expectsMedia: true,
          framesOptional: false,
          sending: { producers, sfuCounts: sfu, sfuReports },
          knownFailing: recovery.producer.failingStreams,
        });
        watch = result.watch;
        recovery = advanceMediaPathRecovery(recovery, {
          type: "path-sampled",
          direction: "producer",
          evidence: result.evidence,
        });
        return {
          ...result,
          failing: recovery.producer.failingStreams,
          health: recovery.producer.health,
          rebuildTried: recovery.producer.rebuildTried,
        };
      },
    );
  };

  it("reads each transceiver's packets and its own receiver report, adding simulcast layers by mid", () => {
    const reading = readMediaPath(
      sendStats([
        { mid: "0", packetsSent: 50, reportAt: 9_000 },
        { mid: "1", packetsSent: 300, reportAt: 7_000, layers: 3 },
      ]),
      "send",
    );

    expect(reading.sent).toEqual({
      "0": { packetsSent: 50, receiverReportAt: 9_000 },
      "1": { packetsSent: 300, receiverReportAt: 7_000 },
    });
    expect(reading.receiverReportAt).toBe(9_000);
    expect(reading.rtpBytes).toBe(35_000);
  });

  it("notices a camera whose own reports stopped while the microphone's keep coming, on an SFU that cannot count", () => {
    const [, next] = watchSend([
      { streams: [mic(50, 1_000), camera(300, 1_000)] },
      { streams: [mic(175, 3_400), camera(600, 1_000)] },
    ]);

    expect(next.failing).toEqual(["camera"]);
    expect(next.condition).toBe("connected-without-media");
    expect(pathCarriesWhatIsSent(next.evidence, [])).toBe(false);
  });

  it("notices a camera the SFU stopped counting even while its receiver reports keep coming", () => {
    const [, next] = watchSend([
      { streams: [mic(50, 1_000), camera(300, 1_000)], sfu: { mic: 40, camera: 280 } },
      { streams: [mic(175, 3_400), camera(600, 3_300)], sfu: { mic: 165, camera: 280 } },
    ]);

    expect(next.failing).toEqual(["camera"]);
    expect(next.condition).toBe("connected-without-media");
  });

  it("calls the path flowing when every producer that sent reached the SFU", () => {
    const [, next] = watchSend([
      { streams: [mic(50, 1_000), camera(300, 1_000)], sfu: { mic: 40, camera: 280 } },
      { streams: [mic(175, 3_400), camera(600, 3_300)], sfu: { mic: 165, camera: 570 } },
    ]);

    expect(next.failing).toEqual([]);
    expect(next.condition).toBe("flowing");
  });

  it("keeps a camera's failure through missing SFU replies and quiet samples until it reaches the SFU again", () => {
    const results = watchSend([
      { streams: [mic(50, 1_000), camera(300, 1_000)], sfu: { mic: 40, camera: 280 } },
      { streams: [mic(175, 3_400), camera(600, 3_300)], sfu: { mic: 165, camera: 280 } },
      { streams: [mic(300, 5_900), camera(900, 5_800)], sfu: null, sfuReports: true },
      { streams: [mic(425, 8_400), camera(900, 8_300)], sfu: { mic: 415, camera: 280 } },
      { streams: [mic(550, 10_900), camera(1_200, 10_800)], sfu: null, sfuReports: true },
      { streams: [mic(675, 13_400), camera(1_200, 13_300)], sfu: { mic: 665, camera: 280 } },
      { streams: [mic(800, 15_900), camera(1_500, 15_800)], sfu: { mic: 790, camera: 290 } },
    ]);

    expect(results.map(({ condition }) => condition)).toEqual([
      "flowing",
      "connected-without-media",
      "connected-without-media",
      "connected-without-media",
      "connected-without-media",
      "connected-without-media",
      "flowing",
    ]);
    expect(results[5].stalledForMs).toBe(10_000);
  });

  it("stops timing a failing camera once it is paused or removed, and keeps it on record", () => {
    const results = watchSend([
      { streams: [mic(50, 1_000), camera(300, 1_000)], sfu: { mic: 40, camera: 280 } },
      { streams: [mic(175, 3_400), camera(600, 3_300)], sfu: { mic: 165, camera: 280 } },
      { streams: [mic(300, 5_900), camera(600, 5_800)], sfu: { mic: 290, camera: 280 }, producers: [micProducer] },
    ]);

    expect(results.map(({ condition }) => condition)).toEqual(["flowing", "connected-without-media", "flowing"]);
    expect(results.map(({ failing }) => failing)).toEqual([[], ["camera"], ["camera"]]);
  });

  it("clears a failure when packets the SFU had not counted yet show up in a quiet sample", () => {
    const results = watchSend([
      { streams: [mic(50, 1_000), camera(300, 1_000)], sfu: { mic: 40, camera: 280 } },
      { streams: [mic(175, 3_400), camera(330, 3_300)], sfu: { mic: 165, camera: 280 } },
      { streams: [mic(300, 5_900), camera(330, 5_800)], sfu: { mic: 290, camera: 310 } },
    ]);

    expect(results.map(({ condition }) => condition)).toEqual(["flowing", "connected-without-media", "flowing"]);
  });

  it.each<[string, Stream, Record<string, number> | null]>([
    ["a camera that sent nothing, like a still share or a source with no frames", camera(300, 3_300), { mic: 165, camera: 280 }],
    ["a camera that sent while the SFU did not answer", camera(600, 3_300), null],
  ])("does not blame %s", (_name, cameraNow, sfuNow) => {
    const [, next] = watchSend([
      { streams: [mic(50, 1_000), camera(300, 1_000)], sfu: { mic: 40, camera: 280 } },
      { streams: [mic(175, 3_400), cameraNow], sfu: sfuNow, sfuReports: true },
    ]);

    expect(next.failing).toEqual([]);
  });

  it("judges a producer by the SFU's count alone when the browser gives no mid", () => {
    const strip = (streams: Stream[]) => sendStats(streams).map(({ mid: _mid, ...stat }) => stat);
    const judge = (sfuReports: boolean, counts: [number, number] | null) => {
      const sending = (count: number | undefined) => ({
        producers: [cameraProducer],
        sfuCounts: count === undefined ? null : { camera: count },
        sfuReports,
      });
      const first = advanceProducerDeliveries(
        {},
        readMediaPath(strip([camera(300, 1_000)]), "send"),
        sending(counts?.[0]),
      );
      return advanceProducerDeliveries(
        first.counters,
        readMediaPath(strip([camera(600, 1_000)]), "send"),
        sending(counts?.[1]),
      ).streams;
    };

    expect(readMediaPath(strip([camera(600, 1_000)]), "send").sent).toEqual({});
    expect(judge(true, [280, 570])).toEqual({ camera: "delivered" });
    expect(judge(true, [280, 280])).toEqual({ camera: "unconfirmed" });
    expect(judge(false, null)).toEqual({ camera: "unconfirmed" });
  });

  describe("on a watch that starts again while the camera is dropped", () => {
    const droppedThenCounted: Step[] = [
      { streams: [mic(50, 1_000), camera(300, null)], sfu: null, sfuReports: true, watchReset: true },
      { streams: [mic(175, 3_400), camera(600, null)], sfu: { mic: 165, camera: 0 } },
    ];
    const countedThenDropped: Step[] = [
      { streams: [mic(50, 1_000), camera(300, null)], sfu: { mic: 40, camera: 0 }, watchReset: true },
      { streams: [mic(175, 3_400), camera(600, null)], sfu: null, sfuReports: true },
    ];
    const quietCamera: Step[] = [
      { streams: [mic(50, 1_000), camera(300, null)], sfu: { mic: 40, camera: 0 }, watchReset: true },
      { streams: [mic(175, 3_400), camera(300, null)], sfu: { mic: 165, camera: 0 } },
      { streams: [mic(300, 5_900), camera(300, null)], sfu: { mic: 290, camera: 0 } },
    ];
    const micOnly: Step[] = [
      { streams: [mic(50, 1_000)], sfu: { mic: 40 }, producers: [micProducer], watchReset: true },
      { streams: [mic(175, 3_400)], sfu: { mic: 165 }, producers: [micProducer] },
      { streams: [mic(300, 5_900)], sfu: { mic: 290 }, producers: [micProducer] },
    ];

    it.each<[string, Step[]]>([
      ["the first count reply is missing", droppedThenCounted],
      ["the second count reply is missing", countedThenDropped],
      ["the camera sends nothing", quietCamera],
      ["only the microphone is published", micOnly],
    ])("keeps a blocked path blocked and a rebuilt path's rebuild spent when %s", (_name, steps) => {
      expect(watchSend(steps, BLOCKED_ON_CAMERA).map(({ health }) => health)).toEqual(
        steps.map(() => "blocked"),
      );
      expect(watchSend(steps, REBUILT_FOR_CAMERA).at(-1)).toMatchObject({
        health: "recovering",
        rebuildTried: true,
        failing: ["camera"],
      });
    });

    it.each<[string, Step[]]>([
      ["the first count reply is missing", droppedThenCounted],
      ["the second count reply is missing", countedThenDropped],
    ])("does not start a rebuilt path over with nothing on record when %s", (_name, steps) => {
      const rebuilt = rebuiltSendPath(INITIAL_MEDIA_PATH_RECOVERY, "s1");

      expect(watchSend(steps, rebuilt).at(-1)).toMatchObject({
        health: "recovering",
        rebuildTried: true,
      });
    });

    it("times the camera again from the first sample that shows it being sent", () => {
      const results = watchSend(
        [
          { streams: [mic(50, 1_000), camera(300, null)], sfu: { mic: 40, camera: 0 }, watchReset: true },
          { streams: [mic(175, 3_400), camera(600, null)], sfu: { mic: 165, camera: 0 } },
          { streams: [mic(300, 5_900), camera(900, null)], sfu: { mic: 290, camera: 0 } },
        ],
        BLOCKED_ON_CAMERA,
      );

      expect(results.map(({ condition }) => condition)).toEqual([
        "flowing",
        "connected-without-media",
        "connected-without-media",
      ]);
      expect(results.at(-1)?.stalledForMs).toBe(2_500);
    });

    it("does not time a path whose failing camera is not being sent", () => {
      expect(watchSend(micOnly, BLOCKED_ON_CAMERA).map(({ condition }) => condition)).toEqual([
        "flowing",
        "flowing",
        "flowing",
      ]);
    });

    it("clears the warning once the camera's packets are counted again", () => {
      const results = watchSend(
        [
          { streams: [mic(50, 1_000), camera(300, null)], sfu: { mic: 40, camera: 0 }, watchReset: true },
          { streams: [mic(175, 3_400), camera(600, null)], sfu: { mic: 165, camera: 290 } },
        ],
        BLOCKED_ON_CAMERA,
      );

      expect(results.map(({ health }) => health)).toEqual(["blocked", "healthy"]);
    });
  });
});

describe("judging every producer over a short window", () => {
  const reading = (camera: number, mic: number, reportAt = 2_000) =>
    readMediaPath(
      [
        { type: "outbound-rtp", id: "OUT-0", mid: "0", packetsSent: mic, bytesSent: mic * 100 },
        { type: "remote-inbound-rtp", id: "RI-0", localId: "OUT-0", timestamp: reportAt },
        { type: "outbound-rtp", id: "OUT-1", mid: "1", packetsSent: camera, bytesSent: camera * 100 },
        { type: "remote-inbound-rtp", id: "RI-1", localId: "OUT-1", timestamp: reportAt },
      ],
      "send",
    );
  const judge = (over: {
    camera?: [number, number];
    sfuStart?: Record<string, number> | null;
    sfuEnd?: Record<string, number> | null;
    sfuReports?: boolean;
    producers?: SendingProducer[];
  }): PathEvidence => {
    const [cameraStart, cameraEnd] = over.camera ?? [100, 200];
    return {
      sent: judgeDeliveryWindow({
        start: reading(cameraStart, 50, 1_000),
        end: reading(cameraEnd, 100, 2_000),
        producers: over.producers ?? bothProducers,
        sfuStart: over.sfuStart === undefined ? { mic: 40, camera: 90 } : over.sfuStart,
        sfuEnd: over.sfuEnd === undefined ? { mic: 90, camera: 190 } : over.sfuEnd,
        sfuReports: over.sfuReports ?? true,
      }),
    };
  };
  const quietCamera = { camera: [100, 100] as [number, number], sfuEnd: { mic: 90, camera: 90 } };

  it.each<[string, Parameters<typeof judge>[0], SentStream[], boolean]>([
    ["every producer that sent reached the SFU", {}, [], true],
    ["the camera sent and its count did not grow", { sfuEnd: { mic: 90, camera: 90 } }, [], false],
    ["the reply at the start is missing", { sfuStart: null }, [], false],
    ["the reply at the end is missing", { sfuEnd: null }, [], false],
    ["the camera's count is left out of a reply", { sfuEnd: { mic: 90 } }, [], false],
    ["a camera that sent nothing and was not failing", quietCamera, [], true],
    ["a failing camera that sent nothing", quietCamera, ["camera"], false],
    ["a failing camera that reached the SFU again", {}, ["camera"], true],
    ["an SFU that cannot count, with newer reports", { sfuReports: false, sfuStart: null, sfuEnd: null }, [], true],
    ["a failing camera awaiting publish, next to a microphone that arrives", { producers: [micProducer] }, ["camera"], false],
  ])("%s", (_name, over, knownFailing, carried) => {
    expect(pathCarriesWhatIsSent(judge(over), knownFailing)).toBe(carried);
  });

  it("carries nothing it can prove when no stream was delivered", () => {
    expect(pathCarriesWhatIsSent({ sent: {} }, [])).toBe(false);
    expect(pathCarriesWhatIsSent({ sent: { mic: "quiet", camera: "quiet" } }, [])).toBe(false);
    expect(pathCarriesWhatIsSent({ received: false }, [])).toBe(false);
    expect(pathCarriesWhatIsSent({ received: true }, ["camera"])).toBe(true);
  });

  it("gives each stream its own verdict, and none it can confirm without stats rows", () => {
    expect(judge(quietCamera)).toEqual({ sent: { mic: "delivered", camera: "quiet" } });
    expect(
      judgeDeliveryWindow({
        start: reading(100, 50, 1_000),
        end: readMediaPath([], "send"),
        producers: bothProducers,
        sfuStart: { mic: 40, camera: 90 },
        sfuEnd: { mic: 90, camera: 90 },
        sfuReports: true,
      }),
    ).toEqual({ mic: "delivered", camera: "unconfirmed" });
  });
});

describe("the one rule for whether a producer reached the SFU", () => {
  type Row = "present" | "missing";
  type Reply = "growth" | "no-growth" | "missing";
  type Sending = "sent" | "quiet";
  const rows: Row[] = ["present", "missing"];
  const replies: Reply[] = ["growth", "no-growth", "missing"];
  const sendings: Sending[] = ["sent", "quiet"];
  const expected = (row: Row, reply: Reply, sending: Sending) => {
    if (reply === "missing") return "unconfirmed";
    if (reply === "growth") return "delivered";
    if (row === "missing") return "unconfirmed";
    return sending === "quiet" ? "quiet" : "undelivered";
  };
  const cases = rows.flatMap((row) =>
    replies.flatMap((reply) => sendings.map((sending) => [row, reply, sending] as const)),
  );

  it.each(cases)("browser row %s, SFU reply %s, producer %s", (row, reply, sending) => {
    const verdict = judgeProducerDelivery({
      before: row === "present" ? { packetsSent: 100, receiverReportAt: 1_000 } : undefined,
      after:
        row === "present"
          ? { packetsSent: sending === "sent" ? 200 : 100, receiverReportAt: 2_000 }
          : undefined,
      arrivedBefore: reply === "missing" ? undefined : 90,
      arrivedAfter: reply === "missing" ? undefined : reply === "growth" ? 190 : 90,
      sfuReports: true,
    });
    const alone = { sent: { camera: verdict } } satisfies PathEvidence;
    const nextToMic = { sent: { mic: "delivered", camera: verdict } } satisfies PathEvidence;

    expect(verdict).toBe(expected(row, reply, sending));
    expect(pathCarriesWhatIsSent(alone, [])).toBe(verdict === "delivered");
    expect(pathCarriesWhatIsSent(nextToMic, ["camera"])).toBe(verdict === "delivered");
    expect(pathCarriesWhatIsSent(nextToMic, [])).toBe(verdict === "delivered" || verdict === "quiet");
    expect(failingStreamsAfter([], nextToMic.sent)).toEqual(verdict === "undelivered" ? ["camera"] : []);
    expect(failingStreamsAfter(["camera"], nextToMic.sent)).toEqual(verdict === "delivered" ? [] : ["camera"]);
  });

  it.each<[string, number, number | null, string]>([
    ["sent with a newer report", 200, 2_000, "delivered"],
    ["sent with no newer report", 200, 1_000, "undelivered"],
    ["quiet with no newer report", 100, 1_000, "quiet"],
  ])("on an SFU that cannot count, a producer %s is %s", (_name, packetsSent, reportAt, verdict) => {
    expect(
      judgeProducerDelivery({
        before: { packetsSent: 100, receiverReportAt: 1_000 },
        after: { packetsSent, receiverReportAt: reportAt },
        arrivedBefore: undefined,
        arrivedAfter: undefined,
        sfuReports: false,
      }),
    ).toBe(verdict);
  });

  it("compares a camera against its last counted sample through a sample with no stats row", () => {
    const sample = (camera: number | null) =>
      readMediaPath(
        camera === null
          ? []
          : [{ type: "outbound-rtp", id: "OUT-1", mid: "1", packetsSent: camera, bytesSent: camera * 100 }],
        "send",
      );
    const step = (
      known: ReturnType<typeof advanceProducerDeliveries>,
      camera: number | null,
      sfuCamera: number,
    ) =>
      advanceProducerDeliveries(known.counters, sample(camera), {
        producers: [cameraProducer],
        sfuCounts: { camera: sfuCamera },
        sfuReports: true,
      });
    const first = step({ counters: {}, streams: {} }, 100, 90);
    const failing = step(first, 200, 90);
    const noRow = step(failing, null, 90);

    expect([first, failing, noRow].map(({ streams }) => streams.camera)).toEqual([
      "unconfirmed",
      "undelivered",
      "unconfirmed",
    ]);
    expect(step(noRow, 300, 150).streams.camera).toBe("delivered");
    expect(step(noRow, 300, 90).streams.camera).toBe("undelivered");
  });
});

describe("the one proof that a path carries what is sent", () => {
  type Stream = { mid: string; packetsSent: number; reportAt: number | null };
  const stats = (streams: Stream[]) =>
    streams.flatMap(({ mid, packetsSent, reportAt }) => [
      { type: "outbound-rtp", id: `OUT-${mid}`, mid, packetsSent, bytesSent: packetsSent * 100 },
      ...(reportAt === null
        ? []
        : [{ type: "remote-inbound-rtp", id: `RI-${mid}`, localId: `OUT-${mid}`, timestamp: reportAt }]),
    ]);
  const sendReading = (mic: [number, number | null], camera: [number, number | null]) =>
    readMediaPath(
      stats([
        { mid: "0", packetsSent: mic[0], reportAt: mic[1] },
        { mid: "1", packetsSent: camera[0], reportAt: camera[1] },
      ]),
      "send",
    );
  const relay = "turn:127.0.0.1:6519?transport=udp";
  const watched = (
    second: { sfu: Record<string, number> | null; reportAt: number | null; sfuReports?: boolean },
    knownFailing: SentStream[] = [],
  ) => {
    const sample = (reading: ReturnType<typeof sendReading>, at: number, sfuCounts: Record<string, number> | null) =>
      ({
        ...reading,
        at,
        connectionState: "connected",
        expectsMedia: true,
        framesOptional: false,
        sending: { producers: bothProducers, sfuCounts, sfuReports: second.sfuReports ?? true },
        knownFailing,
      }) satisfies MediaPathSample;
    const first = advanceMediaPathWatch(
      INITIAL_MEDIA_PATH_WATCH,
      sample(sendReading([50, 1_000], [300, 1_000]), 0, { mic: 40, camera: 280 }),
    );
    return advanceMediaPathWatch(
      first.watch,
      sample(sendReading([175, second.reportAt], [600, second.reportAt]), 2_500, second.sfu),
    );
  };
  const provesRelay = (result: ReturnType<typeof watched>) =>
    pathCarriesWhatIsSent(result.evidence, [])
      ? relayProvenByMedia({
          mediaBytes: result.rtpBytesMoved,
          relayBytes: { [relay]: 1_050_000 },
          previousRelayBytes: { [relay]: 1_000_000 },
        })
      : null;

  it("takes no proof from packets that leave while receiver reports keep coming and the SFU counts none", () => {
    const result = watched({ sfu: { mic: 40, camera: 280 }, reportAt: 3_400 });

    expect(result.rtpBytesMoved).toBe(42_500);
    expect(result.evidence).toEqual({ sent: { mic: "undelivered", camera: "undelivered" } });
    expect(pathCarriesWhatIsSent(result.evidence, [])).toBe(false);
    expect(result.condition).toBe("connected-without-media");
    expect(provesRelay(result)).toBeNull();
  });

  it("takes no proof from packets that leave while reports keep coming and the count reply is missing", () => {
    const result = watched({ sfu: null, reportAt: 3_400 });

    expect(result.evidence).toEqual({ sent: { mic: "unconfirmed", camera: "unconfirmed" } });
    expect(pathCarriesWhatIsSent(result.evidence, [])).toBe(false);
    expect(result.condition).toBe("flowing");
    expect(provesRelay(result)).toBeNull();
  });

  it("takes the SFU's counts as proof, with or without a newer receiver report", () => {
    for (const reportAt of [3_400, 1_000, null]) {
      const result = watched({ sfu: { mic: 165, camera: 570 }, reportAt });

      expect(result.evidence).toEqual({ sent: { mic: "delivered", camera: "delivered" } });
      expect(pathCarriesWhatIsSent(result.evidence, [])).toBe(true);
      expect(result.condition).toBe("flowing");
      expect(provesRelay(result)).toBe(relay);
    }
  });

  it("is not proven by a microphone that arrives next to a camera that does not", () => {
    const result = watched({ sfu: { mic: 165, camera: 280 }, reportAt: 3_400 });

    expect(result.evidence).toEqual({ sent: { mic: "delivered", camera: "undelivered" } });
    expect(pathCarriesWhatIsSent(result.evidence, [])).toBe(false);
    expect(provesRelay(result)).toBeNull();
  });

  describe("for a transport's whole life", () => {
    const life = (
      over: {
        mic?: [number, number | null];
        camera?: [number, number | null];
        sfu?: Record<string, number> | null;
        sfuReports?: boolean;
        producers?: SendingProducer[];
        knownFailing?: SentStream[];
      } = {},
    ) =>
      hasCarriedMedia(
        sendReading(over.mic ?? [500, 9_000], over.camera ?? [3_000, 9_000]),
        {
          producers: over.producers ?? bothProducers,
          sfuCounts: over.sfu === undefined ? { mic: 480, camera: 2_900 } : over.sfu,
          sfuReports: over.sfuReports ?? true,
        },
        over.knownFailing ?? [],
      );

    it.each<[string, Parameters<typeof life>[0], boolean]>([
      ["the SFU counted packets from every producer", {}, true],
      ["bytes left and receiver reports came back, and the SFU counted nothing", { sfu: { mic: 0, camera: 0 } }, false],
      ["the SFU counted the microphone and never the camera", { sfu: { mic: 480, camera: 0 } }, false],
      ["the count reply is missing", { sfu: null }, false],
      ["the camera's count is left out of the reply", { sfu: { mic: 480 } }, false],
      ["nothing is published on it", { producers: [], sfu: {} }, false],
      ["a camera that never sent sits next to a counted microphone", { camera: [0, null], sfu: { mic: 480, camera: 0 } }, true],
      ["that camera is known to be failing", { camera: [0, null], sfu: { mic: 480, camera: 0 }, knownFailing: ["camera"] }, false],
      ["a failing camera awaiting publish does not count as carried", { producers: [micProducer], sfu: { mic: 480 }, knownFailing: ["camera"] }, false],
      ["a camera known to be failing was counted on this transport", { knownFailing: ["camera"] }, true],
      ["an SFU that cannot count sent reports about every producer", { sfu: null, sfuReports: false }, true],
      ["an SFU that cannot count never reported on the camera", { camera: [3_000, null], sfu: null, sfuReports: false }, false],
    ])("%s", (_name, over, carried) => {
      expect(life(over)).toBe(carried);
    });

    it("reads a receive transport by the bytes that arrived on it", () => {
      const nothing = { producers: [], sfuCounts: null, sfuReports: true };

      expect(hasCarriedMedia(readMediaPath([{ type: "inbound-rtp", bytesReceived: 70 }], "recv"), nothing, [])).toBe(true);
      expect(hasCarriedMedia(readMediaPath([{ type: "inbound-rtp", bytesReceived: 0 }], "recv"), nothing, [])).toBe(false);
      expect(hasCarriedMedia(readMediaPath([], "recv"), nothing, [])).toBe(false);
    });
  });

  describe("at a check that decides whether to act", () => {
    const check = (
      evidence: PathEvidence,
      over: { knownFailing?: SentStream[]; showsLife?: boolean; carriedMedia?: boolean } = {},
    ) =>
      checkPath({
        evidence,
        knownFailing: over.knownFailing ?? [],
        showsLife: over.showsLife ?? true,
        carriedMedia: over.carriedMedia ?? true,
      });

    it.each<[string, PathEvidence, Parameters<typeof check>[1], string]>([
      ["everything sent was delivered", { sent: { mic: "delivered", camera: "delivered" } }, {}, "carries"],
      ["it was delivered with no sign of life from reports", { sent: { mic: "delivered" } }, { showsLife: false }, "carries"],
      ["it was delivered on a transport not seen carrying before", { sent: { mic: "delivered" } }, { carriedMedia: false }, "carries"],
      ["a still screen share sent nothing and reports are back", { sent: { screen: "quiet" } }, {}, "sends-nothing"],
      ["nothing is being sent and reports are back", { sent: {} }, {}, "sends-nothing"],
      ["a still screen share sent nothing and no report came", { sent: { screen: "quiet" } }, { showsLife: false }, "fails"],
      ["a still screen share sent nothing on a transport that never carried media", { sent: { screen: "quiet" } }, { carriedMedia: false }, "fails"],
      ["the quiet stream is known to be failing", { sent: { screen: "quiet" } }, { knownFailing: ["screen"] }, "fails"],
      ["the failing camera has not published yet", { sent: { mic: "delivered" } }, { knownFailing: ["camera"] }, "fails"],
      ["a stream was sent and not counted", { sent: { mic: "delivered", camera: "undelivered" } }, {}, "fails"],
      ["a count reply is missing", { sent: { mic: "unconfirmed" } }, {}, "fails"],
      ["bytes arrived on a receive path", { received: true }, { showsLife: false, carriedMedia: false }, "carries"],
      ["nothing arrived on a receive path", { received: false }, {}, "fails"],
    ])("%s", (_name, evidence, over, verdict) => {
      expect(check(evidence, over)).toBe(verdict);
    });
  });
});

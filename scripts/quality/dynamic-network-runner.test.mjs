import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CdpClient } from "./cdp.mjs";
import {
  assertDynamicNetworkTransitionRunConfiguration,
  buildDynamicNetworkRealizationEvidence,
  buildDynamicNetworkSamplerFromAlignedObservations,
  buildDynamicNetworkTransitionEvidence,
  frameVisibilityProducerIdsForAdaptationEvent,
  normalizeDynamicNetworkEndpointCheckpoint,
  sleepUntil,
  visibilityAroundInterval,
} from "./dynamic-network-runner.mjs";
import { buildDynamicNetworkTransitionPlan } from "./dynamic-network-transition.mjs";

const codec = (id = "codec-vp9") => ({
  id,
  type: "codec",
  mimeType: "video/VP9",
  payloadType: 98,
  clockRate: 90_000,
  sdpFmtpLine: "profile-id=0",
});

const transportStats = (prefix) => [
  {
    id: `${prefix}-transport`,
    type: "transport",
    dtlsState: "connected",
    selectedCandidatePairId: `${prefix}-pair`,
  },
  {
    id: `${prefix}-pair`,
    type: "candidate-pair",
    state: "succeeded",
    localCandidateId: `${prefix}-local`,
    remoteCandidateId: `${prefix}-remote`,
    currentRoundTripTime: 0.02,
  },
  {
    id: `${prefix}-local`,
    type: "local-candidate",
    protocol: "udp",
    candidateType: "host",
  },
  {
    id: `${prefix}-remote`,
    type: "remote-candidate",
    protocol: "udp",
    candidateType: "host",
  },
];

const hintRuntime = {
  current: { generation: 2, state: "poor" },
};

const publisherRaw = () => {
  const boundStats = [
    {
      id: "bound-outbound",
      type: "outbound-rtp",
      kind: "video",
      ssrc: 111,
      codecId: "bound-codec",
      transportId: "bound-transport",
      remoteId: "bound-remote-inbound",
      packetsSent: 400,
      bytesSent: 80_000,
      frameWidth: 1280,
      frameHeight: 720,
      framesPerSecond: 30,
      scalabilityMode: "L2T1",
      encoderImplementation: "libvpx",
      powerEfficientEncoder: false,
    },
    {
      id: "bound-remote-inbound",
      type: "remote-inbound-rtp",
      kind: "video",
      packetsLost: 8,
      roundTripTime: 0.03,
    },
    codec("bound-codec"),
    ...transportStats("bound"),
  ];
  return {
    debug: {
      network: { publishAdaptationQuality: "poor" },
      videoProducer: { id: "producer-1", track: { id: "track-1" } },
      adaptivePublish: {
        videoQuality: "standard",
        updateInFlight: false,
        webcamNetworkProfileAuthority: "producer-transport",
        producerTransportId: "producer-transport-1",
        producerTransportNetworkProfile: "poor",
        producerTransportMaxIncomingBitrateBps: 180_000,
        producers: {
          webcam: {
            id: "producer-1",
            trackId: "track-1",
            closed: false,
            paused: false,
            trackReadyState: "live",
            trackSettings: { width: 960, height: 540, frameRate: 24 },
            codecs: [
              {
                mimeType: "video/VP9",
                clockRate: 90_000,
                parameters: { "profile-id": 0 },
              },
            ],
            encodings: [{ active: true, scalabilityMode: "L2T1" }],
          },
        },
      },
    },
    hintRuntime,
    rtc: {
      capturedAt: 1_024_500,
      peerConnections: [
        {
          id: "stale-pc",
          senders: [
            {
              id: "stale-sender",
              track: { id: "stale-track", kind: "video", readyState: "live" },
              stats: [
                {
                  id: "stale-outbound",
                  type: "outbound-rtp",
                  kind: "video",
                  ssrc: 999,
                  codecId: "stale-codec",
                  packetsSent: 9_999,
                  bytesSent: 9_999_999,
                },
                codec("stale-codec"),
              ],
            },
          ],
        },
        {
          id: "bound-pc",
          senders: [
            {
              id: "bound-sender",
              track: { id: "track-1", kind: "video", readyState: "live" },
              parameters: {
                degradationPreference: "maintain-resolution",
                encodings: [
                  {
                    active: true,
                    maxBitrate: 160_000,
                    maxFramerate: 12,
                    scaleResolutionDownBy: 1,
                    scalabilityMode: "L2T1",
                  },
                ],
              },
              stats: boundStats,
            },
          ],
        },
      ],
    },
  };
};

const receiverRaw = () => ({
  debug: {
    network: { receiveAdaptationQuality: "poor" },
    adaptiveConsumers: {
      deferredCount: 0,
      entries: [
        {
          consumerId: "consumer-1",
          producerId: "producer-1",
          kind: "video",
          type: "webcam",
          paused: false,
          producerPaused: false,
          status: "applied",
          currentLayers: { spatialLayer: 0, temporalLayer: 0 },
          bounds: { maxSpatialLayer: 2, maxTemporalLayer: 0 },
        },
      ],
    },
  },
  hintRuntime,
  rtc: {
    capturedAt: 1_024_500,
    peerConnections: [
      {
        id: "stale-receiver-pc",
        stats: [
          {
            id: "stale-inbound",
            type: "inbound-rtp",
            kind: "video",
            ssrc: 999,
            trackIdentifier: "stale-consumer",
            codecId: "stale-codec",
            packetsReceived: 9_999,
            bytesReceived: 9_999_999,
            packetsLost: 99,
          },
          codec("stale-codec"),
        ],
      },
      {
        id: "bound-receiver-pc",
        stats: [
          {
            id: "bound-inbound",
            type: "inbound-rtp",
            kind: "video",
            ssrc: 222,
            trackIdentifier: "consumer-1",
            codecId: "bound-receiver-codec",
            transportId: "receiver-transport",
            packetsReceived: 350,
            bytesReceived: 70_000,
            packetsLost: 7,
            scalabilityMode: "L2T1",
            decoderImplementation: "libvpx",
            powerEfficientDecoder: false,
          },
          codec("bound-receiver-codec"),
          ...transportStats("receiver"),
        ],
      },
    ],
  },
});

test("schema-13 configuration accepts either exact codec scenario", () => {
  const configuration = {
    profileNames: ["pristine"],
    receiverCount: 2,
    durationMs: 103_000,
    repetitions: 1,
    requireUdp: true,
    sampleIntervalMs: 450,
    codecScenario: "all-modern",
  };
  assert.equal(
    assertDynamicNetworkTransitionRunConfiguration(configuration).codecScenario,
    "all-modern",
  );
  assert.equal(
    assertDynamicNetworkTransitionRunConfiguration({
      ...configuration,
      codecScenario: "native-compat",
    }).codecScenario,
    "native-compat",
  );
});

test("publisher checkpoint ignores a stale first RTP and uses the fixed sender", () => {
  const checkpoint = normalizeDynamicNetworkEndpointCheckpoint(
    publisherRaw(),
    "publisher",
    {
      mediaPathBinding: {
        connectionId: "bound-pc",
        senderId: "bound-sender",
        trackId: "track-1",
      },
    },
  );
  assert.equal(checkpoint.mediaPathAuthority.matched, true);
  assert.equal(checkpoint.mediaPathAuthority.connectionId, "bound-pc");
  assert.deepEqual(checkpoint.mediaPathAuthority.rtpStatIds, ["bound-outbound"]);
  assert.equal(checkpoint.transportEvidence.packets, 400);
  assert.equal(checkpoint.transportEvidence.bytes, 80_000);
  assert.equal(checkpoint.encodedWidth, 1280);
  assert.equal(checkpoint.encodedHeight, 720);
  assert.equal(checkpoint.encodedFps, 30);
  assert.equal(checkpoint.codecIdentity.payloadType, 98);
  assert.equal(checkpoint.networkProfileAuthority, "producer-transport");
  assert.equal(checkpoint.producerTransportId, "producer-transport-1");
  assert.equal(checkpoint.producerTransportNetworkProfile, "poor");
  assert.equal(checkpoint.producerTransportMaxIncomingBitrateBps, 180_000);
  assert.deepEqual(checkpoint.senderEncodingConfiguration, {
    version: 1,
    degradationPreference: "maintain-resolution",
    encodings: [
      {
        rid: null,
        active: true,
        maxBitrate: 160_000,
        maxFramerate: 12,
        scaleResolutionDownBy: 1,
        scalabilityMode: "L2T1",
      },
    ],
  });
  assert.equal(checkpoint.networkPolicyEvidence.rtcQuality, null);
  assert.equal(checkpoint.networkPolicyEvidence.rttMs, null);
});

test("publisher checkpoint follows a new source track on the fixed sender and RTP path", () => {
  const raw = publisherRaw();
  raw.debug.videoProducer.track.id = "track-2";
  raw.debug.adaptivePublish.producers.webcam.trackId = "track-2";
  raw.rtc.peerConnections[1].senders[0].track.id = "track-2";

  const checkpoint = normalizeDynamicNetworkEndpointCheckpoint(
    raw,
    "publisher",
    {
      mediaPathBinding: {
        connectionId: "bound-pc",
        senderId: "bound-sender",
        trackId: "track-1",
      },
    },
  );

  assert.equal(checkpoint.mediaPathAuthority.matched, true);
  assert.equal(checkpoint.mediaPathAuthority.connectionId, "bound-pc");
  assert.equal(checkpoint.mediaPathAuthority.senderId, "bound-sender");
  assert.equal(checkpoint.mediaPathAuthority.trackId, "track-2");
  assert.equal(checkpoint.mediaPathAuthority.producerId, "producer-1");
  assert.deepEqual(checkpoint.mediaPathAuthority.rtpStatIds, ["bound-outbound"]);
  assert.deepEqual(checkpoint.mediaPathAuthority.rtpSsrcs, ["111"]);
});

test("receiver checkpoint ignores stale RTP and fails closed on binding ambiguity", () => {
  const binding = {
    producerId: "producer-1",
    consumerId: "consumer-1",
    connectionId: "bound-receiver-pc",
    statId: "bound-inbound",
    ssrc: "222",
  };
  const raw = receiverRaw();
  const checkpoint = normalizeDynamicNetworkEndpointCheckpoint(
    raw,
    "primaryReceiver",
    { mediaPathBinding: binding },
  );
  assert.equal(checkpoint.mediaPathAuthority.matched, true);
  assert.equal(checkpoint.transportEvidence.packets, 350);
  assert.equal(checkpoint.transportEvidence.bytes, 70_000);

  raw.rtc.peerConnections.push({
    ...raw.rtc.peerConnections[1],
    stats: raw.rtc.peerConnections[1].stats.map((stat) => ({ ...stat })),
  });
  const ambiguous = normalizeDynamicNetworkEndpointCheckpoint(
    raw,
    "primaryReceiver",
    { mediaPathBinding: binding },
  );
  assert.equal(ambiguous.mediaPathAuthority.matched, false);
  assert.equal(ambiguous.transportEvidence, null);
});

test("CDP session routing carries the acknowledged flattened session id", async () => {
  const client = new CdpClient("ws://unused");
  let payload = null;
  client.socket = {
    send(value) {
      payload = JSON.parse(value);
    },
    close() {},
  };
  const pending = client.sendToSession(
    "acknowledged-session",
    "Network.enable",
    {},
  );
  assert.equal(payload.sessionId, "acknowledged-session");
  assert.equal(payload.method, "Network.enable");
  client.close();
  await assert.rejects(pending, /closed/);

  const runnerSource = readFileSync(
    new URL("./run-headless-video-quality.mjs", import.meta.url),
    "utf8",
  );
  const silentContractSource = readFileSync(
    new URL("./silent-browser-contract.mjs", import.meta.url),
    "utf8",
  );
  assert.match(silentContractSource, /Target\.attachToTarget/);
  assert.match(silentContractSource, /flatten:\s*true/);
  assert.match(silentContractSource, /createExactTargetNetworkFacade/);
  assert.match(runnerSource, /dynamicNetworkCdp = session\.networkCdp/);
  assert.match(runnerSource, /dynamicNetworkCdp\.sessionId/);
  assert.match(runnerSource, /applyNetworkProfile\(dynamicNetworkCdp/);
  assert.match(runnerSource, /cdp:\s*browser\.dynamicNetworkCdp/);
  assert.doesNotMatch(runnerSource, /Target\.attachToTarget/);
  assert.doesNotMatch(runnerSource, /collectCheckpoint:\s*async/);
});

test("shared aligned sampler reuses one publisher and two receiver observers", () => {
  const plan = buildDynamicNetworkTransitionPlan({
    windowId: "aligned-window",
    startedAtEpochMs: 1_000_000,
  });
  const publisherBinding = {
    connectionId: "bound-pc",
    senderId: "bound-sender",
    trackId: "track-1",
  };
  const receiverBinding = {
    producerId: "producer-1",
    consumerId: "consumer-1",
    connectionId: "bound-receiver-pc",
    statId: "bound-inbound",
    ssrc: "222",
  };
  const publisherCheckpoint = normalizeDynamicNetworkEndpointCheckpoint(
    publisherRaw(),
    "publisher",
    { mediaPathBinding: publisherBinding },
  );
  const expectedCount = 207;
  const scheduledAt = (index) =>
    index === expectedCount - 1
      ? plan.measurementWindow.endedAtEpochMs - 50
      : plan.measurementWindow.startedAtEpochMs + index * 500;
  const publisherObservations = Array.from(
    { length: expectedCount },
    (_, index) => ({
      scheduledAtEpochMs: scheduledAt(index),
      capturedAtEpochMs: scheduledAt(index),
      dynamicNetworkCheckpoint: structuredClone(publisherCheckpoint),
    }),
  );
  const receiverObservations = () =>
    Array.from({ length: expectedCount }, (_, index) => {
      const raw = receiverRaw();
      raw.rtc.capturedAt = scheduledAt(index);
      return {
        scheduledAtEpochMs: scheduledAt(index),
        capturedAtEpochMs: scheduledAt(index),
        dynamicNetworkRaw: raw,
      };
    });
  const primaryObservations = receiverObservations();
  const controlObservations = receiverObservations();
  const receiverMeasurement = (observations) => ({
    mediaPathBinding: {
      expected: receiverBinding,
      observations,
      observerMetadata: {
        skippedTickCount: 0,
        captureErrors: [],
      },
    },
  });
  const sampler = buildDynamicNetworkSamplerFromAlignedObservations({
    plan,
    publisherObservationWindow: {
      observations: publisherObservations,
      skippedTickCount: 0,
      captureErrorCount: 0,
    },
    primaryReceiverMeasurement: receiverMeasurement(primaryObservations),
    controlReceiverMeasurement: receiverMeasurement(controlObservations),
  });
  assert.equal(sampler.checkpoints.length, expectedCount);
  assert.equal(sampler.checkpoints.at(-1).scheduledOffsetMs, 103_000);
  assert.equal(
    sampler.observerAuthority.source,
    "publisher-codec-plus-receiver-path-observers",
  );
  assert.equal("dynamicNetworkRaw" in primaryObservations[0], false);
  assert.equal("dynamicNetworkRaw" in controlObservations[0], false);
  const realization = buildDynamicNetworkRealizationEvidence({
    plan,
    sampler,
    cdp: { mutations: [] },
    networkHints: {},
  });
  assert.equal(realization.version, 2);
  assert.deepEqual(
    [
      realization.baseline,
      realization.receiverLimited,
      realization.publisherLimited,
      realization.recovered,
    ].map((stage) => [
      stage.phase,
      stage.counterStartScheduledOffsetMs,
      stage.counterEndScheduledOffsetMs,
    ]),
    [
      ["baseline", 500, 11_500],
      ["receiverLimited", 12_500, 23_500],
      ["publisherLimited", 24_500, 35_500],
      ["recovered", 91_500, 102_500],
    ],
  );
});

test("codec phase evidence survives a real adaptation milestone miss", () => {
  const plan = buildDynamicNetworkTransitionPlan({
    windowId: "codec-phase-window",
    startedAtEpochMs: 1_000_000,
  });
  const snapshots = {
    publisher: normalizeDynamicNetworkEndpointCheckpoint(
      publisherRaw(),
      "publisher",
      {
        mediaPathBinding: {
          connectionId: "bound-pc",
          senderId: "bound-sender",
          trackId: "track-1",
        },
      },
    ),
    primaryReceiver: normalizeDynamicNetworkEndpointCheckpoint(
      receiverRaw(),
      "primaryReceiver",
      {
        mediaPathBinding: {
          producerId: "producer-1",
          consumerId: "consumer-1",
          connectionId: "bound-receiver-pc",
          statId: "bound-inbound",
          ssrc: "222",
        },
      },
    ),
    controlReceiver: normalizeDynamicNetworkEndpointCheckpoint(
      receiverRaw(),
      "controlReceiver",
      {
        mediaPathBinding: {
          producerId: "producer-1",
          consumerId: "consumer-1",
          connectionId: "bound-receiver-pc",
          statId: "bound-inbound",
          ssrc: "222",
        },
      },
    ),
  };
  const sampler = {
    instanceId: "codec-phase-sampler",
    windowId: plan.measurementWindow.id,
    checkpoints: Array.from({ length: 207 }, (_, index) => {
      const scheduledOffsetMs = index === 206 ? 103_000 : index * 500;
      return {
        index,
        scheduledOffsetMs,
        capturedOffsetMs: scheduledOffsetMs,
        endpointSnapshots: structuredClone(snapshots),
      };
    }),
  };
  const evidence = buildDynamicNetworkTransitionEvidence({
    controllerEvidence: {
      plan,
      sampler,
      cdp: { mutations: [] },
      networkHints: {},
      controllerFailures: [],
    },
    measurement: { captureToDisplayPresentation: { observations: [] } },
    bindings: {
      primaryReceiver: { targetId: "primary", sessionId: "primary-session" },
      controlReceiver: { targetId: "control", sessionId: "control-session" },
    },
  });

  assert.equal(evidence.codec.phaseIdentities.pristine.mimeType, "video/vp9");
  assert.equal(evidence.codec.phaseIdentities.poor.mimeType, "video/vp9");
  assert.equal(evidence.codec.phaseIdentities.recovered.mimeType, "video/vp9");
  assert.equal(evidence.codec.producerLineage.poorProducerId, "producer-1");
  assert.equal(evidence.codec.producerLineage.recoveredProducerId, "producer-1");
  assert.equal(
    evidence.continuity.frameVisibility.downshift.adaptationProofStartOffsetMs,
    null,
  );
});

test("stable-producer frame visibility binds to adaptation signatures", () => {
  const event = {
    fromSignature: { producerId: "stable-producer" },
    toSignature: { producerId: "stable-producer" },
  };

  assert.deepEqual(frameVisibilityProducerIdsForAdaptationEvent(event), {
    fromProducerId: "stable-producer",
    toProducerId: "stable-producer",
  });
  assert.deepEqual(
    frameVisibilityProducerIdsForAdaptationEvent({}, "fallback-producer"),
    {
      fromProducerId: "fallback-producer",
      toProducerId: "fallback-producer",
    },
  );
});

test("adaptation visibility measures consecutive rVFC gaps instead of checkpoint bracketing", () => {
  const startedAtEpochMs = 1_000_000;
  const frameOffsets = [950, 1_030, 1_110, 1_190, 1_270, 1_350, 1_430, 1_510];
  const visibility = visibilityAroundInterval({
    eventIntervalStartOffsetMs: 1_000,
    eventIntervalEndOffsetMs: 1_500,
    presentations: frameOffsets.map((offset) => ({
      presentedAtEpochMs: startedAtEpochMs + offset,
    })),
    plan: { measurementWindow: { startedAtEpochMs } },
  });

  assert.deepEqual(visibility.adaptationIntervalFrameOffsets, frameOffsets);
  assert.equal(visibility.visibleFrameCountWithinAdaptationInterval, 6);
  assert.equal(visibility.visibleGapMs, 80);
  assert.equal(visibility.lastVisibleFrameAtOffsetMs, 950);
  assert.equal(visibility.firstVisibleFrameAtOffsetMs, 1_030);
  assert.equal(1_510 - 950, 560);
});

test("absolute transition scheduling retries timer wakeups that occur early", async () => {
  let currentEpochMs = 950;
  const requestedDelays = [];

  await sleepUntil({
    targetEpochMs: 1_000,
    now: () => currentEpochMs,
    setTimer: (callback, delayMs) => {
      requestedDelays.push(delayMs);
      currentEpochMs += Math.max(1, delayMs - 2);
      callback();
      return null;
    },
  });

  assert.deepEqual(requestedDelays, [50, 2, 1]);
  assert.equal(currentEpochMs, 1_000);
});

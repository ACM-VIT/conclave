import assert from "node:assert/strict";
import test from "node:test";
import {
  assessNativeVp8PublisherReadiness,
  expectedActiveVideoSenderEncodingCount,
  expectedNativeVp8PublisherTopology,
  parseVideoQualityReceiverCount,
} from "./receiver-count.mjs";

test("receiver count defaults to one and accepts the bounded range", () => {
  assert.equal(parseVideoQualityReceiverCount(undefined), 1);
  assert.equal(parseVideoQualityReceiverCount(""), 1);
  assert.equal(parseVideoQualityReceiverCount("1"), 1);
  assert.equal(parseVideoQualityReceiverCount("4"), 4);
});

test("receiver count rejects unsafe or ambiguous values", () => {
  for (const value of ["0", "5", "1.5", "two", "Infinity"]) {
    assert.throws(
      () => parseVideoQualityReceiverCount(value),
      /receiver count must be an integer from 1 to 4/,
    );
  }
});

test("native VP8 uses one true encoding for one receiver and simulcast otherwise", () => {
  assert.equal(
    expectedActiveVideoSenderEncodingCount({
      codecScenario: "native-compat",
      receiverCount: 1,
    }),
    1,
  );
  for (const receiverCount of [2, 3, 4]) {
    assert.equal(
      expectedActiveVideoSenderEncodingCount({
        codecScenario: "native-compat",
        receiverCount,
      }),
      3,
    );
  }
  assert.equal(
    expectedActiveVideoSenderEncodingCount({
      codecScenario: "all-modern",
      receiverCount: 4,
    }),
    1,
  );
});

test("sole-receiver topology is one full-rate RID-less VP8 encoding", () => {
  assert.deepEqual(expectedNativeVp8PublisherTopology(1), {
    mode: "single-receiver",
    producerTopology: "vp8-single-layer",
    transitionPhase: "single",
    receiverCapacityProofBasis: "single-layer",
    producerReplacementRequired: true,
    encodingCount: 1,
    activeEncodingCount: 1,
    encodings: [
      {
        rid: null,
        maxBitrate: 1_650_000,
        maxFramerate: 30,
        scalabilityMode: "L1T1",
      },
    ],
  });
});

test("multi-receiver topology preserves the complete adaptive VP8 ladder", () => {
  assert.deepEqual(expectedNativeVp8PublisherTopology(4), {
    mode: "adaptive-layers",
    producerTopology: "vp8-simulcast",
    transitionPhase: "adaptive",
    receiverCapacityProofBasis: null,
    producerReplacementRequired: false,
    encodingCount: 3,
    activeEncodingCount: 3,
    encodings: [
      {
        rid: "r0",
        maxBitrate: 80_000,
        maxFramerate: 12,
        scalabilityMode: "L1T1",
      },
      {
        rid: "r1",
        maxBitrate: 220_000,
        maxFramerate: 20,
        scalabilityMode: "L1T1",
      },
      {
        rid: "r2",
        maxBitrate: 1_650_000,
        maxFramerate: 30,
        scalabilityMode: "L1T1",
      },
    ],
  });
});

const adaptivePublishSnapshot = ({
  receiverCount,
  producerId = "producer-final",
  encodings,
}) => {
  const single = receiverCount === 1;
  return {
    participantCount: receiverCount + 1,
    receiverCapacityProofProducerId: single ? producerId : null,
    receiverCapacityProofBasis: single ? "single-layer" : null,
    receiverCapacityHandoffOffered: false,
    webcamProducerTopology: single ? "vp8-single-layer" : "vp8-simulcast",
    webcamTopologyTransitionPhase: single ? "single" : "adaptive",
    lastAppliedProfiles: {
      webcam: `${producerId}:standard:good:adaptive-layers`,
    },
    producers: {
      webcam: {
        id: producerId,
        closed: false,
        paused: false,
        trackId: "track-final",
        trackReadyState: "live",
        encodings: encodings.map((encoding) => ({
          ...encoding,
          active: true,
        })),
      },
    },
  };
};

const publisherRtcSnapshot = (encodings) => ({
  encodingCount: encodings.length,
  activeEncodingCount: encodings.length,
  averageVideoBitrateBps: 1_000_000,
  binding: {
    matched: true,
    reasons: [],
    senderId: "sender-final",
    connectionId: "pc-publisher",
    trackId: "track-final",
  },
  encodings: encodings.map((encoding, index) => ({
    id: `out-${index}`,
    rid: encoding.rid,
    active: true,
    transmitted: true,
    bytesSentDelta: 100_000 + index,
    framesEncodedDelta: 30,
    codecMimeType: "video/VP8",
    scalabilityMode: encoding.scalabilityMode,
  })),
});

const validReadinessInput = (receiverCount) => {
  const expected = expectedNativeVp8PublisherTopology(receiverCount);
  const producerId = "producer-final";
  return {
    receiverCount,
    initialProducerId:
      receiverCount === 1 ? "producer-vp8-simulcast" : producerId,
    adaptivePublish: adaptivePublishSnapshot({
      receiverCount,
      producerId,
      encodings: expected.encodings,
    }),
    publisherRtc: publisherRtcSnapshot(expected.encodings),
  };
};

test("sole-receiver readiness requires replacement, final proof, and flowing RTP", () => {
  const assessment = assessNativeVp8PublisherReadiness(validReadinessInput(1));
  assert.equal(assessment.ready, true);
  assert.deepEqual(assessment.reasons, []);
  assert.deepEqual(assessment.transition, {
    required: true,
    initialProducerId: "producer-vp8-simulcast",
    finalProducerId: "producer-final",
    observed: true,
    finalProducerTopology: "vp8-single-layer",
    finalTransitionPhase: "single",
    finalProofBasis: "single-layer",
  });
});

test("sole-receiver readiness rejects the former three-layer standby contract", () => {
  const input = validReadinessInput(1);
  input.adaptivePublish.webcamProducerTopology = "vp8-simulcast";
  input.adaptivePublish.producers.webcam.encodings = [
    { rid: "r0", active: true, maxBitrate: 35_000, maxFramerate: 12 },
    { rid: "r1", active: true, maxBitrate: 90_000, maxFramerate: 20 },
    { rid: "r2", active: true, maxBitrate: 1_750_000, maxFramerate: 30 },
  ];
  input.publisherRtc = publisherRtcSnapshot(
    input.adaptivePublish.producers.webcam.encodings,
  );

  const assessment = assessNativeVp8PublisherReadiness(input);
  assert.equal(assessment.ready, false);
  assert.match(assessment.reasons.join("\n"), /vp8-single-layer/);
  assert.match(assessment.reasons.join("\n"), /configured sender encoding count/);
  assert.match(assessment.reasons.join("\n"), /outbound RTP encoding count/);
});

test("sole-receiver readiness rejects extra zero-traffic RTP placeholders", () => {
  const input = validReadinessInput(1);
  input.publisherRtc.encodingCount = 2;
  input.publisherRtc.encodings.push({
    id: "out-placeholder",
    rid: "r0",
    active: false,
    transmitted: false,
    bytesSentDelta: 0,
    framesEncodedDelta: 0,
    codecMimeType: "video/VP8",
  });

  const assessment = assessNativeVp8PublisherReadiness(input);
  assert.equal(assessment.ready, false);
  assert.match(assessment.reasons.join("\n"), /outbound RTP encoding count/);
  assert.match(assessment.reasons.join("\n"), /not live and transmitting/);
  assert.match(assessment.reasons.join("\n"), /sent no bytes/);
  assert.match(assessment.reasons.join("\n"), /encoded no frames/);
});

test("sole-receiver readiness rejects every missing authority signal", () => {
  const cases = [
    ["producer replacement", (input) => {
      input.initialProducerId = "producer-final";
    }],
    ["single topology", (input) => {
      input.adaptivePublish.webcamProducerTopology = "vp8-simulcast";
    }],
    ["single phase", (input) => {
      input.adaptivePublish.webcamTopologyTransitionPhase = "awaiting-proof";
    }],
    ["final proof producer", (input) => {
      input.adaptivePublish.receiverCapacityProofProducerId = "stale-producer";
    }],
    ["final proof basis", (input) => {
      input.adaptivePublish.receiverCapacityProofBasis =
        "single-layer-transition";
    }],
    ["completed proof handoff", (input) => {
      input.adaptivePublish.receiverCapacityHandoffOffered = true;
    }],
    ["live track", (input) => {
      input.adaptivePublish.producers.webcam.trackReadyState = "ended";
    }],
    ["participant count", (input) => {
      input.adaptivePublish.participantCount = 3;
    }],
    ["full-layer cap", (input) => {
      input.adaptivePublish.producers.webcam.encodings[0].maxBitrate = 1_749_999;
    }],
    ["full-layer fps", (input) => {
      input.adaptivePublish.producers.webcam.encodings[0].maxFramerate = 29;
    }],
    ["active sender", (input) => {
      input.adaptivePublish.producers.webcam.encodings[0].active = false;
    }],
    ["actual VP8", (input) => {
      input.publisherRtc.encodings[0].codecMimeType = "video/VP9";
    }],
    ["configured L1T1", (input) => {
      input.adaptivePublish.producers.webcam.encodings[0].scalabilityMode =
        "L1T3";
    }],
    ["outbound L1T1", (input) => {
      input.publisherRtc.encodings[0].scalabilityMode = "L1T3";
    }],
    ["producer-bound sender stats", (input) => {
      input.publisherRtc.binding.trackId = "stale-track";
    }],
  ];

  for (const [name, mutate] of cases) {
    const input = validReadinessInput(1);
    mutate(input);
    assert.equal(
      assessNativeVp8PublisherReadiness(input).ready,
      false,
      name,
    );
  }
});

test("multi-receiver readiness requires the unchanged flowing three-layer producer", () => {
  for (const receiverCount of [2, 3, 4]) {
    const assessment = assessNativeVp8PublisherReadiness(
      validReadinessInput(receiverCount),
    );
    assert.equal(assessment.ready, true, `receiverCount=${receiverCount}`);
    assert.equal(assessment.transition.required, false);
    assert.equal(assessment.transition.observed, false);
  }
});

test("multi-receiver readiness rejects producer replacement or any missing layer", () => {
  const replaced = validReadinessInput(2);
  replaced.initialProducerId = "previous-producer";
  assert.equal(assessNativeVp8PublisherReadiness(replaced).ready, false);

  const missingLayer = validReadinessInput(2);
  missingLayer.adaptivePublish.producers.webcam.encodings.pop();
  missingLayer.publisherRtc.encodings.pop();
  missingLayer.publisherRtc.encodingCount = 2;
  missingLayer.publisherRtc.activeEncodingCount = 2;
  const assessment = assessNativeVp8PublisherReadiness(missingLayer);
  assert.equal(assessment.ready, false);
  assert.match(assessment.reasons.join("\n"), /expected 3/);
});

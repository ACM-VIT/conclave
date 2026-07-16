import assert from "node:assert/strict";
import test from "node:test";
import {
  assessConsumerGenerationReset,
  shouldExpectStartupConsumerGenerationReset,
} from "./consumer-generation-reset.mjs";

const completedEntry = {
  producerId: "producer-1",
  previousConsumerId: "consumer-1",
  replacementConsumerId: "consumer-2",
  reason: "startup-simulcast-jitter-reset",
  status: "completed",
  startedAt: 1_000,
  replacementStartedAt: 1_050,
  completedAt: 1_180,
  attempt: 1,
  maximumSpatialLayer: 2,
  observedSpatialLayer: 2,
  failureReason: null,
};

const startup = {
  version: 2,
  frameContinuity: {
    supported: true,
    presentedFrameCount: 100,
    lastPresentedConsumerId: "consumer-2",
    lastPresentedProducerId: "producer-1",
    firstDecodeThroughFirstConsumerTransitionMaximumGapMs: 110,
    consumerGenerationTransitions: [
      {
        fromConsumerId: "consumer-1",
        toConsumerId: "consumer-2",
        fromProducerId: "producer-1",
        toProducerId: "producer-1",
        visibleInterruptionMs: 96,
      },
    ],
  },
};

const receiverConsumer = {
  producerId: "producer-1",
  consumerId: "consumer-2",
  preferredLayers: { spatialLayer: 2, temporalLayer: 0 },
  currentLayers: { spatialLayer: 2, temporalLayer: 0 },
};

const validInput = () => ({
  codecScenario: "native-compat",
  receiverCount: 3,
  expectedProducerId: "producer-1",
  receiverConsumer,
  publisherTopologyMode: "adaptive-layers",
  producerTopologyTransition: null,
  debugVersion: 1,
  resetEntries: [completedEntry],
  startup,
  maximumVisibleInterruptionMs: 200,
});

test("top-layer multi-receiver VP8 requires one audited visible reset", () => {
  assert.equal(
    shouldExpectStartupConsumerGenerationReset(validInput()),
    true,
  );
  const assessment = assessConsumerGenerationReset(validInput());
  assert.equal(assessment.valid, true);
  assert.equal(assessment.passed, true);
  assert.equal(assessment.visibleInterruptionMs, 96);
  assert.equal(assessment.firstDecodeThroughResetMaximumGapMs, 110);
  assert.deepEqual(assessment.harnessFailures, []);
  assert.deepEqual(assessment.productFailures, []);
});

test("legacy or missing evidence invalidates the harness", () => {
  for (const mutate of [
    (input) => {
      input.debugVersion = undefined;
    },
    (input) => {
      input.resetEntries = undefined;
    },
    (input) => {
      input.resetEntries[0] = {
        ...input.resetEntries[0],
        replacementStartedAt: undefined,
      };
    },
    (input) => {
      input.startup = { version: 1 };
    },
    (input) => {
      input.startup.frameContinuity.supported = false;
    },
  ]) {
    const input = validInput();
    input.resetEntries = input.resetEntries?.map((entry) => ({ ...entry }));
    input.startup = {
      ...input.startup,
      frameContinuity: { ...input.startup.frameContinuity },
    };
    mutate(input);
    const assessment = assessConsumerGenerationReset(input);
    assert.equal(assessment.valid, false);
    assert.ok(assessment.harnessFailures.length > 0);
  }
});

test("missing, duplicate, slow, or unbound resets fail product gates", () => {
  const cases = [
    {
      name: "missing",
      mutate(input) {
        input.resetEntries = [];
      },
    },
    {
      name: "duplicate",
      mutate(input) {
        input.resetEntries.push({
          ...completedEntry,
          previousConsumerId: "consumer-0",
        });
      },
    },
    {
      name: "slow",
      mutate(input) {
        input.resetEntries[0].completedAt = 20_000;
      },
    },
    {
      name: "wrong final consumer",
      mutate(input) {
        input.resetEntries[0].replacementConsumerId = "consumer-other";
      },
    },
    {
      name: "excessive attempts",
      mutate(input) {
        input.resetEntries[0].attempt = 3;
      },
    },
    {
      name: "visible freeze",
      mutate(input) {
        input.startup.frameContinuity.consumerGenerationTransitions[0] = {
          ...input.startup.frameContinuity.consumerGenerationTransitions[0],
          visibleInterruptionMs: 201,
        };
      },
    },
    {
      name: "pre-reset visible freeze",
      mutate(input) {
        input.startup.frameContinuity.firstDecodeThroughFirstConsumerTransitionMaximumGapMs =
          201;
      },
    },
  ];

  for (const { name, mutate } of cases) {
    const input = validInput();
    input.resetEntries = input.resetEntries.map((entry) => ({ ...entry }));
    input.startup = {
      ...input.startup,
      frameContinuity: {
        ...input.startup.frameContinuity,
        consumerGenerationTransitions:
          input.startup.frameContinuity.consumerGenerationTransitions.map(
            (transition) => ({ ...transition }),
          ),
      },
    };
    mutate(input);
    const assessment = assessConsumerGenerationReset(input);
    assert.equal(assessment.passed, false, name);
    assert.ok(
      assessment.productFailures.length > 0 ||
        assessment.harnessFailures.length > 0,
      name,
    );
  }
});

test("single-layer, modern, and lower-layer paths reject unexpected replacement", () => {
  for (const overrides of [
    { receiverCount: 1 },
    { codecScenario: "all-modern" },
    {
      receiverConsumer: {
        ...receiverConsumer,
        preferredLayers: { spatialLayer: 1, temporalLayer: 0 },
        currentLayers: { spatialLayer: 1, temporalLayer: 0 },
      },
    },
  ]) {
    const input = { ...validInput(), ...overrides };
    assert.equal(
      shouldExpectStartupConsumerGenerationReset(input),
      false,
    );
    const assessment = assessConsumerGenerationReset(input);
    assert.equal(assessment.passed, false);
    assert.match(
      assessment.productFailures.join("\n"),
      /no .*reset was expected|when no reset was expected/,
    );
  }
});

test("an authoritative empty audit passes when no reset is appropriate", () => {
  const input = {
    ...validInput(),
    receiverCount: 1,
    resetEntries: [],
    startup: {
      version: 2,
      frameContinuity: {
        supported: true,
        presentedFrameCount: 80,
        consumerGenerationTransitions: [],
      },
    },
  };
  const assessment = assessConsumerGenerationReset(input);
  assert.equal(assessment.expected, false);
  assert.equal(assessment.valid, true);
  assert.equal(assessment.passed, true);
});

test("true-single startup may expose its required producer handoff without calling it a planned reset", () => {
  const assessment = assessConsumerGenerationReset({
    ...validInput(),
    receiverCount: 1,
    publisherTopologyMode: "single-receiver",
    producerTopologyTransition: {
      required: true,
      observed: true,
      initialProducerId: "producer-simulcast",
      finalProducerId: "producer-1",
      finalProducerTopology: "vp8-single-layer",
      finalTransitionPhase: "single",
      finalProofBasis: "single-layer",
    },
    resetEntries: [],
    startup: {
      ...startup,
      frameContinuity: {
        ...startup.frameContinuity,
        consumerGenerationTransitions: [
          {
            ...startup.frameContinuity.consumerGenerationTransitions[0],
            fromProducerId: "producer-simulcast",
            toProducerId: "producer-1",
          },
        ],
      },
    },
  });
  assert.equal(assessment.expected, false);
  assert.equal(assessment.valid, true);
  assert.equal(assessment.passed, true);
  assert.equal(assessment.visibleTransitionCount, 1);
});

test("the true-single exception cannot mask reset churn or unbound transitions", () => {
  const base = {
    ...validInput(),
    receiverCount: 1,
    publisherTopologyMode: "single-receiver",
    producerTopologyTransition: {
      required: true,
      observed: true,
      initialProducerId: "producer-simulcast",
      finalProducerId: "producer-1",
      finalProducerTopology: "vp8-single-layer",
      finalTransitionPhase: "single",
      finalProofBasis: "single-layer",
    },
    resetEntries: [],
    startup: {
      ...startup,
      frameContinuity: {
        ...startup.frameContinuity,
        consumerGenerationTransitions: [
          {
            ...startup.frameContinuity.consumerGenerationTransitions[0],
            fromProducerId: "producer-simulcast",
            toProducerId: "producer-1",
          },
        ],
      },
    },
  };

  for (const mutate of [
    (input) => {
      input.resetEntries = [
        {
          ...completedEntry,
          status: "failed",
          completedAt: null,
          observedSpatialLayer: 1,
          failureReason: "replacement-not-playable",
        },
      ];
    },
    (input) => {
      input.startup.frameContinuity.consumerGenerationTransitions[0] = {
        ...input.startup.frameContinuity.consumerGenerationTransitions[0],
        fromProducerId: "producer-unbound",
      };
    },
    (input) => {
      input.publisherTopologyMode = "adaptive-layers";
    },
    (input) => {
      input.producerTopologyTransition = {
        ...input.producerTopologyTransition,
        observed: false,
      };
    },
  ]) {
    const input = {
      ...base,
      resetEntries: [...base.resetEntries],
      startup: {
        ...base.startup,
        frameContinuity: {
          ...base.startup.frameContinuity,
          consumerGenerationTransitions:
            base.startup.frameContinuity.consumerGenerationTransitions.map(
              (transition) => ({ ...transition }),
            ),
        },
      },
    };
    mutate(input);
    const assessment = assessConsumerGenerationReset(input);
    assert.equal(assessment.passed, false);
    assert.ok(assessment.productFailures.length > 0);
  }
});

test("failed and cancelled replacement attempts fail a non-expected lower-layer branch", () => {
  for (const status of ["failed", "cancelled"]) {
    const attempt = {
      ...completedEntry,
      status,
      completedAt: null,
      observedSpatialLayer: 1,
      failureReason:
        status === "failed"
          ? "replacement-not-playable"
          : "consumer-generation-changed",
    };
    const assessment = assessConsumerGenerationReset({
      ...validInput(),
      receiverConsumer: {
        ...receiverConsumer,
        preferredLayers: { spatialLayer: 1, temporalLayer: 0 },
        currentLayers: { spatialLayer: 1, temporalLayer: 0 },
      },
      resetEntries: [attempt],
      startup: {
        ...startup,
        frameContinuity: {
          ...startup.frameContinuity,
          consumerGenerationTransitions: [],
        },
      },
    });
    assert.equal(assessment.expected, false);
    assert.equal(assessment.passed, false);
    assert.match(
      assessment.productFailures.join("\n"),
      /unexpected churn/,
    );
  }
});

test("a lower-layer adaptive path preserves a failed wait audit without forcing churn", () => {
  const failedWait = {
    ...completedEntry,
    replacementConsumerId: null,
    status: "failed",
    replacementStartedAt: null,
    completedAt: null,
    attempt: 0,
    observedSpatialLayer: 1,
    failureReason: "high-layer-convergence-timeout",
  };
  const assessment = assessConsumerGenerationReset({
    ...validInput(),
    receiverConsumer: {
      ...receiverConsumer,
      preferredLayers: { spatialLayer: 1, temporalLayer: 0 },
      currentLayers: { spatialLayer: 1, temporalLayer: 0 },
    },
    resetEntries: [failedWait],
    startup: {
      version: 2,
      frameContinuity: {
        supported: true,
        presentedFrameCount: 80,
        lastPresentedConsumerId: "consumer-2",
        consumerGenerationTransitions: [],
      },
    },
  });
  assert.equal(assessment.expected, false);
  assert.equal(assessment.valid, true);
  assert.equal(assessment.passed, true);
  assert.equal(assessment.auditEntries[0].failureReason, failedWait.failureReason);
});

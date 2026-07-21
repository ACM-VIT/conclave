import { describe, expect, it, vi } from "vitest";
import {
  advanceWebcamTopologyTransition,
  createLatestWinsTopologyReplacementQueue,
  createWebcamTopologyTransitionState,
  getWebcamTopologyReplacementFailureDisposition,
  isAmbiguousWebcamTopologyReplacementError,
  settleWebcamTopologyTransition,
  WEBCAM_SINGLE_RECEIVER_ENTRY_STABLE_MS,
  WEBCAM_SINGLE_RECEIVER_REENTRY_COOLDOWN_MS,
  type WebcamTopologyReplacementCommand,
  type WebcamTopologyTransitionInput,
} from "../src/app/lib/webcam-topology-transition";
import { produceWebcamTrackWithRawTrackFallback } from "../src/app/lib/webcam-codec";

const input = (
  now: number,
  overrides: Partial<WebcamTopologyTransitionInput> = {},
): WebcamTopologyTransitionInput => ({
  now,
  producerId: "simulcast-a",
  producerTopology: "vp8-simulcast",
  hardSingleReceiverConditionsMet: true,
  sourceProofActive: true,
  sourceRevocationReason: null,
  replacementOffer: {
    nonce: "server-nonce",
    expiresAtMonotonicMs: 10_000,
  },
  successorProof: null,
  currentSingleProofActive: false,
  currentSingleProofRevocationReason: null,
  ...overrides,
});

const enterSingle = () => {
  let state = createWebcamTopologyTransitionState(0);
  state = advanceWebcamTopologyTransition(state, input(0)).state;
  const entered = advanceWebcamTopologyTransition(
    state,
    input(WEBCAM_SINGLE_RECEIVER_ENTRY_STABLE_MS),
  );
  expect(entered.state.phase.kind).toBe("entering");
  expect(entered.command).toMatchObject({
    target: "single-receiver",
    expectedProducerId: "simulcast-a",
    transition: {
      fromProducerId: "simulcast-a",
      nonce: "server-nonce",
    },
  });
  return {
    state: entered.state,
    command: entered.command as WebcamTopologyReplacementCommand,
  };
};

describe("webcam topology transition state machine", () => {
  it("enters only after stable server authority and accepts a staged successor", () => {
    const entered = enterSingle();
    const successorInput = input(1_600, {
      producerId: "single-b",
      producerTopology: "vp8-single-layer",
      sourceProofActive: false,
      sourceRevocationReason: "producer_removed",
      replacementOffer: null,
      successorProof: {
        producerId: "single-b",
        expiresAtMonotonicMs: 6_600,
      },
      currentSingleProofActive: true,
    });
    const settled = settleWebcamTopologyTransition(
      entered.state,
      entered.command,
      {
        status: "applied",
        producerId: "single-b",
        topology: "vp8-single-layer",
      },
      successorInput,
    );

    expect(settled.state.phase).toEqual({
      kind: "single",
      producerId: "single-b",
    });
    expect(settled.command).toBeNull();
  });

  it("accepts steady single-layer proof when it replaces transition proof before settlement", () => {
    const entered = enterSingle();
    const settled = settleWebcamTopologyTransition(
      entered.state,
      entered.command,
      {
        status: "applied",
        producerId: "single-b",
        topology: "vp8-single-layer",
      },
      input(1_600, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
        sourceProofActive: false,
        sourceRevocationReason: "producer_replaced",
        replacementOffer: null,
        successorProof: null,
        currentSingleProofActive: true,
      }),
    );

    expect(settled.state.phase).toEqual({
      kind: "single",
      producerId: "single-b",
    });
    expect(settled.command).toBeNull();
  });

  it("waits for an event-before-ref successor and exits if handoff proof never arrives", () => {
    const entered = enterSingle();
    const afterCommit = settleWebcamTopologyTransition(
      entered.state,
      entered.command,
      {
        status: "applied",
        producerId: "single-b",
        topology: "vp8-single-layer",
      },
      input(1_600, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
        sourceProofActive: false,
        sourceRevocationReason: "producer_removed",
        replacementOffer: null,
      }),
    );
    expect(afterCommit.state.phase.kind).toBe("awaiting-proof");

    const deadline =
      afterCommit.state.phase.kind === "awaiting-proof"
        ? afterCommit.state.phase.deadline
        : 0;
    const expired = advanceWebcamTopologyTransition(
      afterCommit.state,
      input(deadline, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
        hardSingleReceiverConditionsMet: true,
        sourceProofActive: false,
        sourceRevocationReason: "producer_removed",
        replacementOffer: null,
      }),
    );
    expect(expired.state.phase.kind).toBe("exiting");
    expect(expired.command?.target).toBe("adaptive-layers");
  });

  it("marks an in-flight entry for immediate exit when quality or participants change", () => {
    const entered = enterSingle();
    const revoked = advanceWebcamTopologyTransition(
      entered.state,
      input(1_550, { hardSingleReceiverConditionsMet: false }),
    );
    expect(revoked.state.phase).toMatchObject({
      kind: "entering",
      exitRequested: true,
    });

    const settled = settleWebcamTopologyTransition(
      revoked.state,
      entered.command,
      {
        status: "applied",
        producerId: "single-b",
        topology: "vp8-single-layer",
      },
      input(1_600, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
        hardSingleReceiverConditionsMet: false,
      }),
    );
    expect(settled.state.phase.kind).toBe("exiting");
    expect(settled.command).toMatchObject({
      target: "adaptive-layers",
      expectedProducerId: "single-b",
    });
  });

  it("exits single mode immediately on proof revocation and enforces a 30s cooldown", () => {
    const entered = enterSingle();
    const single = settleWebcamTopologyTransition(
      entered.state,
      entered.command,
      {
        status: "applied",
        producerId: "single-b",
        topology: "vp8-single-layer",
      },
      input(1_600, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
        successorProof: {
          producerId: "single-b",
          expiresAtMonotonicMs: 6_600,
        },
        currentSingleProofActive: true,
      }),
    );
    const exit = advanceWebcamTopologyTransition(
      single.state,
      input(1_700, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
        currentSingleProofActive: false,
        currentSingleProofRevocationReason: "receiver_count",
      }),
    );
    expect(exit.command?.target).toBe("adaptive-layers");

    const restored = settleWebcamTopologyTransition(
      exit.state,
      exit.command as WebcamTopologyReplacementCommand,
      {
        status: "applied",
        producerId: "simulcast-c",
        topology: "vp8-simulcast",
      },
      input(1_800, {
        producerId: "simulcast-c",
        producerTopology: "vp8-simulcast",
      }),
    );
    expect(restored.state.reentryNotBefore).toBe(
      1_800 + WEBCAM_SINGLE_RECEIVER_REENTRY_COOLDOWN_MS,
    );
    const beforeCooldown = advanceWebcamTopologyTransition(
      restored.state,
      input(restored.state.reentryNotBefore - 1, {
        producerId: "simulcast-c",
      }),
    );
    expect(beforeCooldown.command).toBeNull();
    expect(beforeCooldown.state.phase.kind).toBe("adaptive");
  });

  it("retries a failed fail-safe exit instead of returning to single", () => {
    const state = {
      ...createWebcamTopologyTransitionState(0),
      phase: {
        kind: "exiting" as const,
        producerId: "single-b",
        reason: "proof revoked",
        inFlightCommandId: 7,
        retryAfter: 0,
      },
      nextCommandId: 8,
    };
    const command: WebcamTopologyReplacementCommand = {
      id: 7,
      target: "adaptive-layers",
      expectedProducerId: "single-b",
    };
    const failed = settleWebcamTopologyTransition(
      state,
      command,
      {
        status: "failed",
        producerId: "single-b",
        topology: "vp8-single-layer",
        retryable: true,
      },
      input(2_000, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
      }),
    );
    expect(failed.state.phase).toMatchObject({
      kind: "exiting",
      inFlightCommandId: null,
    });
    const retryAt =
      failed.state.phase.kind === "exiting"
        ? failed.state.phase.retryAfter
        : 0;
    const retry = advanceWebcamTopologyTransition(
      failed.state,
      input(retryAt, {
        producerId: "single-b",
        producerTopology: "vp8-single-layer",
      }),
    );
    expect(retry.command?.target).toBe("adaptive-layers");
  });
});

describe("latest-wins topology replacement queue", () => {
  it("serializes replacement and supersedes only obsolete pending work", async () => {
    let releaseFirst!: () => void;
    const apply = vi.fn(async (value: string) => {
      if (value === "first") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return value;
    });
    const queue = createLatestWinsTopologyReplacementQueue(apply);

    const first = queue.request("first");
    await Promise.resolve();
    const second = queue.request("second");
    const third = queue.request("third");
    await expect(second).resolves.toEqual({ status: "superseded" });
    releaseFirst();

    await expect(first).resolves.toBe("first");
    await expect(third).resolves.toBe("third");
    expect(apply.mock.calls.map(([value]) => value)).toEqual([
      "first",
      "third",
    ]);
  });
});

describe("topology replacement failure classification", () => {
  it("treats signalling ambiguity as compensating-recovery territory", () => {
    expect(
      isAmbiguousWebcamTopologyReplacementError(
        new Error("produce acknowledgement timeout"),
      ),
    ).toBe(true);
    expect(
      isAmbiguousWebcamTopologyReplacementError(
        new Error("receiver-capacity offer rejected"),
      ),
    ).toBe(false);
  });

  it("preserves an ACK timeout when a stale-nonce raw retry would mask compensation", async () => {
    const acknowledgementTimeout = new Error(
      "produce acknowledgement timeout",
    );
    const staleNonceRejection = new Error(
      "receiver-capacity transition nonce already used",
    );
    const processedTrack = {
      id: "processed-track",
      readyState: "live",
    } as MediaStreamTrack;
    const rawTrack = {
      id: "raw-track",
      readyState: "live",
    } as MediaStreamTrack;
    const produce = vi
      .fn()
      .mockRejectedValueOnce(acknowledgementTimeout)
      .mockRejectedValueOnce(staleNonceRejection);
    const onTerminalFailure = vi
      .fn()
      .mockRejectedValue(new Error("diagnostic reporting failed"));

    let terminalError: unknown = null;
    try {
      await produceWebcamTrackWithRawTrackFallback({
        publishTrack: processedTrack,
        rawTrack,
        receiverCapacityTransition: {
          fromProducerId: "simulcast-a",
          nonce: "one-use-nonce",
        },
        produce,
        onTerminalFailure,
      });
    } catch (error) {
      terminalError = error;
    }

    expect(terminalError).toBe(acknowledgementTimeout);
    expect(terminalError).not.toBe(staleNonceRejection);
    expect(produce).toHaveBeenCalledOnce();
    expect(produce).toHaveBeenCalledWith(processedTrack);
    expect(onTerminalFailure).toHaveBeenCalledWith(acknowledgementTimeout);
    expect(
      getWebcamTopologyReplacementFailureDisposition({
        error: terminalError,
        nextProducerCreated: false,
        previousProducerClosed: false,
        previousProducerStillCurrent: true,
        cameraOff: false,
      }),
    ).toEqual({
      ambiguousOrPostCommit: true,
      retryable: false,
      shouldForceSimulcastCompensation: true,
      shouldPreservePreviousProducerCloseFence: true,
      requiresFreshReceiverCapacityOffer: true,
    });
  });

  it("retains processed-to-raw fallback for ordinary publications", async () => {
    const processedFailure = new Error("processed track rejected");
    const producer = { id: "raw-producer" };
    const processedTrack = {
      id: "processed-track",
      readyState: "live",
    } as MediaStreamTrack;
    const rawTrack = {
      id: "raw-track",
      readyState: "live",
    } as MediaStreamTrack;
    const produce = vi
      .fn()
      .mockRejectedValueOnce(processedFailure)
      .mockResolvedValueOnce(producer);

    await expect(
      produceWebcamTrackWithRawTrackFallback({
        publishTrack: processedTrack,
        rawTrack,
        produce,
      }),
    ).resolves.toBe(producer);
    expect(produce.mock.calls.map(([track]) => track.id)).toEqual([
      "processed-track",
      "raw-track",
    ]);
  });
});

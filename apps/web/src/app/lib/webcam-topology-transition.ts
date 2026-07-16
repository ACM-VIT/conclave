export const WEBCAM_SINGLE_RECEIVER_ENTRY_STABLE_MS = 1_500;
export const WEBCAM_SINGLE_RECEIVER_REENTRY_COOLDOWN_MS = 30_000;
export const WEBCAM_SINGLE_RECEIVER_SUCCESSOR_WAIT_MS = 5_000;
export const WEBCAM_TOPOLOGY_EXIT_RETRY_MS = 500;

export type WebcamProducerTopology =
  | "vp8-simulcast"
  | "vp8-single-layer"
  | "other";

export type WebcamTopologyReplacementTarget =
  | "adaptive-layers"
  | "single-receiver";

export type WebcamTopologyReplacementCommand = {
  id: number;
  target: WebcamTopologyReplacementTarget;
  expectedProducerId: string;
  transition?: {
    fromProducerId: string;
    nonce: string;
  };
};

export type WebcamTopologyReplacementResult = {
  status: "applied" | "noop" | "failed" | "superseded";
  producerId: string | null;
  topology: WebcamProducerTopology | null;
  retryable?: boolean;
  ambiguousOrPostCommit?: boolean;
  error?: unknown;
};

export type WebcamTopologyReplacementFailureDisposition = {
  ambiguousOrPostCommit: boolean;
  retryable: boolean;
  shouldForceSimulcastCompensation: boolean;
  shouldPreservePreviousProducerCloseFence: boolean;
  requiresFreshReceiverCapacityOffer: boolean;
};

export const isAmbiguousWebcamTopologyReplacementError = (
  error: unknown,
): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /acknowledgement timeout|transport|socket|signall?ing|connection|closed/i.test(
    message,
  );
};

export const isRetryableWebcamTopologyReplacementError = (
  error: unknown,
): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /temporar|in progress|busy|not ready|unavailable|retry/i.test(message);
};

export const getWebcamTopologyReplacementFailureDisposition = ({
  error,
  nextProducerCreated,
  previousProducerClosed,
  previousProducerStillCurrent,
  cameraOff,
}: {
  error: unknown;
  nextProducerCreated: boolean;
  previousProducerClosed: boolean;
  previousProducerStillCurrent: boolean;
  cameraOff: boolean;
}): WebcamTopologyReplacementFailureDisposition => {
  const ambiguousOrPostCommit =
    nextProducerCreated ||
    isAmbiguousWebcamTopologyReplacementError(error) ||
    previousProducerClosed ||
    !previousProducerStillCurrent;
  const shouldForceSimulcastCompensation =
    ambiguousOrPostCommit && !cameraOff;

  return {
    ambiguousOrPostCommit,
    retryable:
      !ambiguousOrPostCommit &&
      isRetryableWebcamTopologyReplacementError(error),
    shouldForceSimulcastCompensation,
    shouldPreservePreviousProducerCloseFence:
      shouldForceSimulcastCompensation,
    requiresFreshReceiverCapacityOffer: ambiguousOrPostCommit,
  };
};

type AdaptivePhase = {
  kind: "adaptive";
  producerId: string | null;
  entryCandidate: {
    signature: string;
    since: number;
  } | null;
};

type EnteringPhase = {
  kind: "entering";
  commandId: number;
  fromProducerId: string;
  nonce: string;
  exitRequested: boolean;
};

type AwaitingProofPhase = {
  kind: "awaiting-proof";
  fromProducerId: string;
  producerId: string;
  nonce: string;
  deadline: number;
};

type SinglePhase = {
  kind: "single";
  producerId: string;
};

type ExitingPhase = {
  kind: "exiting";
  producerId: string;
  reason: string;
  inFlightCommandId: number | null;
  retryAfter: number;
};

export type WebcamTopologyTransitionPhase =
  | AdaptivePhase
  | EnteringPhase
  | AwaitingProofPhase
  | SinglePhase
  | ExitingPhase;

export type WebcamTopologyTransitionState = {
  phase: WebcamTopologyTransitionPhase;
  nextCommandId: number;
  reentryNotBefore: number;
};

export type WebcamTopologyTransitionInput = {
  now: number;
  producerId: string | null;
  producerTopology: WebcamProducerTopology;
  hardSingleReceiverConditionsMet: boolean;
  sourceProofActive: boolean;
  sourceRevocationReason: string | null;
  replacementOffer: {
    nonce: string;
    expiresAtMonotonicMs: number;
  } | null;
  successorProof: {
    producerId: string;
    expiresAtMonotonicMs: number;
  } | null;
  currentSingleProofActive: boolean;
  currentSingleProofRevocationReason: string | null;
};

export type WebcamTopologyTransitionStep = {
  state: WebcamTopologyTransitionState;
  command: WebcamTopologyReplacementCommand | null;
};

export const createWebcamTopologyTransitionState = (
  now = 0,
): WebcamTopologyTransitionState => ({
  phase: {
    kind: "adaptive",
    producerId: null,
    entryCandidate: null,
  },
  nextCommandId: 1,
  reentryNotBefore: now,
});

const beginExit = (
  state: WebcamTopologyTransitionState,
  producerId: string,
  reason: string,
  now: number,
): WebcamTopologyTransitionStep => {
  const commandId = state.nextCommandId;
  return {
    state: {
      ...state,
      nextCommandId: commandId + 1,
      phase: {
        kind: "exiting",
        producerId,
        reason,
        inFlightCommandId: commandId,
        retryAfter: now,
      },
    },
    command: {
      id: commandId,
      target: "adaptive-layers",
      expectedProducerId: producerId,
    },
  };
};

const hasActiveSuccessor = (
  phase: Pick<AwaitingProofPhase, "producerId">,
  input: WebcamTopologyTransitionInput,
): boolean =>
  input.successorProof?.producerId === phase.producerId &&
  input.now < input.successorProof.expiresAtMonotonicMs;

export const advanceWebcamTopologyTransition = (
  state: WebcamTopologyTransitionState,
  input: WebcamTopologyTransitionInput,
): WebcamTopologyTransitionStep => {
  const { phase } = state;

  if (phase.kind === "adaptive") {
    if (
      input.producerId &&
      input.producerTopology === "vp8-single-layer"
    ) {
      return beginExit(
        state,
        input.producerId,
        "untracked single-layer producer",
        input.now,
      );
    }

    const offer = input.replacementOffer;
    const canEnter =
      input.producerId !== null &&
      input.producerTopology === "vp8-simulcast" &&
      input.hardSingleReceiverConditionsMet &&
      input.sourceProofActive &&
      offer !== null &&
      input.now < offer.expiresAtMonotonicMs &&
      input.now >= state.reentryNotBefore;
    if (!canEnter || !input.producerId || !offer) {
      if (
        phase.producerId === input.producerId &&
        phase.entryCandidate === null
      ) {
        return { state, command: null };
      }
      return {
        state: {
          ...state,
          phase: {
            kind: "adaptive",
            producerId: input.producerId,
            entryCandidate: null,
          },
        },
        command: null,
      };
    }

    const signature = `${input.producerId}:${offer.nonce}`;
    if (phase.entryCandidate?.signature !== signature) {
      return {
        state: {
          ...state,
          phase: {
            kind: "adaptive",
            producerId: input.producerId,
            entryCandidate: { signature, since: input.now },
          },
        },
        command: null,
      };
    }
    if (
      input.now - phase.entryCandidate.since <
      WEBCAM_SINGLE_RECEIVER_ENTRY_STABLE_MS
    ) {
      return { state, command: null };
    }

    const commandId = state.nextCommandId;
    return {
      state: {
        ...state,
        nextCommandId: commandId + 1,
        phase: {
          kind: "entering",
          commandId,
          fromProducerId: input.producerId,
          nonce: offer.nonce,
          exitRequested: false,
        },
      },
      command: {
        id: commandId,
        target: "single-receiver",
        expectedProducerId: input.producerId,
        transition: {
          fromProducerId: input.producerId,
          nonce: offer.nonce,
        },
      },
    };
  }

  if (phase.kind === "entering") {
    const expectedRemoval =
      input.sourceRevocationReason === "producer_removed" ||
      input.sourceRevocationReason === "producer_replaced";
    const sourceBecameUnsafe =
      !input.sourceProofActive &&
      input.sourceRevocationReason !== null &&
      !expectedRemoval;
    const offerExpiredWithoutSuccessor =
      input.replacementOffer !== null &&
      input.now >= input.replacementOffer.expiresAtMonotonicMs &&
      input.successorProof === null;
    const exitRequested =
      phase.exitRequested ||
      !input.hardSingleReceiverConditionsMet ||
      sourceBecameUnsafe ||
      offerExpiredWithoutSuccessor;
    if (exitRequested === phase.exitRequested) {
      return { state, command: null };
    }
    return {
      state: {
        ...state,
        phase: { ...phase, exitRequested },
      },
      command: null,
    };
  }

  if (phase.kind === "awaiting-proof") {
    if (!input.hardSingleReceiverConditionsMet) {
      return beginExit(
        state,
        phase.producerId,
        "single-receiver conditions revoked",
        input.now,
      );
    }
    if (hasActiveSuccessor(phase, input) || input.currentSingleProofActive) {
      return {
        state: {
          ...state,
          phase: { kind: "single", producerId: phase.producerId },
        },
        command: null,
      };
    }
    if (
      input.currentSingleProofRevocationReason !== null ||
      input.now >= phase.deadline
    ) {
      return beginExit(
        state,
        phase.producerId,
        input.currentSingleProofRevocationReason ??
          "successor proof handoff timed out",
        input.now,
      );
    }
    return { state, command: null };
  }

  if (phase.kind === "single") {
    if (
      input.producerId === phase.producerId &&
      input.producerTopology === "vp8-single-layer" &&
      input.hardSingleReceiverConditionsMet &&
      input.currentSingleProofActive
    ) {
      return { state, command: null };
    }
    return beginExit(
      state,
      phase.producerId,
      input.currentSingleProofRevocationReason ??
        "single-receiver proof or conditions revoked",
      input.now,
    );
  }

  if (phase.inFlightCommandId !== null || input.now < phase.retryAfter) {
    return { state, command: null };
  }
  if (!input.producerId) {
    return {
      state: {
        ...state,
        phase: {
          kind: "adaptive",
          producerId: null,
          entryCandidate: null,
        },
        reentryNotBefore:
          input.now + WEBCAM_SINGLE_RECEIVER_REENTRY_COOLDOWN_MS,
      },
      command: null,
    };
  }
  const commandId = state.nextCommandId;
  return {
    state: {
      ...state,
      nextCommandId: commandId + 1,
      phase: {
        ...phase,
        producerId: input.producerId,
        inFlightCommandId: commandId,
      },
    },
    command: {
      id: commandId,
      target: "adaptive-layers",
      expectedProducerId: input.producerId,
    },
  };
};

export const settleWebcamTopologyTransition = (
  state: WebcamTopologyTransitionState,
  command: WebcamTopologyReplacementCommand,
  result: WebcamTopologyReplacementResult,
  input: WebcamTopologyTransitionInput,
): WebcamTopologyTransitionStep => {
  const { phase } = state;
  if (
    phase.kind === "entering" &&
    phase.commandId === command.id &&
    command.target === "single-receiver"
  ) {
    const applied =
      (result.status === "applied" || result.status === "noop") &&
      result.producerId !== null &&
      result.topology === "vp8-single-layer";
    if (!applied || !result.producerId) {
      return {
        state: {
          ...state,
          phase: {
            kind: "adaptive",
            producerId: input.producerId,
            entryCandidate: null,
          },
          reentryNotBefore: result.retryable
            ? input.now
            : input.now + WEBCAM_SINGLE_RECEIVER_REENTRY_COOLDOWN_MS,
        },
        command: null,
      };
    }

    const shouldExitImmediately =
      phase.exitRequested || !input.hardSingleReceiverConditionsMet;
    if (shouldExitImmediately) {
      return beginExit(
        state,
        result.producerId,
        "conditions changed while entering single-receiver mode",
        input.now,
      );
    }
    const successorMatches =
      (input.successorProof?.producerId === result.producerId &&
        input.now < input.successorProof.expiresAtMonotonicMs) ||
      input.currentSingleProofActive;
    return {
      state: {
        ...state,
        phase: successorMatches
          ? { kind: "single", producerId: result.producerId }
          : {
              kind: "awaiting-proof",
              fromProducerId: phase.fromProducerId,
              producerId: result.producerId,
              nonce: phase.nonce,
              deadline:
                input.now + WEBCAM_SINGLE_RECEIVER_SUCCESSOR_WAIT_MS,
            },
      },
      command: null,
    };
  }

  if (
    phase.kind === "exiting" &&
    phase.inFlightCommandId === command.id &&
    command.target === "adaptive-layers"
  ) {
    const applied =
      (result.status === "applied" || result.status === "noop") &&
      result.producerId !== null &&
      result.topology === "vp8-simulcast";
    if (applied) {
      return {
        state: {
          ...state,
          phase: {
            kind: "adaptive",
            producerId: result.producerId,
            entryCandidate: null,
          },
          reentryNotBefore:
            input.now + WEBCAM_SINGLE_RECEIVER_REENTRY_COOLDOWN_MS,
        },
        command: null,
      };
    }
    return {
      state: {
        ...state,
        phase: {
          ...phase,
          producerId: result.producerId ?? input.producerId ?? phase.producerId,
          inFlightCommandId: null,
          retryAfter:
            input.now +
            (result.retryable ? WEBCAM_TOPOLOGY_EXIT_RETRY_MS : 2_000),
        },
      },
      command: null,
    };
  }

  return { state, command: null };
};

export type LatestWinsTopologyReplacementQueue<
  TRequest,
  TResult,
> = {
  request: (request: TRequest) => Promise<TResult | { status: "superseded" }>;
  clearPending: () => void;
};

export const createLatestWinsTopologyReplacementQueue = <TRequest, TResult>(
  apply: (request: TRequest) => Promise<TResult>,
): LatestWinsTopologyReplacementQueue<TRequest, TResult> => {
  type Pending = {
    request: TRequest;
    resolve: (result: TResult | { status: "superseded" }) => void;
    reject: (error: unknown) => void;
  };
  let pending: Pending | null = null;
  let draining = false;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending) {
        const current = pending;
        pending = null;
        try {
          current.resolve(await apply(current.request));
        } catch (error) {
          current.reject(error);
        }
      }
    } finally {
      draining = false;
      if (pending) void drain();
    }
  };

  return {
    request(request) {
      return new Promise((resolve, reject) => {
        if (pending) pending.resolve({ status: "superseded" });
        pending = { request, resolve, reject };
        void drain();
      });
    },
    clearPending() {
      pending?.resolve({ status: "superseded" });
      pending = null;
    },
  };
};

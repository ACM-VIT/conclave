import type { RejoinMedia } from "./rejoin-intent";
import type { ReconnectRecoveryStatus } from "./types";

export type CallOutcomeKind =
  | "left"
  | "connectionLost"
  | "endedByYou"
  | "endedByHost"
  | "removed";

export const reconnectEndedCall = (reconnect: {
  phase: ReconnectRecoveryStatus["phase"] | undefined;
  connectionState: string;
  wasInCall: boolean;
  showsOutcome: boolean;
  recoverable: boolean | undefined;
}): boolean =>
  reconnect.showsOutcome &&
  reconnect.wasInCall &&
  reconnect.connectionState === "error" &&
  reconnect.phase === "failed" &&
  reconnect.recoverable === true;

export interface CallOutcome {
  kind: CallOutcomeKind;
  roomId: string;
  detail: string | null;
  rejoinMedia: RejoinMedia | null;
  durationMs: number;
}

interface CallOutcomePolicy {
  title: string;
  body: string | null;
  actions: readonly ("rejoin" | "home")[];
  asksForRating: boolean;
}

export const CALL_OUTCOME_POLICY: Record<CallOutcomeKind, CallOutcomePolicy> = {
  left: {
    title: "You left the meeting",
    body: null,
    actions: ["home", "rejoin"],
    asksForRating: true,
  },
  connectionLost: {
    title: "You lost your connection",
    body: "Check your connection, then rejoin.",
    actions: ["rejoin", "home"],
    asksForRating: true,
  },
  endedByYou: {
    title: "You ended the meeting",
    body: "The meeting has ended for everyone.",
    actions: ["home"],
    asksForRating: true,
  },
  endedByHost: {
    title: "The host ended the meeting",
    body: null,
    actions: ["home"],
    asksForRating: true,
  },
  removed: {
    title: "You were removed from the meeting",
    body: null,
    actions: ["home"],
    asksForRating: false,
  },
};

export const CALL_RATING_LABELS = [
  "Very bad",
  "Poor",
  "Fair",
  "Good",
  "Excellent",
] as const;

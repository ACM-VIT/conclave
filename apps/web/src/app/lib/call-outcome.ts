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

export interface RejoinMedia {
  isMicOn: boolean;
  isCameraOn: boolean;
  isAudioOnly: boolean;
}

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

const REJOIN_STORAGE_KEY = "conclave:rejoin";
const REJOIN_MAX_AGE_MS = 10 * 60 * 1000;

const sameRoom = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim().length > 0;

export function saveRejoinIntent(roomId: string, media: RejoinMedia): void {
  try {
    window.sessionStorage.setItem(
      REJOIN_STORAGE_KEY,
      JSON.stringify({ roomId, savedAt: Date.now(), ...media }),
    );
  } catch {}
}

export function readRejoinIntent(
  roomId: string | undefined,
  now = Date.now(),
): RejoinMedia | null {
  if (!roomId) return null;
  try {
    const raw = window.sessionStorage.getItem(REJOIN_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const intent = value as Record<string, unknown>;
    if (
      typeof intent.roomId !== "string" ||
      !sameRoom(intent.roomId, roomId) ||
      typeof intent.savedAt !== "number" ||
      now - intent.savedAt > REJOIN_MAX_AGE_MS
    ) {
      return null;
    }
    return {
      isMicOn: intent.isMicOn === true,
      isCameraOn: intent.isCameraOn === true,
      isAudioOnly: intent.isAudioOnly === true,
    };
  } catch {
    return null;
  }
}

export function clearRejoinIntent(): void {
  try {
    window.sessionStorage.removeItem(REJOIN_STORAGE_KEY);
  } catch {}
}

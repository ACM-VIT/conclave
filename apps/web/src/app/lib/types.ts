export * from "@conclave/meeting-core/types";
export * from "@conclave/meeting-core/transcript-types";

type ReconnectRecoveryPhase =
  | "waiting"
  | "connecting"
  | "joining"
  | "failed";

export interface ReconnectRecoveryStatus {
  phase: ReconnectRecoveryPhase;
  /** The attempt in progress out of the retry budget; null when none is being used up. */
  attempt: number | null;
  maxAttempts: number;
  message: string;
  lastError: string | null;
  retryAt: number | null;
  updatedAt: number;
  /** The rejoin was refused for an invite code, so Try again needs one. */
  needsInviteCode?: boolean;
}

export interface PrejoinMediaHandoff {
  stream: MediaStream | null;
  isCameraOn: boolean;
  isMicOn: boolean;
  /** Join in audio-only mode (no outgoing or incoming video). */
  isAudioOnly?: boolean;
}

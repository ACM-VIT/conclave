export * from "@conclave/meeting-core/types";

export type ReconnectRecoveryPhase =
  | "waiting"
  | "connecting"
  | "joining"
  | "failed";

export interface ReconnectRecoveryStatus {
  phase: ReconnectRecoveryPhase;
  attempt: number;
  maxAttempts: number;
  message: string;
  lastError: string | null;
  retryAt: number | null;
  updatedAt: number;
}

export interface PrejoinMediaHandoff {
  stream: MediaStream | null;
  isCameraOn: boolean;
  isMicOn: boolean;
}

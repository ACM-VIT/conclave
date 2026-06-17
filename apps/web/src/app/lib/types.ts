export * from "@conclave/meeting-core/types";

export interface PrejoinMediaHandoff {
  stream: MediaStream | null;
  isCameraOn: boolean;
  isMicOn: boolean;
}

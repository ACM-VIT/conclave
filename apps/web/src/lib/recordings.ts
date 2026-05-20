export type RecordingTrackKind = "audio" | "video" | "screen";
export type RecordingTrackStatus = "active" | "ended" | "failed";

export type RecordingSessionStatus =
  | "idle"
  | "starting"
  | "active"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed";

export interface RecordingTrackArtifact {
  id: string;
  trackKind: RecordingTrackKind;
  producerId: string;
  producerUserId: string;
  displayName: string | null;
  codec: string;
  container: "webm" | "mp4" | "m4a";
  filename: string;
  relativePath: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  byteSize: number;
  status: RecordingTrackStatus;
  errorMessage: string | null;
}

export interface RecordingCompositeArtifact {
  status: "pending" | "running" | "completed" | "failed";
  filename: string | null;
  relativePath: string | null;
  startedAt: number | null;
  completedAt: number | null;
  byteSize: number;
  errorMessage: string | null;
}

export interface RecordingSessionMetadata {
  id: string;
  roomId: string;
  clientId: string;
  scheduledWebinarId: string | null;
  status: RecordingSessionStatus;
  startedAt: number;
  endedAt: number | null;
  pausedDurationMs: number;
  startedBy: string;
  endedBy: string | null;
  totalBytes: number;
  resolution: { width: number; height: number } | null;
  audioBitrateKbps: number;
  videoBitrateKbps: number;
  tracks: RecordingTrackArtifact[];
  composite: RecordingCompositeArtifact | null;
  manifestPath: string;
  manifestRelativePath: string;
  storagePath: string;
  storageRelativePath: string;
  errorMessage: string | null;
  speakerTimeline: { at: number; userId: string | null }[];
}

export interface RecordingPublicState {
  active: boolean;
  paused: boolean;
  sessionId: string | null;
  startedAt: number | null;
  startedBy: string | null;
  trackCount: number;
}

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

export const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
};

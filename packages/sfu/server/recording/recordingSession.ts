import { randomUUID } from "node:crypto";
import { writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Server as SocketIOServer } from "socket.io";
import type { Producer } from "mediasoup/types";
import type { Room } from "../../config/classes/Room.js";
import { Logger } from "../../utilities/loggers.js";
import type {
  RecordingPublicState,
  RecordingSessionMetadata,
  RecordingSessionStatus,
  RecordingTrackArtifact,
} from "../../types.js";
import { getRecordingDirectory } from "./recordingPaths.js";
import { createViewRecorder, type ViewRecorderHandle } from "./viewRecorder.js";

export type ProducerHandle = {
  producer: Producer;
  userId: string;
  displayName: string | null;
  type: "webcam" | "screen";
};

export type CreateRecordingSessionOptions = {
  room: Room;
  startedBy: string;
  scheduledWebinarId?: string | null;
  storageKey?: string;
  audioBitrateKbps?: number;
  videoBitrateKbps?: number;
  preferredVideoCodec?: "h264" | "vp8";
  produceComposite?: boolean;
  recorderUrlBase: string;
  io?: SocketIOServer | null;
  emitState?: (state: RecordingPublicState) => void;
};

export type RecordingSession = {
  id: string;
  roomChannelId: string;
  scheduledWebinarId: string | null;
  metadata: () => RecordingSessionMetadata;
  publicState: () => RecordingPublicState;
  start: () => Promise<void>;
  stop: (options?: { endedBy?: string }) => Promise<RecordingSessionMetadata>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  attachProducer: (handle: ProducerHandle) => Promise<void>;
  detachProducer: (producerId: string) => Promise<void>;
  speakerChanged: (userId: string | null) => void;
  isActive: () => boolean;
  isFinalized: () => boolean;
  acceptChunk: (
    chunk: Buffer,
    sequence: number,
  ) => Promise<{ accepted: boolean; reason?: string }>;
  control: () => { stopRequested: boolean; paused: boolean };
  finalizeFromBrowser: (info: {
    durationMs: number;
    reason: string;
    errorMessage: string | null;
  }) => Promise<void>;
};

const STATE_BROADCAST_DELAY_MS = 50;
const DEFAULT_AUDIO_BITRATE = 128;
const DEFAULT_VIDEO_BITRATE = 6_000;

export const createRecordingSession = (
  options: CreateRecordingSessionOptions,
): RecordingSession => {
  const sessionId = randomUUID();
  const room = options.room;
  const storageKey =
    options.storageKey || options.scheduledWebinarId || room.id;
  const { absolute: storageDir, relative: storageRelative } =
    getRecordingDirectory(storageKey, sessionId);

  const startedAt = Date.now();
  let status: RecordingSessionStatus = "idle";
  let pausedAt: number | null = null;
  let pausedDurationMs = 0;
  let endedAt: number | null = null;
  let endedBy: string | null = null;
  let errorMessage: string | null = null;
  let stopRequested = false;
  let viewArtifact: RecordingTrackArtifact | null = null;
  const speakerTimeline: { at: number; userId: string | null }[] = [];

  const audioBitrateKbps = options.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE;
  const videoBitrateKbps = options.videoBitrateKbps ?? DEFAULT_VIDEO_BITRATE;

  const viewRecorder: ViewRecorderHandle = createViewRecorder({
    room,
    sessionId,
    storageDir,
    scheduledWebinarId: options.scheduledWebinarId ?? null,
    recorderUrlBase: options.recorderUrlBase,
    audioBitrateKbps,
    videoBitrateKbps,
    onFatal: (error) => {
      Logger.error(
        `[recording] view recorder fatal: ${error.message}`,
      );
      errorMessage = error.message;
      status = "failed";
      broadcastState();
    },
  });

  const broadcastState = (() => {
    let timer: NodeJS.Timeout | null = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try {
          options.emitState?.(publicState());
        } catch (error) {
          Logger.warn("[recording] state broadcast failed", error);
        }
      }, STATE_BROADCAST_DELAY_MS);
    };
  })();

  const tracks = (): RecordingTrackArtifact[] => {
    if (viewArtifact) return [viewArtifact];
    if (status === "idle" || status === "starting") return [];
    return [
      {
        id: viewRecorder.sessionId,
        trackKind: "video",
        producerId: "view",
        producerUserId: "view-recorder",
        displayName: "Meeting view",
        codec: "vp9+opus",
        container: "webm",
        filename: viewRecorder.outputFilename,
        relativePath: viewRecorder.outputFilename,
        startedAt,
        endedAt,
        durationMs: Math.max(0, (endedAt ?? Date.now()) - startedAt),
        byteSize: (() => {
          const path = join(storageDir, viewRecorder.outputFilename);
          try {
            return existsSync(path) ? statSync(path).size : 0;
          } catch {
            return 0;
          }
        })(),
        status: status === "completed" ? "ended" : "active",
        errorMessage: null,
      },
    ];
  };

  const metadata = (): RecordingSessionMetadata => {
    const trackList = tracks();
    let totalBytes = 0;
    for (const track of trackList) totalBytes += track.byteSize;
    return {
      id: sessionId,
      roomId: room.id,
      clientId: room.clientId,
      scheduledWebinarId: options.scheduledWebinarId ?? null,
      status,
      startedAt,
      endedAt,
      pausedDurationMs:
        pausedAt != null
          ? pausedDurationMs + (Date.now() - pausedAt)
          : pausedDurationMs,
      startedBy: options.startedBy,
      endedBy,
      totalBytes,
      resolution: { width: 1920, height: 1080 },
      audioBitrateKbps,
      videoBitrateKbps,
      tracks: trackList,
      composite: null,
      manifestPath: join(storageDir, "manifest.json"),
      manifestRelativePath: `${storageRelative}/manifest.json`,
      storagePath: storageDir,
      storageRelativePath: storageRelative,
      errorMessage,
      speakerTimeline: [...speakerTimeline],
    };
  };

  const publicState = (): RecordingPublicState => ({
    active: status === "active" || status === "paused" || status === "starting",
    paused: status === "paused",
    sessionId,
    startedAt,
    startedBy: options.startedBy,
    trackCount: viewArtifact ? 1 : 0,
  });

  const writeManifest = (): void => {
    try {
      writeFileSync(
        join(storageDir, "manifest.json"),
        JSON.stringify(metadata(), null, 2),
        "utf8",
      );
    } catch (error) {
      Logger.warn("[recording] manifest write failed", error);
    }
  };

  const start: RecordingSession["start"] = async () => {
    if (status !== "idle") return;
    status = "starting";
    writeManifest();
    broadcastState();
    try {
      await viewRecorder.start();
      status = "active";
      writeManifest();
      broadcastState();
    } catch (error) {
      status = "failed";
      errorMessage = (error as Error).message;
      writeManifest();
      broadcastState();
      throw error;
    }
  };

  const pause: RecordingSession["pause"] = async () => {
    if (status !== "active") return;
    status = "paused";
    pausedAt = Date.now();
    writeManifest();
    broadcastState();
  };

  const resume: RecordingSession["resume"] = async () => {
    if (status !== "paused") return;
    if (pausedAt) {
      pausedDurationMs += Date.now() - pausedAt;
      pausedAt = null;
    }
    status = "active";
    writeManifest();
    broadcastState();
  };

  const speakerChanged: RecordingSession["speakerChanged"] = (userId) => {
    if (status !== "active" && status !== "paused") return;
    const last = speakerTimeline[speakerTimeline.length - 1];
    if (last && last.userId === userId) return;
    speakerTimeline.push({ at: Date.now(), userId });
    writeManifest();
  };

  const stop: RecordingSession["stop"] = async (stopOptions = {}) => {
    if (status === "completed" || status === "failed") {
      return metadata();
    }
    status = "finalizing";
    endedBy = stopOptions.endedBy ?? options.startedBy;
    stopRequested = true;
    broadcastState();

    const result = await viewRecorder.stop().catch((error) => {
      Logger.error(
        `[recording] view recorder stop failed: ${(error as Error).message}`,
      );
      return null;
    });

    endedAt = Date.now();
    if (pausedAt) {
      pausedDurationMs += Date.now() - pausedAt;
      pausedAt = null;
    }

    if (result) {
      viewArtifact = {
        id: viewRecorder.sessionId,
        trackKind: "video",
        producerId: "view",
        producerUserId: "view-recorder",
        displayName: "Meeting view",
        codec: result.outputFilename.endsWith(".mp4") ? "h264+aac" : "vp9+opus",
        container: result.outputFilename.endsWith(".mp4") ? "mp4" : "webm",
        filename: result.outputFilename,
        relativePath: result.outputFilename,
        startedAt,
        endedAt,
        durationMs: result.durationMs || endedAt - startedAt,
        byteSize: result.byteSize,
        status: "ended",
        errorMessage: null,
      };
    }

    status = "completed";
    writeManifest();
    broadcastState();
    return metadata();
  };

  const attachProducer: RecordingSession["attachProducer"] = async () => {
    // View recorder captures the rendered tab; producer events are not needed.
  };
  const detachProducer: RecordingSession["detachProducer"] = async () => {
    // No-op for view recorder.
  };

  const isActive = (): boolean =>
    status === "active" || status === "paused" || status === "starting";
  const isFinalized = (): boolean =>
    status === "completed" || status === "failed";

  const acceptChunk: RecordingSession["acceptChunk"] = async (
    chunk,
    sequence,
  ) => {
    if (status !== "active" && status !== "paused" && status !== "starting") {
      return { accepted: false, reason: `status:${status}` };
    }
    return await viewRecorder.appendChunk(chunk, sequence);
  };

  const control: RecordingSession["control"] = () => ({
    stopRequested,
    paused: status === "paused",
  });

  const finalizeFromBrowser: RecordingSession["finalizeFromBrowser"] = async (
    info,
  ) => {
    if (info.errorMessage) {
      errorMessage = info.errorMessage;
    }
    await viewRecorder.finalizeFromBrowser(info.durationMs);
  };

  return {
    id: sessionId,
    roomChannelId: room.channelId,
    scheduledWebinarId: options.scheduledWebinarId ?? null,
    metadata,
    publicState,
    start,
    stop,
    pause,
    resume,
    attachProducer,
    detachProducer,
    speakerChanged,
    isActive,
    isFinalized,
    acceptChunk,
    control,
    finalizeFromBrowser,
  };
};

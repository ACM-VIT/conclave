import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server as SocketIOServer } from "socket.io";
import type { Producer } from "mediasoup/types";
import { Logger } from "../../utilities/loggers.js";
import type {
  RecordingPublicState,
  RecordingSessionMetadata,
} from "../../types.js";
import type { Room } from "../../config/classes/Room.js";
import type { SfuState } from "../state.js";
import {
  createRecordingSession,
  type CreateRecordingSessionOptions,
  type ProducerHandle,
  type RecordingSession,
} from "./recordingSession.js";
import { getRecordingsRoot } from "./recordingPaths.js";
import { isFfmpegAvailable } from "./ffmpegBridge.js";
import { resolveRecordingProfile } from "./qualityProfile.js";
import { getScheduledWebinarById } from "../scheduledWebinars.js";
import { ensureWebinarLinkSlug } from "../webinar.js";

export type RecordingManager = {
  start: (
    room: Room,
    options: Omit<
      CreateRecordingSessionOptions,
      "room" | "emitState" | "recorderUrlBase"
    > & { recorderUrlBase?: string },
  ) => Promise<RecordingSession>;
  stop: (
    roomChannelId: string,
    options?: { endedBy?: string },
  ) => Promise<RecordingSessionMetadata | null>;
  pause: (roomChannelId: string) => Promise<void>;
  resume: (roomChannelId: string) => Promise<void>;
  forRoom: (roomChannelId: string) => RecordingSession | null;
  publicState: (roomChannelId: string) => RecordingPublicState;
  onProducerCreated: (
    roomChannelId: string,
    handle: ProducerHandle,
  ) => Promise<void>;
  onProducerClosed: (
    roomChannelId: string,
    producerId: string,
  ) => Promise<void>;
  onSpeakerChanged: (
    roomChannelId: string,
    userId: string | null,
  ) => void;
  listRecordingsForKey: (key: string) => RecordingSessionMetadata[];
  getRecording: (
    key: string,
    sessionId: string,
  ) => RecordingSessionMetadata | null;
  resolveArtifactPath: (
    key: string,
    sessionId: string,
    filename: string,
  ) => string | null;
  acceptChunk: (
    sessionId: string,
    chunk: Buffer,
    sequence: number,
  ) => Promise<{ accepted: boolean; reason?: string }>;
  getRecorderControl: (
    sessionId: string,
  ) => { stopRequested: boolean; paused: boolean } | null;
  finalizeViewRecording: (
    sessionId: string,
    info: { durationMs: number; reason: string; errorMessage: string | null },
  ) => Promise<void>;
};

const DEFAULT_RECORDER_URL_BASE = (): string => {
  const explicit = process.env.RECORDER_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const port = process.env.NEXT_PUBLIC_APP_PORT || "3000";
  return `http://127.0.0.1:${port}`;
};

const IDLE_PUBLIC_STATE: RecordingPublicState = {
  active: false,
  paused: false,
  sessionId: null,
  startedAt: null,
  startedBy: null,
  trackCount: 0,
};

const safeReadJson = <T>(path: string): T | null => {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const sanitizeFilenameInput = (value: string): string =>
  value.replace(/[\\/]/g, "").replace(/\.+/g, ".");

export const createRecordingManager = (options: {
  state: SfuState;
  getIo: () => SocketIOServer | null;
}): RecordingManager => {
  const { state, getIo } = options;
  const sessionsById = new Map<string, RecordingSession>();

  const broadcastState = (
    room: Room,
    next: RecordingPublicState,
  ): void => {
    const io = getIo();
    if (!io) return;
    try {
      io.to(room.channelId).emit("recordingStateChanged", {
        roomId: room.id,
        ...next,
      });
    } catch (error) {
      Logger.warn("[recording] emit state failed", error);
    }
  };

  const start: RecordingManager["start"] = async (room, sessionOptions) => {
    const existing = state.recordingSessions.get(room.channelId);
    if (existing && existing.isActive()) {
      return existing;
    }
    if (!(await isFfmpegAvailable())) {
      throw new Error(
        "Recording is unavailable on this server: ffmpeg binary not found.",
      );
    }

    const profile = resolveRecordingProfile();
    const activeCount = Array.from(state.recordingSessions.values()).filter(
      (entry) => entry.isActive(),
    ).length;
    if (activeCount >= profile.maxConcurrentSessions) {
      throw new Error(
        `Recording capacity reached (${profile.maxConcurrentSessions} concurrent session${
          profile.maxConcurrentSessions === 1 ? "" : "s"
        } on this server).`,
      );
    }

    const webinarConfig = state.webinarConfigs.get(room.channelId) ?? null;
    const scheduledWebinarId =
      sessionOptions.scheduledWebinarId ??
      webinarConfig?.scheduledWebinarId ??
      null;
    const scheduledWebinar = scheduledWebinarId
      ? getScheduledWebinarById(state.scheduledWebinars, scheduledWebinarId)
      : null;
    let webinarLinkSlug =
      sessionOptions.webinarLinkSlug ??
      scheduledWebinar?.linkSlug ??
      (webinarConfig?.enabled ? webinarConfig.linkSlug : null) ??
      null;

    if (webinarConfig?.enabled && !webinarLinkSlug) {
      try {
        webinarLinkSlug = ensureWebinarLinkSlug({
          webinarConfig,
          webinarLinks: state.webinarLinks,
          room,
        });
      } catch (error) {
        Logger.warn(
          `[recording] failed to prepare webinar attendee link for ${room.channelId}: ${(error as Error).message}`,
        );
      }
    }

    const session = createRecordingSession({
      ...sessionOptions,
      room,
      io: getIo(),
      scheduledWebinarId,
      webinarLinkSlug,
      storageKey: sessionOptions.storageKey || scheduledWebinarId || undefined,
      audioBitrateKbps:
        sessionOptions.audioBitrateKbps ?? profile.audioBitrateKbps,
      videoBitrateKbps:
        sessionOptions.videoBitrateKbps ?? profile.videoBitrateKbps,
      recorderUrlBase:
        sessionOptions.recorderUrlBase || DEFAULT_RECORDER_URL_BASE(),
      emitState: (publicState) => broadcastState(room, publicState),
    });
    state.recordingSessions.set(room.channelId, session);
    sessionsById.set(session.id, session);
    try {
      await session.start();
    } catch (error) {
      state.recordingSessions.delete(room.channelId);
      sessionsById.delete(session.id);
      throw error;
    }
    broadcastState(room, session.publicState());
    return session;
  };

  const stop: RecordingManager["stop"] = async (roomChannelId, stopOptions) => {
    const session = state.recordingSessions.get(roomChannelId);
    if (!session) return null;
    const result = await session.stop(stopOptions);
    state.recordingSessions.delete(roomChannelId);
    sessionsById.delete(session.id);
    const io = getIo();
    if (io) {
      try {
        io.to(roomChannelId).emit("recordingStateChanged", {
          roomId: roomChannelId,
          ...IDLE_PUBLIC_STATE,
        });
      } catch (error) {
        Logger.warn("[recording] emit idle state failed", error);
      }
    }
    return result;
  };

  const pause: RecordingManager["pause"] = async (roomChannelId) => {
    const session = state.recordingSessions.get(roomChannelId);
    if (!session) return;
    await session.pause();
  };

  const resume: RecordingManager["resume"] = async (roomChannelId) => {
    const session = state.recordingSessions.get(roomChannelId);
    if (!session) return;
    await session.resume();
  };

  const forRoom: RecordingManager["forRoom"] = (roomChannelId) =>
    state.recordingSessions.get(roomChannelId) ?? null;

  const publicState: RecordingManager["publicState"] = (roomChannelId) => {
    const session = state.recordingSessions.get(roomChannelId);
    if (!session) return IDLE_PUBLIC_STATE;
    return session.publicState();
  };

  const onProducerCreated: RecordingManager["onProducerCreated"] = async (
    roomChannelId,
    handle,
  ) => {
    const session = state.recordingSessions.get(roomChannelId);
    if (!session || !session.isActive()) return;
    await session.attachProducer(handle);
  };

  const onProducerClosed: RecordingManager["onProducerClosed"] = async (
    roomChannelId,
    producerId,
  ) => {
    const session = state.recordingSessions.get(roomChannelId);
    if (!session) return;
    await session.detachProducer(producerId);
  };

  const onSpeakerChanged: RecordingManager["onSpeakerChanged"] = (
    roomChannelId,
    userId,
  ) => {
    const session = state.recordingSessions.get(roomChannelId);
    if (!session) return;
    session.speakerChanged(userId);
  };

  const listRecordingsForKey: RecordingManager["listRecordingsForKey"] = (
    key,
  ) => {
    const root = getRecordingsRoot();
    const safeKey = sanitizeFilenameInput(key);
    const baseDir = resolve(root, safeKey);
    if (!existsSync(baseDir)) return [];
    const entries: RecordingSessionMetadata[] = [];
    let children: string[];
    try {
      children = readdirSync(baseDir);
    } catch {
      return [];
    }
    for (const child of children) {
      const manifestPath = resolve(baseDir, child, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = safeReadJson<RecordingSessionMetadata>(manifestPath);
      if (manifest) entries.push(manifest);
    }
    entries.sort((a, b) => b.startedAt - a.startedAt);
    return entries;
  };

  const getRecording: RecordingManager["getRecording"] = (key, sessionId) => {
    const root = getRecordingsRoot();
    const safeKey = sanitizeFilenameInput(key);
    const safeSession = sanitizeFilenameInput(sessionId);
    const manifestPath = resolve(root, safeKey, safeSession, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    return safeReadJson<RecordingSessionMetadata>(manifestPath);
  };

  const resolveArtifactPath: RecordingManager["resolveArtifactPath"] = (
    key,
    sessionId,
    filename,
  ) => {
    const root = getRecordingsRoot();
    const safeKey = sanitizeFilenameInput(key);
    const safeSession = sanitizeFilenameInput(sessionId);
    const safeFilename = sanitizeFilenameInput(filename);
    const candidate = resolve(root, safeKey, safeSession, safeFilename);
    const expectedPrefix = resolve(root, safeKey, safeSession);
    if (!candidate.startsWith(expectedPrefix)) return null;
    if (!existsSync(candidate)) return null;
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) return null;
    } catch {
      return null;
    }
    return candidate;
  };

  const acceptChunk: RecordingManager["acceptChunk"] = async (
    sessionId,
    chunk,
    sequence,
  ) => {
    const session = sessionsById.get(sessionId);
    if (!session) return { accepted: false, reason: "session not found" };
    return await session.acceptChunk(chunk, sequence);
  };

  const getRecorderControl: RecordingManager["getRecorderControl"] = (
    sessionId,
  ) => {
    const session = sessionsById.get(sessionId);
    if (!session) return null;
    return session.control();
  };

  const finalizeViewRecording: RecordingManager["finalizeViewRecording"] = async (
    sessionId,
    info,
  ) => {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    await session.finalizeFromBrowser(info);
  };

  void join;
  return {
    start,
    stop,
    pause,
    resume,
    forRoom,
    publicState,
    onProducerCreated,
    onProducerClosed,
    onSpeakerChanged,
    listRecordingsForKey,
    getRecording,
    resolveArtifactPath,
    acceptChunk,
    getRecorderControl,
    finalizeViewRecording,
  };
};

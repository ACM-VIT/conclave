import type { Worker } from "mediasoup/types";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import getWorker from "../utilities/getWorker.js";
import { Logger } from "../utilities/loggers.js";
import {
  stopRoomTranscriber,
  type TranscriptChunk,
} from "./recording/roomTranscriber.js";
import { summarizeTranscript } from "./recording/summarizeTranscript.js";
import { buildMinutesPdf } from "./recording/minutesPdf.js";
import { cleanupRoomBrowser } from "./socket/handlers/sharedBrowserHandlers.js";
import type { SfuState } from "./state.js";
import { clearWebinarLinkSlug } from "./webinar.js";

export const getRoomChannelId = (clientId: string, roomId: string): string =>
  `${clientId}:${roomId}`;
const MINUTES_CACHE_TTL_MS = Number(
  process.env.MINUTES_CACHE_TTL_MS || 30 * 60 * 1000,
);

export const getOrCreateRoom = async (
  state: SfuState,
  clientId: string,
  roomId: string,
): Promise<Room> => {
  const channelId = getRoomChannelId(clientId, roomId);
  let room = state.rooms.get(channelId);
  if (room) {
    return room;
  }
  clearCachedMinutesArtifacts(channelId);

  const worker = await getWorker(state.workers as Worker[]);

  const router = await worker.createRouter({
    mediaCodecs: config.routerMediaCodecs as any,
  });

  room = new Room({ id: roomId, router, clientId });
  state.rooms.set(channelId, room);
  Logger.success(`Created room: ${roomId} (${clientId})`);

  return room;
};

export const cleanupRoom = (state: SfuState, channelId: string): boolean => {
  const room = state.rooms.get(channelId);
  if (room && room.isEmpty()) {
    const transcript = stopRoomTranscriber(channelId);
    if (transcript.length) {
      setCachedTranscript(channelId, transcript);
      void summarizeTranscript(transcript)
        .then(async (summary) => {
          Logger.info(`Room ${room.id} summary`, summary);
          // Cache PDF in memory for quick retrieval if needed shortly after cleanup
          // add feature that allows access to earlier MOMs later REMEMVERRR
          try {
            const pdf = await buildMinutesPdf({
              roomId: room.id,
              summary,
              transcript,
            });
            setCachedMinutes(channelId, pdf);
          } catch (err) {
            Logger.warn("Failed to build minutes PDF", err);
          }
        })
        .catch((err) => {
          Logger.warn("Failed to summarize transcript", err);
        });
    }
    const webinarConfig = state.webinarConfigs.get(channelId);
    if (webinarConfig) {
      clearWebinarLinkSlug({
        webinarConfig,
        webinarLinks: state.webinarLinks,
        roomChannelId: channelId,
      });
      state.webinarConfigs.delete(channelId);
    }
    room.close();
    state.rooms.delete(channelId);
    Logger.info(`Closed empty room: ${room.id} (${room.clientId})`);
    void cleanupRoomBrowser(channelId);
    return true;
  }
  return false;
};

type CachedMinutes = { pdf: Buffer; createdAt: number };
const RoomMinutesCache = new Map<string, CachedMinutes>();
type CachedTranscript = { transcript: TranscriptChunk[]; createdAt: number };
const RoomTranscriptCache = new Map<string, CachedTranscript>();

const isFreshEntry = (createdAt: number): boolean =>
  Date.now() - createdAt <= MINUTES_CACHE_TTL_MS;

const cloneTranscript = (transcript: TranscriptChunk[]): TranscriptChunk[] =>
  transcript.map((chunk) => ({ ...chunk }));

export const setCachedMinutes = (channelId: string, pdf: Buffer): void => {
  RoomMinutesCache.set(channelId, { pdf: Buffer.from(pdf), createdAt: Date.now() });
};

export const setCachedTranscript = (
  channelId: string,
  transcript: TranscriptChunk[],
): void => {
  RoomTranscriptCache.set(channelId, {
    transcript: cloneTranscript(transcript),
    createdAt: Date.now(),
  });
};

export const clearCachedMinutesArtifacts = (channelId: string): void => {
  RoomMinutesCache.delete(channelId);
  RoomTranscriptCache.delete(channelId);
};

export const getCachedMinutes = (channelId: string): Buffer | null => {
  const entry = RoomMinutesCache.get(channelId);
  if (!entry) return null;
  if (!isFreshEntry(entry.createdAt)) {
    RoomMinutesCache.delete(channelId);
    return null;
  }
  return Buffer.from(entry.pdf);
};

export const getCachedTranscript = (channelId: string): TranscriptChunk[] => {
  const entry = RoomTranscriptCache.get(channelId);
  if (!entry) return [];
  if (!isFreshEntry(entry.createdAt)) {
    RoomTranscriptCache.delete(channelId);
    return [];
  }
  return cloneTranscript(entry.transcript);
};

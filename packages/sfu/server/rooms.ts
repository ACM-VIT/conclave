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

export const getRoomChannelId = (clientId: string, roomId: string): string =>
  `${clientId}:${roomId}`;

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
      RoomTranscriptCache.set(channelId, { transcript, createdAt: Date.now() });
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
            RoomMinutesCache.set(channelId, { pdf, createdAt: Date.now() });
          } catch (err) {
            Logger.warn("Failed to build minutes PDF", err);
          }
        })
        .catch((err) => {
          Logger.warn("Failed to summarize transcript", err);
        });
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

export const popCachedMinutes = (channelId: string): Buffer | null => {
  const entry = RoomMinutesCache.get(channelId);
  if (!entry) return null;
  RoomMinutesCache.delete(channelId);
  RoomTranscriptCache.delete(channelId);
  return entry.pdf;
};

export const popCachedTranscript = (channelId: string): TranscriptChunk[] => {
  const entry = RoomTranscriptCache.get(channelId);
  if (!entry) return [];
  RoomTranscriptCache.delete(channelId);
  return entry.transcript;
};

import type { Worker } from "mediasoup/types";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import getWorker from "../utilities/getWorker.js";
import { Logger } from "../utilities/loggers.js";
import { cleanupRoomBrowser } from "./socket/handlers/sharedBrowserHandlers.js";
import type { SfuState } from "./state.js";
import { clearWebinarLinkSlug } from "./webinar.js";

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

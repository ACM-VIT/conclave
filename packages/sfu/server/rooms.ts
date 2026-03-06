import type { Worker } from "mediasoup/types";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import getWorker from "../utilities/getWorker.js";
import { Logger } from "../utilities/loggers.js";
import { cleanupRoomBrowser } from "./socket/handlers/sharedBrowserHandlers.js";
import type { EndedRoom, SfuState } from "./state.js";
import { clearWebinarLinkSlug } from "./webinar.js";

export const getRoomChannelId = (clientId: string, roomId: string): string =>
  `${clientId}:${roomId}`;

export const getEndedRoom = (
  state: SfuState,
  channelId: string,
): EndedRoom | null => state.endedRooms.get(channelId) ?? null;

export const markRoomEnded = (
  state: SfuState,
  room: Pick<Room, "id" | "clientId" | "channelId">,
  options: {
    message: string;
    endedBy: string;
  },
): EndedRoom => {
  const endedRoom: EndedRoom = {
    roomId: room.id,
    clientId: room.clientId,
    message: options.message,
    endedAt: Date.now(),
    endedBy: options.endedBy,
  };

  state.endedRooms.set(room.channelId, endedRoom);
  return endedRoom;
};

export const clearEndedRoom = (state: SfuState, channelId: string): boolean =>
  state.endedRooms.delete(channelId);

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

const cleanupRoomState = (state: SfuState, channelId: string): Room | null => {
  const room = state.rooms.get(channelId);
  if (!room) {
    return null;
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
  void cleanupRoomBrowser(channelId);
  return room;
};

export const forceCloseRoom = (state: SfuState, channelId: string): boolean => {
  const room = cleanupRoomState(state, channelId);
  if (!room) {
    return false;
  }
  Logger.info(`Force closed room: ${room.id} (${room.clientId})`);
  return true;
};

export const cleanupRoom = (state: SfuState, channelId: string): boolean => {
  const room = state.rooms.get(channelId);
  if (!room || !room.isEmpty()) {
    return false;
  }

  const closedRoom = cleanupRoomState(state, channelId);
  if (!closedRoom) {
    return false;
  }

  Logger.info(`Closed empty room: ${closedRoom.id} (${closedRoom.clientId})`);
  return true;
};

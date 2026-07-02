import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import getWorker from "../utilities/getWorker.js";
import { Logger } from "../utilities/loggers.js";
import { RoomOwnershipError } from "./roomRegistry.js";
import { cleanupRoomBrowser } from "./socket/handlers/sharedBrowserHandlers.js";
import type { EndedRoom, SfuState } from "./state.js";
import { clearWebinarLinkSlug } from "./webinar.js";
import { canonicalizeClientId } from "./clientIds.js";

export const getRoomChannelId = (clientId: string, roomId: string): string =>
  `${canonicalizeClientId(clientId)}:${roomId}`;

export const getEndedRoom = (
  state: SfuState,
  channelId: string,
): EndedRoom | null => state.endedRooms.get(channelId) ?? null;

const getRoomWorkerLoadScores = (state: SfuState): Map<number, number> => {
  const scores = new Map<number, number>();

  for (const room of state.rooms.values()) {
    if (room.router.closed || room.workerPid === null) {
      continue;
    }

    let producerCount = 0;
    let consumerCount = 0;
    for (const client of room.clients.values()) {
      producerCount += client.producers.size;
      consumerCount += client.consumers.size;
    }

    const roomScore =
      1000 +
      (room.clients.size + room.pendingClients.size) * 10 +
      producerCount * 5 +
      consumerCount;
    scores.set(room.workerPid, (scores.get(room.workerPid) ?? 0) + roomScore);
  }

  return scores;
};

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
  requestedClientId: string,
  roomId: string,
): Promise<Room> => {
  const clientId = canonicalizeClientId(requestedClientId);
  const channelId = getRoomChannelId(clientId, roomId);
  let room = state.rooms.get(channelId);
  if (room) {
    if (!room.router.closed) {
      const ownership = await state.roomRegistry.claimRoom({
        channelId,
        clientId,
        roomId,
      });
      if (!ownership.ok) {
        Logger.warn(
          `Closing local room ${roomId} (${clientId}) because ownership belongs to ${ownership.owner.instanceId}`,
        );
        cleanupRoomState(state, channelId);
        throw new RoomOwnershipError(ownership.owner);
      }
      return room;
    }
    Logger.warn(
      `Discarding stale room with closed router: ${roomId} (${clientId})`,
    );
    cleanupRoomState(state, channelId);
    room = undefined;
  }

  const pendingCreation = state.roomCreations.get(channelId);
  if (pendingCreation) {
    return pendingCreation;
  }

  const creation = (async (): Promise<Room> => {
    const ownership = await state.roomRegistry.claimRoom({
      channelId,
      clientId,
      roomId,
    });
    if (!ownership.ok) {
      throw new RoomOwnershipError(ownership.owner);
    }

    const worker = await getWorker(state.workers, {
      loadScoresByPid: getRoomWorkerLoadScores(state),
    });

    let createdRoom: Room;
    try {
      const router = await worker.createRouter({
        mediaCodecs: config.routerMediaCodecs,
      });
      createdRoom = new Room({
        id: roomId,
        router,
        clientId,
        workerPid: typeof worker.pid === "number" ? worker.pid : null,
      });
    } catch (error) {
      await state.roomRegistry.releaseRoom(channelId);
      throw error;
    }

    state.rooms.set(channelId, createdRoom);
    Logger.success(`Created room: ${roomId} (${clientId})`);
    return createdRoom;
  })();

  state.roomCreations.set(channelId, creation);

  try {
    return await creation;
  } finally {
    if (state.roomCreations.get(channelId) === creation) {
      state.roomCreations.delete(channelId);
    }
  }
};

const cleanupRoomState = (state: SfuState, channelId: string): Room | null => {
  const room = state.rooms.get(channelId);
  if (!room) {
    return null;
  }

  const webinarConfig = state.webinarConfigs.get(channelId);
  if (webinarConfig) {
    if (!webinarConfig.scheduledWebinarId) {
      clearWebinarLinkSlug({
        webinarConfig,
        webinarLinks: state.webinarLinks,
        roomChannelId: channelId,
      });
      state.webinarConfigs.delete(channelId);
    }
  }

  room.close();
  state.transcriptRelays.stopRoom(room.channelId);
  state.rooms.delete(channelId);
  void state.roomRegistry.releaseRoom(channelId).catch((error) => {
    Logger.warn(`Failed to release room ownership for ${channelId}`, error);
  });
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

export const cleanupStaleRoom = (
  state: SfuState,
  channelId: string,
): boolean => {
  const room = state.rooms.get(channelId);
  if (!room || !room.router.closed) {
    return false;
  }

  cleanupRoomState(state, channelId);
  Logger.warn(
    `Discarded stale room with closed router: ${room.id} (${room.clientId})`,
  );
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

export const renewRoomOwnerships = async (state: SfuState): Promise<void> => {
  const rooms = Array.from(state.rooms.values());
  for (const room of rooms) {
    if (room.router.closed) {
      Logger.warn(
        `Cleaning up room ${room.id} (${room.clientId}) with closed router during ownership renewal`,
      );
      cleanupRoomState(state, room.channelId);
      continue;
    }

    const ownership = await state.roomRegistry.renewRoom({
      channelId: room.channelId,
      clientId: room.clientId,
      roomId: room.id,
    });
    if (ownership.ok) {
      continue;
    }

    Logger.warn(
      `Closing room ${room.id} (${room.clientId}) because ownership moved to ${ownership.owner.instanceId}`,
    );
    cleanupRoomState(state, room.channelId);
  }
};

export const releaseAllRoomOwnerships = async (
  state: SfuState,
): Promise<void> => {
  const releases = Array.from(state.rooms.values()).map((room) =>
    state.roomRegistry.releaseRoom(room.channelId),
  );
  await Promise.allSettled(releases);
};

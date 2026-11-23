import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import getWorker, { type WorkerLoad } from "../utilities/getWorker.js";
import { getWorkerWebRtcServer } from "../utilities/createWorkers.js";
import type { Worker } from "mediasoup/types";
import { Logger } from "../utilities/loggers.js";
import {
  RoomLeaseExpiredError,
  RoomOwnershipError,
} from "./roomRegistry.js";
import { cleanupRoomBrowser } from "./socket/handlers/sharedBrowserHandlers.js";
import type { EndedRoom, SfuState } from "./state.js";
import { clearWebinarLinkSlug } from "./webinar.js";
import { canonicalizeClientId } from "./clientIds.js";

export const getRoomChannelId = (clientId: string, roomId: string): string =>
  `${canonicalizeClientId(clientId)}:${roomId}`;

// Rooms this instance keeps serving although the shared registry could not
// confirm their lease. A registry outage must not end a call that is already
// running here; the lease is claimed again once the registry answers.
const unconfirmedRoomLeases = new WeakMap<SfuState, Set<string>>();

const getUnconfirmedRoomLeases = (state: SfuState): Set<string> => {
  let channelIds = unconfirmedRoomLeases.get(state);
  if (!channelIds) {
    channelIds = new Set();
    unconfirmedRoomLeases.set(state, channelIds);
  }
  return channelIds;
};

export const hasUnconfirmedRoomLeases = (state: SfuState): boolean =>
  getUnconfirmedRoomLeases(state).size > 0;

const keepRoomWithoutConfirmedLease = (state: SfuState, room: Room): void => {
  if (state.rooms.get(room.channelId) !== room) return;
  const channelIds = getUnconfirmedRoomLeases(state);
  if (channelIds.has(room.channelId)) return;
  channelIds.add(room.channelId);
  Logger.warn(
    `Shared room registry is unavailable; keeping room ${room.id} (${room.clientId}) open and retrying its lease`,
  );
};

const noteRoomLeaseConfirmed = (state: SfuState, room: Room): void => {
  if (state.rooms.get(room.channelId) !== room) return;
  if (getUnconfirmedRoomLeases(state).delete(room.channelId)) {
    Logger.success(
      `Shared room registry is back; room ${room.id} (${room.clientId}) is registered again`,
    );
  }
};

export const getEndedRoom = (
  state: SfuState,
  channelId: string,
): EndedRoom | null => state.endedRooms.get(channelId) ?? null;

const getRoomWorkerLoads = (state: SfuState): Map<number, WorkerLoad> => {
  const loads = new Map<number, WorkerLoad>();
  for (const [pid, pendingRooms] of state.workerRoomReservations) {
    loads.set(pid, { consumers: 0, rooms: 0, pendingRooms });
  }

  for (const room of state.rooms.values()) {
    if (room.router.closed || room.workerPid === null) {
      continue;
    }

    const load = loads.get(room.workerPid) ?? { consumers: 0, rooms: 0, pendingRooms: 0 };
    load.rooms++;
    for (const client of room.clients.values()) {
      load.consumers += client.consumers.size;
    }
    loads.set(room.workerPid, load);
  }

  return loads;
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
): Promise<Room> =>
  (await getOrCreateRoomWithOrigin(state, requestedClientId, roomId)).room;

/**
 * The live room registered for this channel, with its lease renewed, or null
 * when there is none (or it closed while the lease was being renewed). Never
 * creates a room, so callers that may create one apply their own creation
 * checks and know whether they created it.
 */
export const renewLocalRoom = async (
  state: SfuState,
  requestedClientId: string,
  roomId: string,
): Promise<Room | null> => {
  const clientId = canonicalizeClientId(requestedClientId);
  const channelId = getRoomChannelId(clientId, roomId);
  const room = state.rooms.get(channelId);
  if (!room) return null;
  if (room.router.closed) {
    Logger.warn(
      `Discarding stale room with closed router: ${roomId} (${clientId})`,
    );
    cleanupRoomState(state, room);
    return null;
  }
  let ownership;
  try {
    ownership = await state.roomRegistry.renewRoom({
      channelId,
      clientId,
      roomId,
    });
  } catch (error) {
    if (!(error instanceof RoomLeaseExpiredError)) throw error;
    keepRoomWithoutConfirmedLease(state, room);
  }
  if (ownership?.ok) {
    noteRoomLeaseConfirmed(state, room);
  } else if (ownership) {
    if (isCurrentRoom(state, room)) {
      Logger.warn(
        `Closing local room ${roomId} (${clientId}) because ownership belongs to ${ownership.owner.instanceId}`,
      );
      cleanupRoomState(state, room);
    }
    throw new RoomOwnershipError(ownership.owner);
  }
  // The last client can leave during the renew await, which closes the room
  // and removes it from the map; never hand back a closed room. If another
  // joiner already created its successor, that is the live room.
  const current = state.rooms.get(channelId);
  if (current && !current.router.closed) return current;
  Logger.warn(
    `Room ${roomId} (${clientId}) closed while renewing its lease`,
  );
  return null;
};

/**
 * Like getOrCreateRoom, but also reports whether this call created the room.
 * `created` is true only for the caller that started the creation; callers
 * that found the room already registered, or joined a creation already in
 * flight, get false.
 */
export const getOrCreateRoomWithOrigin = async (
  state: SfuState,
  requestedClientId: string,
  roomId: string,
): Promise<{ room: Room; created: boolean }> => {
  const clientId = canonicalizeClientId(requestedClientId);
  const channelId = getRoomChannelId(clientId, roomId);
  const existing = await renewLocalRoom(state, clientId, roomId);
  if (existing) {
    return { room: existing, created: false };
  }

  const pendingCreation = state.roomCreations.get(channelId);
  if (pendingCreation) {
    return { room: await pendingCreation, created: false };
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

    let worker: Worker | undefined;
    try {
      // Reserve the slot before createRouter yields to other room creations.
      worker = getWorker(state.workers, getRoomWorkerLoads(state));
      const reservations = state.workerRoomReservations;
      reservations.set(worker.pid, (reservations.get(worker.pid) ?? 0) + 1);
      const router = await worker.createRouter({
        mediaCodecs: config.routerMediaCodecs,
      });
      const createdRoom = new Room({
        id: roomId,
        router,
        clientId,
        webRtcServer: getWorkerWebRtcServer(worker),
        workerPid: typeof worker.pid === "number" ? worker.pid : null,
      });
      state.rooms.set(channelId, createdRoom);
      Logger.success(`Created room: ${roomId} (${clientId})`);
      return createdRoom;
    } catch (error) {
      await state.roomRegistry.releaseRoom(channelId);
      throw error;
    } finally {
      if (worker) {
        const reservations = state.workerRoomReservations;
        const remaining = (reservations.get(worker.pid) ?? 1) - 1;
        if (remaining > 0) reservations.set(worker.pid, remaining);
        else reservations.delete(worker.pid);
      }
    }
  })();

  state.roomCreations.set(channelId, creation);

  try {
    return { room: await creation, created: true };
  } finally {
    if (state.roomCreations.get(channelId) === creation) {
      state.roomCreations.delete(channelId);
    }
  }
};

/**
 * Whether `room` is still the room registered for its channel. A delayed
 * close armed for one room must not touch a newer room that was reopened on
 * the same channel (or a second close of the same room).
 */
export const isCurrentRoom = (
  state: SfuState,
  room: Pick<Room, "channelId">,
): boolean => state.rooms.get(room.channelId) === room;

// Closes exactly this room. Anything that saw a room and then awaited may
// find its channel reopened by a newer room, which this never touches.
const cleanupRoomState = (state: SfuState, room: Room): boolean => {
  if (!isCurrentRoom(state, room)) return false;
  const { channelId } = room;

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
  getUnconfirmedRoomLeases(state).delete(channelId);
  void state.roomRegistry.releaseRoom(channelId).catch((error) => {
    Logger.warn(`Failed to release room ownership for ${channelId}`, error);
  });
  void cleanupRoomBrowser(channelId);
  return true;
};

export const forceCloseRoom = (state: SfuState, room: Room): boolean => {
  if (!cleanupRoomState(state, room)) return false;
  Logger.info(`Force closed room: ${room.id} (${room.clientId})`);
  return true;
};

export const cleanupStaleRoom = (state: SfuState, room: Room): boolean => {
  if (!room.router.closed || !cleanupRoomState(state, room)) return false;
  Logger.warn(
    `Discarded stale room with closed router: ${room.id} (${room.clientId})`,
  );
  return true;
};

export const cleanupRoom = (state: SfuState, room: Room): boolean => {
  if (!room.isEmpty() || !cleanupRoomState(state, room)) return false;
  Logger.info(`Closed empty room: ${room.id} (${room.clientId})`);
  return true;
};

export const renewRoomOwnerships = async (state: SfuState): Promise<void> => {
  const rooms = Array.from(state.rooms.values());
  for (const room of rooms) {
    // An earlier room's renewal can take a while. A room that closed in the
    // meantime is no longer this loop's business, even if its channel was
    // reopened by a newer room.
    if (!isCurrentRoom(state, room)) continue;
    if (room.router.closed) {
      Logger.warn(
        `Cleaning up room ${room.id} (${room.clientId}) with closed router during ownership renewal`,
      );
      cleanupRoomState(state, room);
      continue;
    }

    let ownership;
    try {
      ownership = await state.roomRegistry.renewRoom({
        channelId: room.channelId,
        clientId: room.clientId,
        roomId: room.id,
      });
    } catch (error) {
      if (error instanceof RoomLeaseExpiredError) {
        keepRoomWithoutConfirmedLease(state, room);
        continue;
      }
      throw error;
    }
    if (ownership.ok) {
      noteRoomLeaseConfirmed(state, room);
      continue;
    }
    // The room can close during the renewal. Whatever holds its channel
    // now is renewed on its own turn.
    if (!isCurrentRoom(state, room)) continue;

    Logger.warn(
      `Closing room ${room.id} (${room.clientId}) because ownership moved to ${ownership.owner.instanceId}`,
    );
    cleanupRoomState(state, room);
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

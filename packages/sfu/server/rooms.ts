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
import {
  getScheduledMeetingByRoomCode,
  persistScheduledMeetingChanges,
  refreshScheduledMeeting,
  setScheduledInviteeReadmission,
} from "./scheduledMeetings.js";
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
  room: Pick<Room, "id" | "clientId" | "channelId" | "markEnded">,
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
  // Ended from this moment, not from when the room closes: it may stay open
  // up to half a minute to say goodbye, and must not renew passes meanwhile.
  room.markEnded();
  state.roomRecovery.noteEnded(room);
  return endedRoom;
};

// A change to who hosts, or to who has to be let in again, goes to the
// ledger at once. The SFU may not live to the next renewal sweep.
const recordRecoverableChanges = (state: SfuState, room: Room): void => {
  room.onRecoverableChange = () => {
    if (room.recordsItsCall) state.roomRecovery.noteRunning(room);
  };
};

/**
 * A scheduled meeting's invitations outlive its room, so a host removing an
 * invited person has to outlive it too. The room starts with the removals the
 * schedule already holds, and tells the schedule about new ones.
 */
const bindScheduledInvitations = (state: SfuState, room: Room): void => {
  const meeting = getScheduledMeetingByRoomCode(
    state.scheduledMeetings,
    room.clientId,
    room.id,
  );
  for (const email of meeting?.readmissionRequiredEmails ?? []) {
    room.requireReadmission(email);
  }
  room.onReadmissionChange = (userKey, required) => {
    const changed = setScheduledInviteeReadmission(
      state.scheduledMeetings,
      room.clientId,
      room.id,
      userKey,
      required,
    );
    if (!changed || !state.scheduledMeetingPersistence) return;
    persistScheduledMeetingChanges(
      state.scheduledMeetings,
      state.scheduledMeetingPersistence,
      [changed],
    ).catch((error) => {
      Logger.warn(`Failed to persist an invitee's removal from ${room.id}`, error);
    });
  };
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
    cleanupRoomState(state, channelId);
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
    if (error instanceof RoomLeaseExpiredError) {
      Logger.warn(
        `Closing room ${roomId} (${clientId}) before its unconfirmed shared lease can expire`,
      );
      cleanupRoomState(state, channelId);
    }
    throw error;
  }
  if (!ownership.ok) {
    Logger.warn(
      `Closing local room ${roomId} (${clientId}) because ownership belongs to ${ownership.owner.instanceId}`,
    );
    cleanupRoomState(state, channelId);
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
    // Another SFU may have changed this meeting's invitations since this one
    // loaded them.
    await refreshScheduledMeeting(
      state.scheduledMeetings,
      state.scheduledMeetingPersistence,
      clientId,
      roomId,
    );

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
      bindScheduledInvitations(state, createdRoom);
      recordRecoverableChanges(state, createdRoom);
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

/**
 * Whether `room` is still the room registered for its channel. A delayed
 * close armed for one room must not touch a newer room that was reopened on
 * the same channel (or a second close of the same room).
 */
export const isCurrentRoom = (
  state: SfuState,
  room: Pick<Room, "channelId">,
): boolean => state.rooms.get(room.channelId) === room;

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
  // Emptying is a close on purpose, so the next visitor opens a new meeting.
  // Not so for a room that only stood in for a lost call, or one a host
  // ended: what the ledger says about those still holds.
  if (closedRoom.recordsItsCall) {
    state.roomRecovery.noteClosed(closedRoom);
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

    let ownership;
    try {
      ownership = await state.roomRegistry.renewRoom({
        channelId: room.channelId,
        clientId: room.clientId,
        roomId: room.id,
      });
    } catch (error) {
      if (error instanceof RoomLeaseExpiredError) {
        Logger.warn(
          `Closing room ${room.id} (${room.clientId}) before its unconfirmed shared lease can expire`,
        );
        cleanupRoomState(state, room.channelId);
        continue;
      }
      throw error;
    }
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

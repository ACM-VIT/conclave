import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import getWorker, { type WorkerLoad } from "../utilities/getWorker.js";
import { getWorkerWebRtcServer } from "../utilities/createWorkers.js";
import type { Worker } from "mediasoup/types";
import { Logger } from "../utilities/loggers.js";
import {
  RoomLeaseExpiredError,
  RoomOwnershipError,
  type RoomOwnershipClaim,
} from "./roomRegistry.js";
import {
  endScheduledMeetingRemovals,
  getScheduledMeetingByRoomCode,
  inviteeDecisionTime,
  persistInviteeReadmission,
  refreshScheduledMeeting,
  setScheduledInviteeReadmission,
} from "./scheduledMeetings.js";
import { cleanupRoomBrowser } from "./socket/handlers/sharedBrowserHandlers.js";
import type { EndedRoom, SfuState } from "./state.js";
import type { RecalledRoom } from "./roomRecoveryLedger.js";
import { clearWebinarLinkSlug } from "./webinar.js";
import {
  followMeetingsOpenedElsewhere,
  takeNextMeetingLobby,
  waitForNextMeeting,
} from "./nextMeetingLobby.js";
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
  room: Pick<
    Room,
    | "id"
    | "clientId"
    | "channelId"
    | "markEnded"
    | "incarnationId"
    | "takesOverRecordOf"
    | "ownerEmail"
  >,
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
  noteMeetingOver(state, room);
  return endedRoom;
};

/**
 * A meeting is over when a host ends it for everyone or its last person
 * leaves. Whoever opens its code next opens a new meeting: passes from this
 * one count for nothing there, and the people a host removed from this one
 * are invited again, as anyone a booking invites is.
 */
type LeasedRoom = Pick<Room, "id" | "clientId" | "channelId">;

export const ROOM_LEASE_CONFIRM_MS = 5_000;
export const ROOM_LEASE_UNCONFIRMED_ERROR =
  "This meeting is moving between servers. Try again in a moment.";

export const holdsRoomLease = (
  state: Pick<SfuState, "roomRegistry" | "deferredRoomWrites">,
  room: Pick<Room, "channelId">,
): boolean =>
  state.roomRegistry.holdsLease(room.channelId) && !state.deferredRoomWrites.has(room.channelId);

const releaseLease = (state: SfuState, channelId: string): void => {
  void state.roomRegistry.releaseRoom(channelId).catch((error) => {
    Logger.warn(`Failed to release room ownership for ${channelId}`, error);
  });
};

const releaseRoomLease = (state: SfuState, channelId: string): void => {
  const deferred = state.deferredRoomWrites.get(channelId);
  if (deferred) {
    deferred.releaseAfter = true;
    return;
  }
  releaseLease(state, channelId);
};

const settleRoomLease = (
  state: SfuState,
  channelId: string,
  outcome: "continuous" | "reclaimed" | "lost",
): void => {
  const deferred = state.deferredRoomWrites.get(channelId);
  if (!deferred) return;
  state.deferredRoomWrites.delete(channelId);
  if (outcome === "continuous") {
    for (const write of deferred.writes) {
      try {
        write.perform();
      } catch (error) {
        Logger.error(`Room ${deferred.room.id} failed to write ${write.label}`, error);
      }
    }
  } else {
    Logger.error(
      `Room ${deferred.room.id} dropped ${deferred.writes.map((write) => write.label).join(", ")}: ${
        outcome === "lost" ? "another SFU owns it now" : "its lease ran out before it was renewed"
      }.`,
    );
  }
  if (deferred.releaseAfter && outcome !== "lost" && !state.rooms.has(channelId)) {
    releaseLease(state, channelId);
  }
};

const settleOwnership = (
  state: SfuState,
  channelId: string,
  ownership: RoomOwnershipClaim,
): void =>
  settleRoomLease(
    state,
    channelId,
    !ownership.ok ? "lost" : ownership.continuous ? "continuous" : "reclaimed",
  );

const leaseConfirmations = new WeakMap<SfuState, Map<string, Promise<boolean>>>();

const renewForConfirmation = (state: SfuState, room: LeasedRoom): Promise<boolean> => {
  const pending = leaseConfirmations.get(state) ?? new Map<string, Promise<boolean>>();
  leaseConfirmations.set(state, pending);
  const inFlight = pending.get(room.channelId);
  if (inFlight) return inFlight;
  const renewal = state.roomRegistry
    .renewRoom({ channelId: room.channelId, clientId: room.clientId, roomId: room.id })
    .then(
      (ownership) => {
        settleOwnership(state, room.channelId, ownership);
        if (ownership.ok) return true;
        if (state.rooms.has(room.channelId)) {
          Logger.warn(
            `Closing room ${room.id} (${room.clientId}) because ownership moved to ${ownership.owner.instanceId}`,
          );
          handOffRoomState(state, room.channelId);
        }
        return false;
      },
      (error: unknown) => {
        settleRoomLease(state, room.channelId, "lost");
        if (error instanceof RoomLeaseExpiredError && state.rooms.has(room.channelId)) {
          handOffRoomState(state, room.channelId);
        }
        return false;
      },
    )
    .finally(() => pending.delete(room.channelId));
  pending.set(room.channelId, renewal);
  return renewal;
};

/**
 * Whether this SFU may act on `room` now: it holds the room's lease, or a
 * renewal confirms it within `ROOM_LEASE_CONFIRM_MS`. Writes the room put off
 * meanwhile are written first.
 */
export const confirmRoomLease = (state: SfuState, room: LeasedRoom): Promise<boolean> => {
  if (holdsRoomLease(state, room)) return Promise.resolve(true);
  const renewal = renewForConfirmation(state, room);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ROOM_LEASE_CONFIRM_MS);
  });
  return Promise.race([renewal, deadline]).finally(() => clearTimeout(timer));
};

/**
 * The one way a room writes what other servers read: at once while it holds
 * its lease, else in order once a renewal confirms the lease has not lapsed.
 * When it has, or another SFU owns the room, the writes are dropped and the
 * room is handed off.
 */
export const writeSharedRoomState = (
  state: SfuState,
  room: LeasedRoom,
  label: string,
  perform: () => void,
): void => {
  if (holdsRoomLease(state, room)) {
    perform();
    return;
  }
  const deferred = state.deferredRoomWrites.get(room.channelId) ?? {
    room: { id: room.id, clientId: room.clientId, channelId: room.channelId },
    writes: [],
    releaseAfter: false,
  };
  deferred.writes.push({ label, perform });
  state.deferredRoomWrites.set(room.channelId, deferred);
  Logger.warn(`Room ${room.id} waits for its lease to write ${label}.`);
  void renewForConfirmation(state, room);
};

const noteMeetingOver = (
  state: SfuState,
  room: Pick<
    Room,
    "id" | "clientId" | "channelId" | "incarnationId" | "takesOverRecordOf" | "ownerEmail"
  >,
): void => {
  const endedAt = Date.now();
  writeSharedRoomState(state, room, "the end of its meeting", () => {
    state.roomRecovery.noteOver(room);
    endScheduledMeetingRemovals(
      state.scheduledMeetings,
      state.scheduledMeetingPersistence,
      room.clientId,
      room.id,
      endedAt,
    ).catch((error) => {
      Logger.warn(`Failed to persist the end of the removals from ${room.id}`, error);
    });
  });
};

// A change to who hosts, or to who has to be let in again, goes to the
// ledger at once. The SFU may not live to the next renewal sweep.
const recordRecoverableChanges = (state: SfuState, room: Room): void => {
  room.onRecoverableChange = () => {
    if (!room.recordsItsCall) return;
    writeSharedRoomState(state, room, "its recovery record", () => {
      if (room.recordsItsCall) state.roomRecovery.noteRunning(room);
    });
  };
  // A lost call whose time ran out is a meeting that is over, as one that
  // emptied or was ended is.
  room.onLostCallEnded = () => noteMeetingOver(state, room);
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
    const decided = setScheduledInviteeReadmission(
      state.scheduledMeetings,
      room.clientId,
      room.id,
      userKey,
      required,
    );
    const persistence = state.scheduledMeetingPersistence;
    if (!decided || !persistence) return;
    const at = inviteeDecisionTime(decided, userKey);
    writeSharedRoomState(state, room, "an invitee's removal", () => {
      persistInviteeReadmission(
        state.scheduledMeetings,
        persistence,
        decided,
        userKey,
        required,
        at,
      ).catch((error) => {
        Logger.warn(`Failed to persist an invitee's removal from ${room.id}`, error);
      });
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
    handOffRoomState(state, channelId);
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
      settleRoomLease(state, channelId, "lost");
      handOffRoomState(state, channelId);
    }
    throw error;
  }
  settleOwnership(state, channelId, ownership);
  if (!ownership.ok) {
    Logger.warn(
      `Closing local room ${roomId} (${clientId}) because ownership belongs to ${ownership.owner.instanceId}`,
    );
    handOffRoomState(state, channelId);
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
 * Like getOrCreateRoom, but also reports whether this call created the room,
 * and if it did, what the recovery record said when it did.
 * `created` is true only for the caller that started the creation; callers
 * that found the room already registered, or joined a creation already in
 * flight, get false.
 */
export const getOrCreateRoomWithOrigin = async (
  state: SfuState,
  requestedClientId: string,
  roomId: string,
): Promise<{ room: Room; created: boolean; recalled: RecalledRoom | null }> => {
  const clientId = canonicalizeClientId(requestedClientId);
  const channelId = getRoomChannelId(clientId, roomId);
  const existing = await renewLocalRoom(state, clientId, roomId);
  if (existing) {
    return { room: existing, created: false, recalled: null };
  }

  const pendingCreation = state.roomCreations.get(channelId);
  if (pendingCreation) {
    return { room: await pendingCreation, created: false, recalled: null };
  }

  let recalled: RecalledRoom | null = null;
  const creation = (async (): Promise<Room> => {
    const ownership = await state.roomRegistry.claimRoom({
      channelId,
      clientId,
      roomId,
    });
    settleOwnership(state, channelId, ownership);
    if (!ownership.ok) {
      throw new RoomOwnershipError(ownership.owner);
    }
    // Read only now that this SFU holds the code, and before the room is in
    // anyone's hands. A room that came and went while this join waited has
    // written its last by now, so the record this room takes over is the
    // newest one.
    const record = await state.roomRecovery.recall(channelId);
    recalled = record;
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
      createdRoom.recoveryPassesVoidUntil = record.passesVoidUntil;
      createdRoom.takesOverRecordOf = record.lastWriter;
      createdRoom.awaitingOpener = { lost: record.lost };
      for (const guest of takeNextMeetingLobby(state, channelId)) {
        createdRoom.addPendingClient(
          guest.userKey,
          guest.userId,
          guest.socket,
          guest.displayName,
          guest.guestProof,
        );
      }
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
    const room = await creation;
    return { room, created: true, recalled };
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
  releaseRoomLease(state, channelId);
  void cleanupRoomBrowser(channelId);
  return room;
};

const handOffRoomState = (state: SfuState, channelId: string): Room | null => {
  state.rooms.get(channelId)?.beginHandOff();
  return cleanupRoomState(state, channelId);
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
  const room = handOffRoomState(state, channelId);
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

  handOffRoomState(state, channelId);
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

  const waiting = [...room.pendingClients.values()].map((request) => ({
    ...request,
    guestProof: room.guestProofOf(request.userKey),
  }));
  const retryAt =
    room.restorerState(Date.now()) === "awaited" ? room.restorerDeadline : null;
  if (room.endsWhenEmpty) {
    noteMeetingOver(state, room);
  }
  const closedRoom = cleanupRoomState(state, channelId);
  if (!closedRoom) {
    return false;
  }
  // Those knocking on a meeting a host ended were told so, and are let go.
  if (!closedRoom.hasEnded) {
    waitForNextMeeting(state, closedRoom, waiting, retryAt);
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
      handOffRoomState(state, room.channelId);
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
        settleRoomLease(state, room.channelId, "lost");
        handOffRoomState(state, room.channelId);
        continue;
      }
      throw error;
    }
    settleOwnership(state, room.channelId, ownership);
    if (ownership.ok) {
      continue;
    }

    Logger.warn(
      `Closing room ${room.id} (${room.clientId}) because ownership moved to ${ownership.owner.instanceId}`,
    );
    handOffRoomState(state, room.channelId);
  }
  await followMeetingsOpenedElsewhere(state);
};

export const releaseAllRoomOwnerships = async (
  state: SfuState,
): Promise<void> => {
  const releases = Array.from(state.rooms.values()).map((room) =>
    state.roomRegistry.releaseRoom(room.channelId),
  );
  await Promise.allSettled(releases);
};

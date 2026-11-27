import { runDetached } from "../runDetached.js";
import type { MediaKind, Worker } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
import { Admin } from "../../config/classes/Admin.js";
import type {
  Client,
  ConsumerTelemetrySnapshot,
  ProducerKey,
  ProducerType,
} from "../../config/classes/Client.js";
import type { AdmissionScope } from "../../config/classes/AdmissionLedger.js";
import type { HostBasis, Room, SettledWaitingRequest, WaitingRequest } from "../../config/classes/Room.js";
import type { AppsAwarenessData } from "../../types.js";
import { isGuestUserKey } from "../identity.js";
import { cleanupRoom, forceCloseRoom, getRoomChannelId, markRoomEnded } from "../rooms.js";
import type { SfuState } from "../state.js";
import {
  emitWebinarAttendeeCountChanged,
  emitWebinarFeedChanged,
} from "../webinarNotifications.js";
import { getSocketContext, type ConnectionContext } from "../socket/context.js";
import { emitChatHistorySnapshot } from "../socket/handlers/chatHistory.js";
import { registerAdminHandlers } from "../socket/handlers/adminHandlers.js";
import { emitToHost, emitToHosts } from "./hostOnlyEvents.js";
import { DECISION_RECORD_FULL, isSuperAdminClient } from "./moderation.js";
import { Logger } from "../../utilities/loggers.js";

type ParticipantRole = "host" | "admin" | "participant" | "attendee";

type ParticipantSnapshot = {
  userId: string;
  userKey: string | null;
  displayName: string;
  role: ParticipantRole;
  mode: Client["mode"];
  socketId: string;
  muted: boolean;
  cameraOff: boolean;
  producerTransportConnected: boolean;
  consumerTransportConnected: boolean;
  pendingDisconnect: boolean;
  producers: Array<{
    producerId: string;
    kind: MediaKind;
    type: ProducerType;
    paused: boolean;
  }>;
  consumerCount: number;
  consumers: ConsumerTelemetrySnapshot[];
};

export type PendingUserSnapshot = {
  userId: string;
  participantUserId: string;
  userKey: string;
  displayName: string;
  socketId: string | null;
};

export type RoomSnapshot = {
  id: string;
  channelId: string;
  clientId: string;
  hostUserId: string | null;
  adminUserIds: string[];
  screenShareProducerId: string | null;
  quality: "low" | "standard";
  appsState: {
    activeAppId: string | null;
    locked: boolean;
  };
  policies: {
    locked: boolean;
    chatLocked: boolean;
    noGuests: boolean;
    ttsDisabled: boolean;
    dmEnabled: boolean;
    imageAttachmentsEnabled: boolean;
    reactionsDisabled: boolean;
    participantUnmuteAllowed: boolean;
    participantVideoAllowed: boolean;
    requiresMeetingInviteCode: boolean;
  };
  access: {
    allowedUserKeys: string[];
    lockedAllowedUserKeys: string[];
    blockedUserKeys: string[];
  };
  counts: {
    participants: number;
    activeParticipants: number;
    admins: number;
    guests: number;
    webinarAttendees: number;
    pendingUsers: number;
    blockedUsers: number;
    producers: number;
    consumers: number;
  };
  participants: ParticipantSnapshot[];
  pendingUsers: PendingUserSnapshot[];
};

export type ClusterSnapshot = {
  draining: boolean;
  workers: {
    total: number;
    closed: number;
    healthy: number;
  };
  counts: {
    rooms: number;
    participants: number;
    pendingUsers: number;
    admins: number;
    webinarAttendees: number;
    producers: number;
    consumers: number;
  };
  roomsByClientId: Record<string, number>;
  topRooms: Array<{
    channelId: string;
    roomId: string;
    clientId: string;
    participantCount: number;
    pendingUserCount: number;
    adminCount: number;
  }>;
};

export type WorkerSnapshot = {
  index: number;
  pid: number | null;
  closed: boolean;
  usage: Record<string, number> | null;
  error?: string;
};

export type RoomLookupResult =
  | {
      room: Room;
      channelId: string;
    }
  | {
      error: string;
      candidates?: string[];
    };

export type RoomPolicyUpdate = {
  locked?: boolean;
  chatLocked?: boolean;
  noGuests?: boolean;
  ttsDisabled?: boolean;
  dmEnabled?: boolean;
  imageAttachmentsEnabled?: boolean;
  reactionsDisabled?: boolean;
  participantUnmuteAllowed?: boolean;
  participantVideoAllowed?: boolean;
};

type ProducerInfo = ReturnType<Client["getProducerInfos"]>[number];

export type HostGrant = {
  userKey: string;
  basis: HostBasis;
  guestProof?: string;
  primary?: boolean;
};

const activateHostSeat = (room: Room, seat: Admin, joining: ConnectionContext | undefined): void => {
  const roomId = room.id;
  const seatContext = joining ?? getSocketContext(seat.socket);
  if (seatContext) {
    seatContext.currentClient = seat;
    seatContext.currentRoom = room;
    registerAdminHandlers(seatContext, { roomId });
  }
  if (joining) return;
  emitToHost(seat, "pendingUsersSnapshot", { users: toPendingUserSnapshots(room), roomId });
  emitChatHistorySnapshot(seat.socket, room);
  seat.socket.emit("roomLockChanged", { locked: room.isLocked, roomId });
  emitToHost(seat, "admin:roomStateChanged", { roomId, snapshot: toRoomSnapshot(room) });
};

export const applyHostGrant = (
  room: Room,
  grant: HostGrant,
  options: { joining?: ConnectionContext } = {},
): Admin[] | null => {
  if (!room.mayGrantHost(grant.userKey, grant.basis, grant.guestProof)) return null;
  const hadHost = room.hasActiveAdmin();
  const promoted = room.grantHost(grant.userKey, grant.basis, grant.guestProof);
  if (grant.primary || !room.hostUserKey) room.makePrimaryHost(grant.userKey);
  if (room.hostReasonOf(grant.userKey, grant.guestProof) === "owner") {
    room.tellOwnerTookOver(room.welcomeOwner(grant.userKey));
  }
  if (promoted.length === 0) return promoted;
  room.stopCleanupTimer();
  for (const seat of promoted) {
    Logger.info(`Promoted ${seat.id} to host in room ${room.id} (${grant.basis}).`);
    activateHostSeat(
      room,
      seat,
      seat.socket === options.joining?.socket ? options.joining : undefined,
    );
  }
  if (!hadHost) {
    for (const pending of room.pendingClients.values()) {
      pending.socket.emit("waitingRoomStatus", {
        message: "A host is available to let you in.",
        roomId: room.id,
      });
    }
  }
  return promoted;
};

const promoteNextAdmin = (room: Room): Admin[] | null => {
  for (const client of [...room.clients.values()]) {
    if (client instanceof Admin || client.isObserver || client.isWebinarAttendee) continue;
    const userKey = room.userKeysById.get(client.id);
    if (!userKey) continue;
    const promoted = applyHostGrant(room, { userKey, basis: "fallback" });
    if (promoted && promoted.length > 0) return promoted;
  }
  return null;
};

export const NO_HOST_LEFT_MESSAGE = "The meeting ended because no one who can host it is left.";

type Peers = { emit: (event: string, payload: unknown) => unknown };

const endForNoHost = (io: SocketIOServer, state: SfuState, room: Room): void => {
  const pendingSockets = Array.from(room.pendingClients.values(), (pending) => pending.socket);
  markRoomEnded(state, room, { message: NO_HOST_LEFT_MESSAGE, endedBy: "server" });
  io.to(room.channelId).emit("roomEnded", {
    roomId: room.id,
    message: NO_HOST_LEFT_MESSAGE,
    endedBy: "server",
  });
  for (const socket of pendingSockets) {
    socket.emit("roomEnded", { roomId: room.id, message: NO_HOST_LEFT_MESSAGE, endedBy: "server" });
  }
  io.in(room.channelId).disconnectSockets(true);
  for (const socket of pendingSockets) socket.disconnect(true);
  forceCloseRoom(state, room);
};

const tellWaitingNoHost = (room: Room): void => {
  for (const pending of room.pendingClients.values()) {
    pending.socket.emit("waitingRoomStatus", { message: "No one to let you in.", roomId: room.id });
  }
};

export const ensureHost = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
  peers: Peers = io.to(room.channelId),
): void => {
  if (state.rooms.get(room.channelId) !== room) return;
  if (room.isHandingOff || room.hasEnded || !room.recordsItsCall) return;
  if (!room.hasActiveAdmin()) {
    const promoted = promoteNextAdmin(room);
    if (!promoted) {
      tellWaitingNoHost(room);
      room.startCleanupTimer(() => {
        if (state.rooms.get(room.channelId) !== room || room.hasActiveAdmin()) return;
        if (room.isEmpty()) {
          cleanupRoom(state, room);
          return;
        }
        const late = promoteNextAdmin(room);
        if (late) {
          io.to(room.channelId).emit("hostChanged", {
            roomId: room.id,
            hostUserId: room.getHostUserId(),
          });
          io.to(room.channelId).emit("adminUsersChanged", {
            roomId: room.id,
            hostUserIds: room.getAdminUserIds(),
          });
          return;
        }
        endForNoHost(io, state, room);
      });
    }
  }
  peers.emit("hostChanged", {
    roomId: room.id,
    hostUserId: room.getHostUserId(),
  });
  peers.emit("adminUsersChanged", {
    roomId: room.id,
    hostUserIds: room.getAdminUserIds(),
  });
};

const toParticipantRole = (room: Room, client: Client): ParticipantRole => {
  if (client.isWebinarAttendee) return "attendee";
  if (!(client instanceof Admin)) return "participant";
  const hostUserId = room.getHostUserId();
  return hostUserId === client.id ? "host" : "admin";
};

const toDisplayName = (room: Room, userId: string): string => {
  return room.getDisplayNameForUser(userId) || userId;
};

const toParticipantSnapshot = (
  room: Room,
  client: Client,
): ParticipantSnapshot => {
  const producers = client.getProducerInfos();
  const consumers = client.getConsumerTelemetrySnapshot();
  // Media state is derived from producers, not the client flags: the flags
  // default to "on" and a participant who never produced would read as live.
  // No unpaused webcam producer of a kind means that kind is off.
  const hasLiveAudio = producers.some(
    (producer) =>
      producer.kind === "audio" && producer.type === "webcam" && !producer.paused,
  );
  const hasLiveVideo = producers.some(
    (producer) =>
      producer.kind === "video" && producer.type === "webcam" && !producer.paused,
  );
  return {
    userId: client.id,
    userKey: room.userKeysById.get(client.id) ?? null,
    displayName: toDisplayName(room, client.id),
    role: toParticipantRole(room, client),
    mode: client.mode,
    socketId: client.socket.id,
    muted: !hasLiveAudio,
    cameraOff: !hasLiveVideo,
    producerTransportConnected: Boolean(client.producerTransport),
    consumerTransportConnected: Boolean(client.consumerTransport),
    pendingDisconnect: room.hasPendingDisconnect(client.id),
    producers,
    consumerCount: consumers.length,
    consumers,
  };
};

export const toPendingUserSnapshots = (room: Room): PendingUserSnapshot[] => {
  return room.waitingGuests().map((pending) => ({
    userId: pending.userKey,
    participantUserId: pending.userId,
    userKey: pending.userKey,
    displayName: pending.displayName || pending.userKey,
    socketId: pending.socket?.id ?? null,
  }));
};

export const emitPendingUsersSnapshot = (room: Room): void => {
  emitToHosts(room, "pendingUsersSnapshot", {
    users: toPendingUserSnapshots(room),
    roomId: room.id,
  });
};

export const toRoomSnapshot = (room: Room): RoomSnapshot => {
  const participants = Array.from(room.clients.values())
    .map((client) => toParticipantSnapshot(room, client));
  const pendingUsers = toPendingUserSnapshots(room);
  const adminCount = participants.filter(
    (participant) => participant.role === "host" || participant.role === "admin",
  ).length;
  const producers = participants.reduce(
    (sum, participant) => sum + participant.producers.length,
    0,
  );
  const consumers = participants.reduce(
    (sum, participant) => sum + participant.consumerCount,
    0,
  );
  const attendees = participants.filter(
    (participant) => participant.role === "attendee",
  ).length;
  const guests = participants.filter((participant) =>
    isGuestUserKey(participant.userKey),
  ).length;

  return {
    id: room.id,
    channelId: room.channelId,
    clientId: room.clientId,
    hostUserId: room.getHostUserId(),
    adminUserIds: room.getAdminUserIds(),
    screenShareProducerId: room.screenShareProducerId,
    quality: room.currentQuality,
    appsState: {
      activeAppId: room.appsState.activeAppId,
      locked: room.appsState.locked,
    },
    policies: {
      locked: room.isLocked,
      chatLocked: room.isChatLocked,
      noGuests: room.noGuests,
      ttsDisabled: room.isTtsDisabled,
      dmEnabled: room.isDmEnabled,
      imageAttachmentsEnabled: room.areImageAttachmentsEnabled,
      reactionsDisabled: room.isReactionsDisabled,
      participantUnmuteAllowed: room.isParticipantUnmuteAllowed,
      participantVideoAllowed: room.isParticipantVideoAllowed,
      requiresMeetingInviteCode: room.requiresMeetingInviteCode,
    },
    access: {
      allowedUserKeys: room.admittedUserKeys("waitingRoom"),
      lockedAllowedUserKeys: room.admittedUserKeys("lock"),
      blockedUserKeys: Array.from(room.blockedUsers.values()).sort(),
    },
    counts: {
      participants: participants.length,
      activeParticipants: room.getMeetingParticipantCount(),
      admins: adminCount,
      guests,
      webinarAttendees: attendees,
      pendingUsers: pendingUsers.length,
      blockedUsers: room.blockedUsers.size,
      producers,
      consumers,
    },
    participants,
    pendingUsers,
  };
};

export const toClusterSnapshot = (state: SfuState): ClusterSnapshot => {
  const rooms = Array.from(state.rooms.values());
  const roomsByClientId: Record<string, number> = {};
  const topRooms = rooms
    .map((room) => {
      roomsByClientId[room.clientId] = (roomsByClientId[room.clientId] || 0) + 1;
      return {
        channelId: room.channelId,
        roomId: room.id,
        clientId: room.clientId,
        participantCount:
          room.getMeetingParticipantCount() + room.getWebinarAttendeeCount(),
        pendingUserCount: room.waitingGuestCount,
        adminCount: room.getAdmins().length,
      };
    })
    .sort((a, b) => b.participantCount - a.participantCount)
    .slice(0, 10);

  const participants = rooms.reduce(
    (sum, room) =>
      sum + room.getMeetingParticipantCount() + room.getWebinarAttendeeCount(),
    0,
  );
  const pendingUsers = rooms.reduce(
    (sum, room) => sum + room.waitingGuestCount,
    0,
  );
  const admins = rooms.reduce((sum, room) => sum + room.getAdmins().length, 0);
  const webinarAttendees = rooms.reduce(
    (sum, room) => sum + room.getWebinarAttendeeCount(),
    0,
  );
  const producers = rooms.reduce((sum, room) => {
    const roomProducers = Array.from(room.clients.values()).reduce(
      (inner, client) => inner + client.producers.size,
      0,
    );
    return sum + roomProducers;
  }, 0);
  const consumers = rooms.reduce((sum, room) => {
    const roomConsumers = Array.from(room.clients.values()).reduce(
      (inner, client) => inner + client.consumers.size,
      0,
    );
    return sum + roomConsumers;
  }, 0);

  const closedWorkers = state.workers.filter((worker) => worker.closed).length;

  return {
    draining: state.isDraining,
    workers: {
      total: state.workers.length,
      closed: closedWorkers,
      healthy: state.workers.length - closedWorkers,
    },
    counts: {
      rooms: state.rooms.size,
      participants,
      pendingUsers,
      admins,
      webinarAttendees,
      producers,
      consumers,
    },
    roomsByClientId,
    topRooms,
  };
};

export const toWorkerSnapshots = async (
  state: SfuState,
): Promise<WorkerSnapshot[]> => {
  return Promise.all(
    state.workers.map(async (worker: Worker, index) => {
      const pid = typeof worker.pid === "number" ? worker.pid : null;
      if (worker.closed) {
        return {
          index,
          pid,
          closed: true,
          usage: null,
        };
      }

      try {
        const usage = await worker.getResourceUsage();
        return {
          index,
          pid,
          closed: false,
          usage: usage as unknown as Record<string, number>,
        };
      } catch (error) {
        return {
          index,
          pid,
          closed: false,
          usage: null,
          error: (error as Error).message,
        };
      }
    }),
  );
};

export const resolveRoom = (
  state: SfuState,
  roomId: string,
  options?: { clientId?: string },
): RoomLookupResult => {
  const normalizedRoomId = roomId.trim();
  if (!normalizedRoomId) {
    return { error: "Room ID is required" };
  }

  const clientId = options?.clientId?.trim();
  if (clientId) {
    const channelId = getRoomChannelId(clientId, normalizedRoomId);
    const room = state.rooms.get(channelId);
    if (!room) {
      return { error: "Room not found" };
    }
    return { room, channelId };
  }

  const candidates = Array.from(state.rooms.values()).filter(
    (room) => room.id === normalizedRoomId,
  );
  if (candidates.length === 0) {
    return { error: "Room not found" };
  }
  if (candidates.length > 1) {
    return {
      error: "Room ID is ambiguous. Provide a clientId.",
      candidates: candidates.map((room) => room.channelId),
    };
  }

  const room = candidates[0];
  return { room, channelId: room.channelId };
};

const notifyProducerClosed = (
  io: SocketIOServer,
  room: Room,
  ownerId: string,
  producerId: string,
): void => {
  for (const [targetClientId, targetClient] of room.clients.entries()) {
    if (targetClientId === ownerId || targetClient.isWebinarAttendee) {
      continue;
    }
    targetClient.socket.emit("producerClosed", {
      producerId,
      producerUserId: ownerId,
      roomId: room.id,
    });
  }
  io.to(room.channelId).emit("admin:producerClosed", {
    roomId: room.id,
    userId: ownerId,
    producerId,
  });
};

export const closeProducerById = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
  producerId: string,
): {
  closed: boolean;
  userId?: string;
  kind?: MediaKind;
  type?: ProducerType;
} => {
  const producerInfo = room.getProducerInfoById(producerId);
  if (!producerInfo) {
    return { closed: false };
  }

  const client = room.getClient(producerInfo.producerUserId);
  if (!client) {
    return { closed: false };
  }

  const removed = client.removeProducerById(producerId);
  if (!removed) {
    room.removeProducerIndexById(producerId);
    return { closed: false };
  }

  room.removeProducerIndexById(producerId);
  if (removed.kind === "video" && removed.type === "screen") {
    room.clearScreenShareProducer(producerId);
  }
  notifyProducerClosed(io, room, client.id, producerId);
  emitWebinarFeedChanged(io, state, room);

  client.socket.emit("admin:mediaEnforced", {
    roomId: room.id,
    userId: client.id,
    producerId,
    kind: removed.kind,
    type: removed.type,
    action: "closed",
  });

  return {
    closed: true,
    userId: client.id,
    kind: removed.kind,
    type: removed.type,
  };
};

const shouldCloseProducer = (
  info: ProducerInfo,
  selector?: {
    kinds?: MediaKind[];
    types?: ProducerType[];
  },
): boolean => {
  if (!selector) return true;
  if (selector.kinds && !selector.kinds.includes(info.kind)) return false;
  if (selector.types && !selector.types.includes(info.type)) return false;
  return true;
};

export const closeClientProducers = (options: {
  io: SocketIOServer;
  state: SfuState;
  room: Room;
  userId: string;
  selector?: {
    kinds?: MediaKind[];
    types?: ProducerType[];
  };
  reason: string;
}): {
  closedCount: number;
  closedProducers: Array<{
    producerId: string;
    kind: MediaKind;
    type: ProducerType;
  }>;
} => {
  const { io, state, room, userId, selector, reason } = options;
  const target = room.getClient(userId);
  if (!target) {
    return { closedCount: 0, closedProducers: [] };
  }

  const infos = target
    .getProducerInfos()
    .filter((info) => shouldCloseProducer(info, selector));

  const closedProducers: Array<{
    producerId: string;
    kind: MediaKind;
    type: ProducerType;
  }> = [];
  let webcamAudioClosed = false;
  let webcamVideoClosed = false;

  for (const info of infos) {
    const removed = target.removeProducerById(info.producerId);
    if (!removed) continue;
    room.removeProducerIndexById(info.producerId);

    if (removed.kind === "video" && removed.type === "screen") {
      room.clearScreenShareProducer(info.producerId);
    }

    notifyProducerClosed(io, room, userId, info.producerId);
    closedProducers.push({
      producerId: info.producerId,
      kind: removed.kind,
      type: removed.type,
    });
    if (removed.type === "webcam" && removed.kind === "audio") {
      webcamAudioClosed = true;
    } else if (removed.type === "webcam" && removed.kind === "video") {
      webcamVideoClosed = true;
    }
  }

  if (closedProducers.length > 0) {
    if (webcamAudioClosed) {
      target.isMuted = true;
      io.to(room.channelId).emit("participantMuted", {
        userId,
        muted: true,
        roomId: room.id,
      });
      runDetached("Syncing the room's transcript relay", () => state.transcriptRelays.syncRoom(room));
    }
    if (webcamVideoClosed) {
      target.isCameraOff = true;
      io.to(room.channelId).emit("participantCameraOff", {
        userId,
        cameraOff: true,
        roomId: room.id,
      });
    }
    emitWebinarFeedChanged(io, state, room);
    target.socket.emit("admin:mediaEnforced", {
      roomId: room.id,
      userId,
      action: "closed",
      reason,
      producers: closedProducers,
    });
  }

  return { closedCount: closedProducers.length, closedProducers };
};

export const applyRoomPolicyUpdate = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
  update: RoomPolicyUpdate,
): { changed: RoomPolicyUpdate } => {
  const changed: RoomPolicyUpdate = {};

  if (typeof update.locked === "boolean" && update.locked !== room.isLocked) {
    room.setLocked(update.locked);
    if (update.locked) {
      // The people already in may come back past the lock. A lock never
      // waits on the decision record: when it is full of refusals they knock
      // again instead.
      const present = room.keepAdmitted([...new Set(room.userKeysById.values())]);
      if (present.status === "full") {
        Logger.warn(
          `Room ${room.id} locked, but its decision record could not keep admissions for the people in it.`,
        );
      }
    }
    changed.locked = update.locked;
    io.to(room.channelId).emit("roomLockChanged", {
      locked: update.locked,
      roomId: room.id,
    });
  }

  if (
    typeof update.chatLocked === "boolean" &&
    update.chatLocked !== room.isChatLocked
  ) {
    room.setChatLocked(update.chatLocked);
    changed.chatLocked = update.chatLocked;
    io.to(room.channelId).emit("chatLockChanged", {
      locked: update.chatLocked,
      roomId: room.id,
    });
  }

  if (typeof update.noGuests === "boolean" && update.noGuests !== room.noGuests) {
    room.setNoGuests(update.noGuests);
    changed.noGuests = update.noGuests;
    io.to(room.channelId).emit("noGuestsChanged", {
      noGuests: update.noGuests,
      roomId: room.id,
    });
  }

  if (
    typeof update.ttsDisabled === "boolean" &&
    update.ttsDisabled !== room.isTtsDisabled
  ) {
    room.setTtsDisabled(update.ttsDisabled);
    changed.ttsDisabled = update.ttsDisabled;
    io.to(room.channelId).emit("ttsDisabledChanged", {
      disabled: update.ttsDisabled,
      roomId: room.id,
    });
  }

  if (typeof update.dmEnabled === "boolean" && update.dmEnabled !== room.isDmEnabled) {
    room.setDmEnabled(update.dmEnabled);
    changed.dmEnabled = update.dmEnabled;
    io.to(room.channelId).emit("dmStateChanged", {
      enabled: update.dmEnabled,
      roomId: room.id,
    });
  }

  if (
    typeof update.imageAttachmentsEnabled === "boolean" &&
    update.imageAttachmentsEnabled !== room.areImageAttachmentsEnabled
  ) {
    room.setImageAttachmentsEnabled(update.imageAttachmentsEnabled);
    changed.imageAttachmentsEnabled = update.imageAttachmentsEnabled;
    io.to(room.channelId).emit("imageAttachmentsStateChanged", {
      enabled: update.imageAttachmentsEnabled,
      roomId: room.id,
    });
  }

  if (
    typeof update.reactionsDisabled === "boolean" &&
    update.reactionsDisabled !== room.isReactionsDisabled
  ) {
    room.setReactionsDisabled(update.reactionsDisabled);
    changed.reactionsDisabled = update.reactionsDisabled;
    io.to(room.channelId).emit("reactionsDisabledChanged", {
      disabled: update.reactionsDisabled,
      roomId: room.id,
    });
  }

  let participantMediaPermissionsChanged = false;
  if (
    typeof update.participantUnmuteAllowed === "boolean" &&
    update.participantUnmuteAllowed !== room.isParticipantUnmuteAllowed
  ) {
    room.setParticipantUnmuteAllowed(update.participantUnmuteAllowed);
    changed.participantUnmuteAllowed = update.participantUnmuteAllowed;
    participantMediaPermissionsChanged = true;
  }

  if (
    typeof update.participantVideoAllowed === "boolean" &&
    update.participantVideoAllowed !== room.isParticipantVideoAllowed
  ) {
    room.setParticipantVideoAllowed(update.participantVideoAllowed);
    changed.participantVideoAllowed = update.participantVideoAllowed;
    participantMediaPermissionsChanged = true;
  }

  if (participantMediaPermissionsChanged) {
    const revokedKinds: MediaKind[] = [];
    if (changed.participantUnmuteAllowed === false) {
      revokedKinds.push("audio");
    }
    if (changed.participantVideoAllowed === false) {
      revokedKinds.push("video");
    }

    if (revokedKinds.length > 0) {
      for (const client of room.clients.values()) {
        if (client instanceof Admin || client.isObserver) {
          continue;
        }

        const activeRevokedKinds = revokedKinds.filter((kind) => {
          const producer = client.getProducer(kind, "webcam");
          return Boolean(producer && !producer.paused);
        });
        if (activeRevokedKinds.length === 0) {
          continue;
        }

        closeClientProducers({
          io,
          state,
          room,
          userId: client.id,
          selector: {
            kinds: activeRevokedKinds,
            types: ["webcam"],
          },
          reason: "Participant media permission revoked by host",
        });
      }
    }

    io.to(room.channelId).emit("participantMediaPermissionsChanged", {
      unmuteAllowed: room.isParticipantUnmuteAllowed,
      videoAllowed: room.isParticipantVideoAllowed,
      roomId: room.id,
    });
  }

  return { changed };
};

/**
 * Tells the hosts what changed in the lobby since they were last told: the
 * rows to take off, as admitted, turned away or gone, and the rows to add.
 * Every change to who waits goes through here, so a host's screen always
 * shows one row per waiting guest.
 */
export const publishLobby = (
  room: Room,
  options: { reason?: "locked" } = {},
): void => {
  const { removed, added } = room.takeLobbyChanges();
  if (removed.length === 0 && added.length === 0) return;
  for (const row of removed) {
    emitToHosts(
      room,
      row.outcome === "admitted"
        ? "userAdmitted"
        : row.outcome === "rejected"
          ? "userRejected"
          : "pendingUserLeft",
      { userId: row.userKey, roomId: room.id },
    );
  }
  for (const request of added) {
    emitToHosts(room, "userRequestedJoin", {
      userId: request.userKey,
      displayName: request.displayName || request.userKey,
      roomId: room.id,
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }
};

/**
 * What a host's admission did. When the room's decision record could not
 * keep it, nothing changed: every request is still waiting, and no one was
 * told they were let in.
 */
export type AdmitOutcome =
  | { ok: true; admitted: string[] }
  | { ok: false; code: typeof DECISION_RECORD_FULL };

// The scopes an admission from the lobby passes: the waiting room, and the
// lock too while the room is locked.
const lobbyScopes = (room: Room): AdmissionScope[] =>
  room.isLocked ? ["waitingRoom", "lock"] : ["waitingRoom"];

const admitRequests = (room: Room, requests: WaitingRequest[]): AdmitOutcome => {
  if (requests.length === 0) return { ok: true, admitted: [] };
  const result = room.admitUserKeys(
    requests.map((request) => ({ userKey: request.userKey, scopes: lobbyScopes(room) })),
  );
  if (result.status === "full") return { ok: false, code: DECISION_RECORD_FULL };
  for (const request of requests) {
    request.socket.emit("joinApproved", { roomId: room.id });
  }
  publishLobby(room);
  return { ok: true, admitted: requests.map((request) => request.userKey) };
};

/** Lets in the guest behind `userKey`: every tab of that guest that waits. */
export const admitWaitingGuest = (room: Room, userKey: string): AdmitOutcome =>
  admitRequests(room, room.waitingRequestsOfGuest(userKey));

/**
 * A host lets in `userKeys` by key (`admin:allowUsers`): every waiting tab
 * of each guest, and each key past the waiting room, and past the lock when
 * `allowWhenLocked` or the room is locked. One action, recorded together or
 * not at all.
 */
export const allowUserKeys = (
  room: Room,
  userKeys: string[],
  options: { allowWhenLocked: boolean },
):
  | { ok: true; allowed: string[]; refused: string[]; admitted: string[] }
  | { ok: false; code: typeof DECISION_RECORD_FULL; refused: string[] } => {
  const waiting = new Map(
    userKeys.map((userKey) => [userKey, room.waitingRequestsOfGuest(userKey)]),
  );
  // Two keys of one guest name the same waiting requests. Each request is
  // answered once: a second approval would start a second join.
  const requests = new Map<string, WaitingRequest>();
  for (const request of [...waiting.values()].flat()) {
    requests.set(request.userKey, request);
  }
  const keyScopes: AdmissionScope[] =
    options.allowWhenLocked || room.isLocked
      ? ["waitingRoom", "lock"]
      : ["waitingRoom"];
  const result = room.admitUserKeys([
    ...[...requests.values()].map((request) => ({
      userKey: request.userKey,
      scopes: lobbyScopes(room),
    })),
    ...userKeys.map((userKey) => ({ userKey, scopes: keyScopes })),
  ]);
  if (result.status === "full") {
    return { ok: false, code: DECISION_RECORD_FULL, refused: result.refused };
  }
  for (const request of requests.values()) {
    request.socket.emit("joinApproved", { roomId: room.id });
  }
  publishLobby(room);
  return {
    ok: true,
    allowed: userKeys.filter((userKey) => result.admitted.includes(userKey)),
    refused: userKeys.filter((userKey) => !result.admitted.includes(userKey)),
    admitted: userKeys.filter((userKey) => (waiting.get(userKey) ?? []).length > 0),
  };
};

/** Turns away the guest behind `userKey`: every tab of that guest that waits. */
export const rejectWaitingGuest = (room: Room, userKey: string): string[] => {
  const requests = room.waitingRequestsOfGuest(userKey);
  for (const request of requests) {
    room.denyWaitingRequest(request.userKey);
    request.socket.emit("joinRejected", { roomId: room.id });
  }
  publishLobby(room);
  return requests.map((request) => request.userKey);
};

/**
 * Tells the requests a pass link settled how they were answered (see
 * `Room.commitGuestLink`), and the hosts what their lobby now shows.
 */
export const answerSettledRequests = (
  room: Room,
  settled: SettledWaitingRequest[],
): void => {
  for (const { request, admitted } of settled) {
    request.socket.emit(admitted ? "joinApproved" : "joinRejected", {
      roomId: room.id,
    });
  }
  publishLobby(room);
};

/** Takes back one tab's request, because the tab left or came back another way. */
export const withdrawWaitingRequest = (room: Room, userKey: string): void => {
  if (!room.pendingClients.has(userKey)) return;
  room.removePendingClient(userKey);
  publishLobby(room);
};

export const admitAllPendingUsers = (
  room: Room,
):
  | { ok: true; users: Array<{ userId: string; userKey: string }> }
  | { ok: false; code: typeof DECISION_RECORD_FULL } => {
  const requests = Array.from(room.pendingClients.values());
  const outcome = admitRequests(room, requests);
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    users: requests.map((request) => ({
      userId: request.userId,
      userKey: request.userKey,
    })),
  };
};

export const rejectAllPendingUsers = (
  room: Room,
  options: { sparing?: string } = {},
): Array<{ userId: string; userKey: string }> => {
  const rejected: Array<{ userId: string; userKey: string }> = [];
  const pendingUsers = Array.from(room.pendingClients.values()).filter(
    (pending) =>
      options.sparing === undefined ||
      !room.isSamePerson(options.sparing, pending.userKey, "removal"),
  );

  for (const pending of pendingUsers) {
    room.denyWaitingRequest(pending.userKey);
    pending.socket.emit("joinRejected", { roomId: room.id });
    rejected.push({ userId: pending.userId, userKey: pending.userKey });
  }
  publishLobby(room);

  return rejected;
};

export const clearAllRaisedHands = (io: SocketIOServer, room: Room): number => {
  const count = room.handRaisedByUserId.size;
  if (count === 0) {
    return 0;
  }
  // Clients treat this snapshot as a list of per-user updates (the join-time
  // snapshot sends raised: true entries the same way), so the clear must send
  // an explicit lower for every raised hand. An empty list updates nobody:
  // hands, including admins' own, stayed visibly up.
  const loweredUsers = Array.from(room.handRaisedByUserId).map((userId) => ({
    userId,
    raised: false,
  }));
  room.handRaisedByUserId.clear();
  io.to(room.channelId).emit("handRaisedSnapshot", {
    users: loweredUsers,
    roomId: room.id,
  });
  io.to(room.channelId).emit("admin:handsCleared", {
    roomId: room.id,
    count,
  });
  return count;
};

/**
 * Deterministically remove a client from a room RIGHT NOW as part of a
 * moderation action (kick / block).
 *
 * Why this exists: a normal network drop schedules a ~15s disconnect grace
 * (Room.scheduleDisconnect / disconnectHandlers) during which the client's
 * producers keep flowing. If a host kicks/blocks that user concurrently, calling
 * `socket.disconnect(true)` on the already-dead socket is a no-op and does NOT
 * cancel the pending grace, so media would keep flowing for the full grace
 * window. Here the seat ends at once through `teardownClient`, the same
 * teardown a disconnect runs, so media, a transcript relay and everything
 * else the seat holds stop now.
 */
export const forceRemoveClientNow = (options: {
  io: SocketIOServer;
  state: SfuState;
  room: Room;
  userId: string;
  // Off when the caller removes several seats and hands the room on once,
  // after the last of them (see `removeSeats`).
  handOff?: boolean;
}): boolean => {
  const { io, state, room, userId, handOff = true } = options;
  const { removed } = teardownClient({ io, state, room, userId });
  cleanupRoom(state, room);
  if (removed && handOff) ensureHost(io, state, room);
  return removed;
};

/**
 * Ends the seat `userId` and releases everything it holds in the room: its
 * media (producers, consumers and transports, in `Room.removeClient`), its
 * app awareness, a transcript relay it controls, and what the room is told
 * (who left, the webinar's counts and feed, the video quality). Disconnect,
 * removal and leaving for another room all end a seat here. Handing the
 * room on is not part of it: the caller does that once, after its last
 * teardown (see `ensureHost`).
 */
export const teardownClient = (options: {
  io: SocketIOServer;
  state: SfuState;
  room: Room;
  userId: string;
  // Who is told the seat left: the room, or everyone in it but the leaving
  // socket when it is moving to another room.
  peers?: { emit: (event: string, payload: unknown) => unknown };
}): { removed: boolean; wasAdmin: boolean } => {
  const { io, state, room, userId } = options;
  const target = room.getClient(userId);
  // Cancel any in-flight disconnect grace so the timer cannot run again.
  room.clearPendingDisconnect(userId);
  if (!target) return { removed: false, wasAdmin: false };

  const roomChannelId = room.channelId;
  const wasAdmin = target instanceof Admin && !target.isObserver;
  const peers = options.peers ?? io.to(roomChannelId);

  // Clear awareness before removing the client so peers stop seeing its cursor.
  for (const removal of room.clearUserAwareness(userId)) {
    peers.emit("apps:awareness", {
      appId: removal.appId,
      awarenessUpdate: removal.awarenessUpdate,
    } satisfies AppsAwarenessData);
  }

  room.removeClient(userId);
  state.transcriptRelays
    .releaseSeat({ roomKey: roomChannelId, userId })
    .catch((error) => {
      Logger.warn(
        `Transcript SFU relay stop for ${userId} in room ${roomChannelId} failed: ${error}`,
      );
    });
  runDetached("Syncing the room's transcript relay", () => state.transcriptRelays.syncRoom(room));

  if (!target.isWebinarAttendee) {
    peers.emit("userLeft", { userId, roomId: room.id });
  }
  emitWebinarAttendeeCountChanged(io, state, room);
  emitWebinarFeedChanged(io, state, room);
  const quality = room.updateVideoQuality();
  if (quality) {
    peers.emit("setVideoQuality", { quality, roomId: room.id });
  }
  return { removed: true, wasAdmin };
};

/**
 * Blocks `userKey` and takes away what its guest has in the room right now:
 * the waiting entry and the seats of that key, and those of the other tabs of
 * the same guest pass. A join by any of them is refused from here on.
 */
export const blockUserKey = (
  room: Room,
  userKey: string,
  options: {
    reason: string;
    kickPresent: boolean;
    io: SocketIOServer;
    state: SfuState;
  },
): { rejectedPendingUserKeys: string[]; kickedUserIds: string[] } => {
  const userKeys = room.identitiesOfSameGuest(userKey, "removal");
  const rejectedPendingUserKeys: string[] = [];
  for (const key of userKeys) {
    const pending = room.pendingClients.get(key);
    if (!pending) continue;
    pending.socket.emit("joinRejected", { roomId: room.id });
    rejectedPendingUserKeys.push(key);
  }
  room.blockUser(userKey);
  for (const key of rejectedPendingUserKeys) {
    room.denyWaitingRequest(key);
  }
  publishLobby(room);

  const kickedUserIds = options.kickPresent
    ? removeSeats(room, seatsUnder(room, userKeys), options.reason, options)
    : [];
  if (!options.kickPresent) ensureHost(options.io, options.state, room);
  return { rejectedPendingUserKeys, kickedUserIds };
};

/**
 * Removes every seat and every waiting request under `userKeys`. This is
 * for a guest that a block has come to cover without a host action: the
 * room learned that a blocked key and these keys are one guest. The join
 * that taught the room this is the guest's, so nothing here is recorded:
 * the block is the answer, and `refuseBlockedLink` already ended the rights.
 */
export const removeBlockedGuest = (
  room: Room,
  refused: { userKeys: string[] },
  options: { io: SocketIOServer; state: SfuState },
): void => {
  const { userKeys } = refused;
  for (const userKey of userKeys) {
    const request = room.pendingClients.get(userKey);
    if (!request) continue;
    room.turnAwayBlockedRequest(userKey);
    request.socket.emit("joinRejected", { roomId: room.id });
  }
  publishLobby(room);
  removeSeats(room, seatsUnder(room, userKeys), "Blocked by host", options);
};

/**
 * A recreated room that nobody from its lost call came back for is no one's.
 * If people are in it, one of them becomes host, as when a last host leaves.
 * If people are only waiting, they are asked to try again: the first who may
 * open a room then hosts it, and the rest are waiting on that host.
 */
export const offerLapsedRoom = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
): void => {
  if (state.rooms.get(room.channelId) !== room || room.hasActiveAdmin()) return;
  if (room.getMeetingParticipantCount() > 0) {
    room.markRestored();
    ensureHost(io, state, room);
    return;
  }
  for (const pending of room.pendingClients.values()) {
    pending.socket.emit("joinApproved", { roomId: room.id });
  }
  cleanupRoom(state, room);
};

export const settleUnclaimedRoom = (
  io: SocketIOServer,
  state: SfuState,
  room: Room,
): void => {
  const unclaimed = room.awaitingOpener;
  if (state.rooms.get(room.channelId) !== room || !unclaimed) return;
  if (room.isEmpty()) {
    cleanupRoom(state, room);
    return;
  }
  room.awaitingOpener = null;
  if (unclaimed.lost && Date.now() <= unclaimed.lost.claimableUntil) {
    room.awaitRestorer({
      until: unclaimed.lost.claimableUntil,
      rosterKnown: true,
      onLapse: () => offerLapsedRoom(io, state, room),
    });
    return;
  }
  if (unclaimed.lost) room.endLostCall();
  ensureHost(io, state, room);
};

export const kickClient = (
  room: Room,
  userId: string,
  reason = "Removed by host",
  options?: { io?: SocketIOServer; state?: SfuState },
): string[] => {
  const target = room.getClient(userId);
  if (!target || isSuperAdminClient(target)) {
    return [];
  }
  // A removed user has to be let in again, or they could rejoin at once,
  // still admitted and still a host.
  const userKey = room.userKeysById.get(userId);
  if (!userKey) return removeSeats(room, [userId], reason, options);
  const seats = room.seatsOfSameGuest(userKey, "removal");
  room.removeUser(userKey);
  return removeSeats(room, seats, reason, options);
};

const seatsUnder = (room: Room, userKeys: readonly string[]): string[] =>
  Array.from(room.userKeysById.entries())
    .filter(([, userKey]) => userKeys.includes(userKey))
    .map(([userId]) => userId);

/**
 * Removes the seats `userIds` as one operation. The caller has already
 * ended what their guests may do: it dropped their rights or blocked them.
 * Every seat goes first, and only then is the room handed on, once, to a
 * seat whose guest is neither blocked nor one of the guests removed here.
 * Handing it on between two removals could make the guest's next tab a
 * host, and that right would outlive the removal. Returns the seats it
 * removed.
 */
const removeSeats = (
  room: Room,
  userIds: readonly string[],
  reason: string,
  options?: { io?: SocketIOServer; state?: SfuState },
): string[] => {
  const targets = userIds.filter((userId) => {
    const target = room.getClient(userId);
    return target !== undefined && !isSuperAdminClient(target);
  });
  for (const userId of targets) {
    const target = room.getClient(userId);
    if (!target) continue;
    target.socket.emit("kicked", { reason, roomId: room.id });
    // The seat leaves the room before its socket is closed. Socket.IO runs
    // the disconnect handler inside `disconnect`, and that handler hands the
    // room on by itself, to anyone, if it still finds the seat; here it
    // finds none. Stopping media now also keeps a network drop's grace
    // period from keeping producers flowing.
    if (options?.io && options.state) {
      forceRemoveClientNow({
        io: options.io,
        state: options.state,
        room,
        userId,
        handOff: false,
      });
    }
    target.socket.disconnect(true);
  }
  if (options?.io && options.state) ensureHost(options.io, options.state, room);
  return targets;
};

export const closeProducerForMediaKey = (options: {
  io: SocketIOServer;
  state: SfuState;
  room: Room;
  userId: string;
  mediaKey: ProducerKey;
  reason: string;
}): {
  closed: boolean;
  producerId?: string;
} => {
  const { io, state, room, userId, mediaKey, reason } = options;
  const [kind, type] = mediaKey.split("-") as [MediaKind, ProducerType];
  const target = room.getClient(userId);
  if (!target) {
    return { closed: false };
  }
  const producer = target.getProducer(kind, type);
  if (!producer) {
    return { closed: false };
  }
  const producerId = producer.id;
  const removed = target.removeProducerById(producerId);
  if (!removed) {
    return { closed: false };
  }
  room.removeProducerIndexById(producerId);
  if (kind === "video" && type === "screen") {
    room.clearScreenShareProducer(producerId);
  }
  notifyProducerClosed(io, room, userId, producerId);
  emitWebinarFeedChanged(io, state, room);
  target.socket.emit("admin:mediaEnforced", {
    roomId: room.id,
    userId,
    producerId,
    kind,
    type,
    action: "closed",
    reason,
  });
  return { closed: true, producerId };
};

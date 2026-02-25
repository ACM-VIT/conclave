import type { MediaKind, Worker } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
import { Admin } from "../../config/classes/Admin.js";
import type {
  Client,
  ProducerKey,
  ProducerType,
} from "../../config/classes/Client.js";
import type { Room } from "../../config/classes/Room.js";
import { getRoomChannelId } from "../rooms.js";
import type { SfuState } from "../state.js";
import { emitWebinarFeedChanged } from "../webinarNotifications.js";

type ParticipantRole = "host" | "admin" | "participant" | "ghost" | "attendee";

export type ParticipantSnapshot = {
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
    ghosts: number;
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
};

type ProducerInfo = ReturnType<Client["getProducerInfos"]>[number];

const toParticipantRole = (room: Room, client: Client): ParticipantRole => {
  if (client.isWebinarAttendee) return "attendee";
  if (client.isGhost) return "ghost";
  if (!(client instanceof Admin)) return "participant";
  const hostUserId = room.getHostUserId();
  return hostUserId === client.id ? "host" : "admin";
};

const toDisplayName = (room: Room, userId: string): string => {
  return room.getDisplayNameForUser(userId) || userId;
};

export const toParticipantSnapshot = (
  room: Room,
  client: Client,
): ParticipantSnapshot => {
  const producers = client.getProducerInfos();
  return {
    userId: client.id,
    userKey: room.userKeysById.get(client.id) ?? null,
    displayName: toDisplayName(room, client.id),
    role: toParticipantRole(room, client),
    mode: client.mode,
    socketId: client.socket.id,
    muted: client.isMuted,
    cameraOff: client.isCameraOff,
    producerTransportConnected: Boolean(client.producerTransport),
    consumerTransportConnected: Boolean(client.consumerTransport),
    pendingDisconnect: room.hasPendingDisconnect(client.id),
    producers,
    consumerCount: client.consumers.size,
  };
};

export const toPendingUserSnapshots = (room: Room): PendingUserSnapshot[] => {
  return Array.from(room.pendingClients.values()).map((pending) => ({
    userId: pending.userKey,
    participantUserId: pending.userId,
    userKey: pending.userKey,
    displayName: pending.displayName || pending.userKey,
    socketId: pending.socket?.id ?? null,
  }));
};

export const toRoomSnapshot = (room: Room): RoomSnapshot => {
  const participants = Array.from(room.clients.values()).map((client) =>
    toParticipantSnapshot(room, client),
  );
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
  const ghosts = participants.filter((participant) => participant.role === "ghost")
    .length;
  const attendees = participants.filter(
    (participant) => participant.role === "attendee",
  ).length;
  const guests = participants.filter((participant) => {
    const key = participant.userKey;
    if (!key) return false;
    return key.startsWith("guest:");
  }).length;

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
      requiresMeetingInviteCode: room.requiresMeetingInviteCode,
    },
    access: {
      allowedUserKeys: Array.from(room.allowedUsers.values()).sort(),
      lockedAllowedUserKeys: Array.from(room.lockedAllowedUsers.values()).sort(),
      blockedUserKeys: Array.from(room.blockedUsers.values()).sort(),
    },
    counts: {
      participants: room.clients.size,
      activeParticipants: room.getMeetingParticipantCount(),
      admins: adminCount,
      guests,
      ghosts,
      webinarAttendees: attendees,
      pendingUsers: room.pendingClients.size,
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
        participantCount: room.clients.size,
        pendingUserCount: room.pendingClients.size,
        adminCount: room.getAdmins().length,
      };
    })
    .sort((a, b) => b.participantCount - a.participantCount)
    .slice(0, 10);

  const participants = rooms.reduce((sum, room) => sum + room.clients.size, 0);
  const pendingUsers = rooms.reduce(
    (sum, room) => sum + room.pendingClients.size,
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
  for (const client of room.clients.values()) {
    const removed = client.removeProducerById(producerId);
    if (!removed) {
      continue;
    }

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
  }

  return { closed: false };
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

  for (const info of infos) {
    const removed = target.removeProducerById(info.producerId);
    if (!removed) continue;

    if (removed.kind === "video" && removed.type === "screen") {
      room.clearScreenShareProducer(info.producerId);
    }

    notifyProducerClosed(io, room, userId, info.producerId);
    closedProducers.push({
      producerId: info.producerId,
      kind: removed.kind,
      type: removed.type,
    });
  }

  if (closedProducers.length > 0) {
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
  room: Room,
  update: RoomPolicyUpdate,
): { changed: RoomPolicyUpdate } => {
  const changed: RoomPolicyUpdate = {};

  if (typeof update.locked === "boolean" && update.locked !== room.isLocked) {
    room.setLocked(update.locked);
    if (update.locked) {
      for (const userKey of room.userKeysById.values()) {
        room.allowLockedUser(userKey);
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

  return { changed };
};

export const admitAllPendingUsers = (
  room: Room,
): Array<{ userId: string; userKey: string }> => {
  const admitted: Array<{ userId: string; userKey: string }> = [];
  const pendingUsers = Array.from(room.pendingClients.values());

  for (const pending of pendingUsers) {
    if (room.isLocked) {
      room.allowLockedUser(pending.userKey);
    }
    room.allowUser(pending.userKey);
    pending.socket.emit("joinApproved");
    admitted.push({ userId: pending.userId, userKey: pending.userKey });
  }

  for (const admin of room.getAdmins()) {
    for (const user of admitted) {
      admin.socket.emit("userAdmitted", {
        userId: user.userKey,
        roomId: room.id,
      });
    }
  }

  return admitted;
};

export const rejectAllPendingUsers = (
  room: Room,
): Array<{ userId: string; userKey: string }> => {
  const rejected: Array<{ userId: string; userKey: string }> = [];
  const pendingUsers = Array.from(room.pendingClients.values());

  for (const pending of pendingUsers) {
    room.removePendingClient(pending.userKey);
    pending.socket.emit("joinRejected");
    rejected.push({ userId: pending.userId, userKey: pending.userKey });
  }

  for (const admin of room.getAdmins()) {
    for (const user of rejected) {
      admin.socket.emit("userRejected", {
        userId: user.userKey,
        roomId: room.id,
      });
    }
  }

  return rejected;
};

export const clearAllRaisedHands = (io: SocketIOServer, room: Room): number => {
  const count = room.handRaisedByUserId.size;
  if (count === 0) {
    return 0;
  }
  room.handRaisedByUserId.clear();
  io.to(room.channelId).emit("handRaisedSnapshot", {
    users: [],
    roomId: room.id,
  });
  io.to(room.channelId).emit("admin:handsCleared", {
    roomId: room.id,
    count,
  });
  return count;
};

export const kickClient = (
  room: Room,
  userId: string,
  reason = "Removed by host",
): boolean => {
  const target = room.getClient(userId);
  if (!target) {
    return false;
  }
  target.socket.emit("kicked", { reason, roomId: room.id });
  target.socket.disconnect(true);
  return true;
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

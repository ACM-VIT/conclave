import type { MediaKind } from "mediasoup/types";
import { Admin } from "../../../config/classes/Admin.js";
import type { ProducerType } from "../../../config/classes/Client.js";
import type { RedirectData } from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import {
  admitAllPendingUsers,
  applyRoomPolicyUpdate,
  clearAllRaisedHands,
  closeClientProducers,
  closeProducerById,
  closeProducerForMediaKey,
  forceRemoveClientNow,
  kickClient,
  rejectAllPendingUsers,
  toPendingUserSnapshots,
  toRoomSnapshot,
} from "../../admin/controlPlane.js";
import { forceCloseRoom, markRoomEnded } from "../../rooms.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";
import { emitChatHistorySnapshot } from "./chatHistory.js";

const DEFAULT_END_ROOM_MESSAGE =
  "This meeting has been ended by the host.";
const MAX_END_ROOM_DELAY_MS = 30000;
const MAX_USER_KEY_LENGTH = 256;
const MAX_USER_ID_LENGTH = 512;
const MAX_BULK_USER_KEYS = 100;
const MAX_ADMIN_REASON_LENGTH = 256;
const MAX_ADMIN_NOTICE_LENGTH = 2000;
const MAX_ROOM_ID_LENGTH = 256;
const MAX_PRODUCER_ID_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizePlainText = (
  value: unknown,
  options: { maxLength: number; fallback?: string },
): string => {
  const raw = typeof value === "string" ? value.trim() : "";
  const text = raw || options.fallback || "";
  return text.slice(0, options.maxLength);
};

const normalizeRoomId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const roomId = value.trim();
  if (
    !roomId ||
    roomId.length > MAX_ROOM_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(roomId)
  ) {
    return null;
  }
  return roomId;
};

const normalizeUserKey = (value: string): string | null => {
  const userKey = value.trim();
  if (
    !userKey ||
    userKey.length > MAX_USER_KEY_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(userKey)
  ) {
    return null;
  }
  return userKey;
};

const normalizeUserId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const userId = value.trim();
  if (
    !userId ||
    userId.length > MAX_USER_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(userId)
  ) {
    return null;
  }
  return userId;
};

const normalizeProducerId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const producerId = value.trim();
  if (
    !producerId ||
    producerId.length > MAX_PRODUCER_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(producerId)
  ) {
    return null;
  }
  return producerId;
};

const resolveClientId = (context: ConnectionContext): string => {
  const raw = context.socket.data.user?.clientId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "default";
};

const ensureAdminRoom = (
  context: ConnectionContext,
  options: { bulk?: boolean } = {},
):
  | {
      room: NonNullable<ConnectionContext["currentRoom"]>;
      adminId: string;
    }
  | { error: string } => {
  const room = context.currentRoom;
  const currentClient = context.currentClient;

  if (!room || !currentClient) {
    return { error: "Room not found" };
  }

  if (!(currentClient instanceof Admin) || currentClient.isObserver) {
    return { error: "Admin privileges required" };
  }

  const limit = options.bulk
    ? RATE_LIMITS.adminBulkAction
    : RATE_LIMITS.adminAction;
  const limitKey = options.bulk ? "admin:bulk" : "admin:action";
  if (!takeToken(context.socket, limitKey, limit)) {
    return { error: "Too many admin requests; please retry shortly" };
  }

  return { room, adminId: currentClient.id };
};

const toBulkMediaOptions = (
  value: unknown,
): {
  includeAdmins: boolean;
  includeAttendees: boolean;
} => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      includeAdmins: false,
      includeAttendees: false,
    };
  }

  const data = value as {
    includeAdmins?: unknown;
    includeAttendees?: unknown;
  };

  return {
    includeAdmins: data.includeAdmins === true,
    includeAttendees: data.includeAttendees === true,
  };
};

const parseKinds = (value: unknown): MediaKind[] | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return undefined;
  }

  const next: MediaKind[] = [];
  for (const entry of value) {
    if (entry === "audio" || entry === "video") {
      next.push(entry);
      continue;
    }
    return null;
  }

  return next;
};

const parseTypes = (value: unknown): ProducerType[] | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return undefined;
  }

  const next: ProducerType[] = [];
  for (const entry of value) {
    if (entry === "webcam" || entry === "screen") {
      next.push(entry);
      continue;
    }
    return null;
  }

  return next;
};

const parseUserKeys = (value: unknown): string[] | null => {
  if (typeof value === "string") {
    const normalized = normalizeUserKey(value);
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length > MAX_BULK_USER_KEYS) {
    return null;
  }

  const userKeys: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const normalized = normalizeUserKey(entry);
    if (!normalized) {
      return null;
    }
    userKeys.push(normalized);
  }

  return Array.from(new Set(userKeys));
};

const parseEndRoomDelay = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_END_ROOM_DELAY_MS);
};

const parseEndRoomMessage = (value: unknown): string => {
  return normalizePlainText(value, {
    maxLength: MAX_ADMIN_NOTICE_LENGTH,
    fallback: DEFAULT_END_ROOM_MESSAGE,
  });
};

const performBulkMediaClosure = (options: {
  context: ConnectionContext;
  selector: {
    kinds?: MediaKind[];
    types?: ProducerType[];
  };
  reason: string;
  includeAdmins?: boolean;
  includeAttendees?: boolean;
}): {
  affectedUsers: number;
  affectedProducers: number;
  users: string[];
} => {
  const room = options.context.currentRoom;
  if (!room) {
    return { affectedUsers: 0, affectedProducers: 0, users: [] };
  }

  let affectedUsers = 0;
  let affectedProducers = 0;
  const users: string[] = [];

  for (const client of room.clients.values()) {
    if (!options.includeAdmins && client instanceof Admin) {
      continue;
    }
    if (client.isGhost) {
      continue;
    }
    if (!options.includeAttendees && client.isWebinarAttendee) {
      continue;
    }

    const result = closeClientProducers({
      io: options.context.io,
      state: options.context.state,
      room,
      userId: client.id,
      selector: options.selector,
      reason: options.reason,
    });

    if (result.closedCount > 0) {
      affectedUsers += 1;
      affectedProducers += result.closedCount;
      users.push(client.id);
    }
  }

  if (affectedProducers > 0) {
    options.context.io.to(room.channelId).emit("admin:bulkMediaEnforced", {
      roomId: room.id,
      reason: options.reason,
      users,
      affectedUsers,
      affectedProducers,
    });
  }

  return { affectedUsers, affectedProducers, users };
};

const activatePromotedAdmin = (
  context: ConnectionContext,
  promoted: Admin,
  roomId: string,
): void => {
  const promotedContext = promoted.socket.data?.context as
    | ConnectionContext
    | undefined;

  if (!promotedContext || !context.currentRoom) {
    return;
  }

  promotedContext.currentClient = promoted;
  promotedContext.currentRoom = context.currentRoom;
  registerAdminHandlers(promotedContext, { roomId });

  promoted.socket.emit("pendingUsersSnapshot", {
    users: toPendingUserSnapshots(context.currentRoom),
    roomId,
  });
  emitChatHistorySnapshot(promoted.socket, context.currentRoom);

  promoted.socket.emit("admin:roomStateChanged", {
    roomId,
    snapshot: toRoomSnapshot(context.currentRoom),
  });
};

export const registerAdminHandlers = (
  context: ConnectionContext,
  options: { roomId: string },
): void => {
  const { socket, io, state } = context;

  // Idempotent per socket. joinRoom (incl. the in-place room-switch path) and
  // both host-promotion paths can each invoke this on the SAME live socket;
  // binding twice would stack duplicate socket.on listeners so every admin
  // action (kick / end-room / promote) fires N times and listeners leak. The
  // single bound set always acts on the CURRENT room; the handlers resolve it
  // live from the (per-socket, mutated-in-place) context via ensureAdminRoom.
  if (context.adminHandlersRegistered) {
    return;
  }
  context.adminHandlersRegistered = true;

  socket.on("kickUser", ({ userId: targetId }: { userId: string }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    const normalizedTargetId = normalizeUserId(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }
    if (normalizedTargetId === guard.adminId) {
      respond(cb, { error: "Cannot kick yourself" });
      return;
    }

    const kicked = kickClient(guard.room, normalizedTargetId, "Removed by host", {
      io,
      state,
    });
    if (!kicked) {
      respond(cb, { error: "User not found" });
      return;
    }

    Logger.info(`Admin ${guard.adminId} kicked ${normalizedTargetId} in room ${guard.room.id}`);
    respond(cb, { success: true });
  });

  socket.on("closeRemoteProducer", ({ producerId }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const normalizedProducerId = normalizeProducerId(producerId);
    if (!normalizedProducerId) {
      respond(cb, { error: "Invalid producer ID" });
      return;
    }

    const result = closeProducerById(io, state, guard.room, normalizedProducerId);
    if (!result.closed) {
      respond(cb, { error: "Producer not found" });
      return;
    }

    respond(cb, {
      success: true,
      userId: result.userId,
      kind: result.kind,
      type: result.type,
    });
  });

  socket.on(
    "admin:closeUserMedia",
    (
      data: {
        userId: string;
        kinds?: MediaKind[];
        types?: ProducerType[];
        reason?: string;
      },
      cb,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(cb, guard);
        return;
      }

      const targetId = normalizeUserId(data?.userId);
      if (!targetId) {
        respond(cb, { error: "Invalid user ID" });
        return;
      }

      const kinds = parseKinds(data?.kinds);
      if (kinds === null) {
        respond(cb, { error: "Invalid media kinds" });
        return;
      }

      const types = parseTypes(data?.types);
      if (types === null) {
        respond(cb, { error: "Invalid media types" });
        return;
      }

      const reason =
        typeof data?.reason === "string" && data.reason.trim()
          ? normalizePlainText(data.reason, {
              maxLength: MAX_ADMIN_REASON_LENGTH,
              fallback: "Host moderation action",
            })
          : "Host moderation action";

      const result = closeClientProducers({
        io,
        state,
        room: guard.room,
        userId: targetId,
        selector: {
          kinds,
          types,
        },
        reason,
      });

      respond(cb, {
        success: true,
        userId: targetId,
        affectedProducers: result.closedCount,
        producers: result.closedProducers,
      });
    },
  );

  socket.on("admin:muteUser", ({ userId: targetId }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const normalizedTargetId = normalizeUserId(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }

    const result = closeClientProducers({
      io,
      state,
      room: guard.room,
      userId: normalizedTargetId,
      selector: { kinds: ["audio"] },
      reason: "Muted by host",
    });

    respond(cb, {
      success: true,
      userId: normalizedTargetId,
      affectedProducers: result.closedCount,
      producers: result.closedProducers,
    });
  });

  socket.on("admin:closeUserVideo", ({ userId: targetId }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const normalizedTargetId = normalizeUserId(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }

    const result = closeClientProducers({
      io,
      state,
      room: guard.room,
      userId: normalizedTargetId,
      selector: { kinds: ["video"], types: ["webcam"] },
      reason: "Camera turned off by host",
    });

    respond(cb, {
      success: true,
      userId: normalizedTargetId,
      affectedProducers: result.closedCount,
      producers: result.closedProducers,
    });
  });

  socket.on("admin:stopUserScreenShare", ({ userId: targetId }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const normalizedTargetId = normalizeUserId(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }

    const result = closeClientProducers({
      io,
      state,
      room: guard.room,
      userId: normalizedTargetId,
      selector: { types: ["screen"] },
      reason: "Screen share stopped by host",
    });

    respond(cb, {
      success: true,
      userId: normalizedTargetId,
      affectedProducers: result.closedCount,
      producers: result.closedProducers,
    });
  });

  socket.on("muteAll", (input: unknown, maybeCb?: (data: unknown) => void) => {
    const callback = typeof input === "function" ? input : maybeCb;
    const data = typeof input === "function" ? {} : input;
    if (!callback) return;

    const guard = ensureAdminRoom(context, { bulk: true });
    if ("error" in guard) {
      respond(callback, guard);
      return;
    }

    const bulkOptions = toBulkMediaOptions(data);
    const result = performBulkMediaClosure({
      context,
      selector: { kinds: ["audio"] },
      reason: "Muted by host",
      includeAdmins: bulkOptions.includeAdmins,
      includeAttendees: bulkOptions.includeAttendees,
    });

    respond(callback, {
      success: true,
      count: result.affectedUsers,
      affectedProducers: result.affectedProducers,
      users: result.users,
    });
  });

  socket.on("closeAllVideo", (input: unknown, maybeCb?: (data: unknown) => void) => {
    const callback = typeof input === "function" ? input : maybeCb;
    const data = typeof input === "function" ? {} : input;
    if (!callback) return;

    const guard = ensureAdminRoom(context, { bulk: true });
    if ("error" in guard) {
      respond(callback, guard);
      return;
    }

    const bulkOptions = toBulkMediaOptions(data);
    const result = performBulkMediaClosure({
      context,
      selector: { kinds: ["video"], types: ["webcam"] },
      reason: "Camera turned off by host",
      includeAdmins: bulkOptions.includeAdmins,
      includeAttendees: bulkOptions.includeAttendees,
    });

    respond(callback, {
      success: true,
      count: result.affectedUsers,
      affectedProducers: result.affectedProducers,
      users: result.users,
    });
  });

  socket.on("admin:stopAllScreenShare", (input: unknown, maybeCb?: (data: unknown) => void) => {
    const callback = typeof input === "function" ? input : maybeCb;
    const data = typeof input === "function" ? {} : input;
    if (!callback) return;

    const guard = ensureAdminRoom(context, { bulk: true });
    if ("error" in guard) {
      respond(callback, guard);
      return;
    }

    const bulkOptions = toBulkMediaOptions(data);
    const result = performBulkMediaClosure({
      context,
      selector: { types: ["screen"] },
      reason: "Screen share stopped by host",
      includeAdmins: bulkOptions.includeAdmins,
      includeAttendees: bulkOptions.includeAttendees,
    });

    respond(callback, {
      success: true,
      count: result.affectedUsers,
      affectedProducers: result.affectedProducers,
      users: result.users,
    });
  });

  socket.on("promoteHost", ({ userId: targetId }: { userId: string }, cb) => {
    if (!takeToken(socket, "admin:action", RATE_LIMITS.adminAction)) {
      respond(cb, { error: "Too many admin requests; please retry shortly" });
      return;
    }
    if (!context.currentRoom || !context.currentClient) {
      respond(cb, { error: "Room not found" });
      return;
    }

    const currentRoom = context.currentRoom;
    const isActiveAdmin =
      context.currentClient instanceof Admin && !context.currentClient.isObserver;
    if (!isActiveAdmin) {
      respond(cb, { error: "Only hosts can promote another host." });
      return;
    }

    const normalizedTargetId = normalizeUserId(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }

    const targetClient = currentRoom.getClient(normalizedTargetId);
    if (!targetClient) {
      respond(cb, { error: "User not found" });
      return;
    }
    if (targetClient.isGhost || targetClient.isWebinarAttendee) {
      respond(cb, { error: "User cannot be promoted to host." });
      return;
    }

    const targetUserKey = currentRoom.userKeysById.get(normalizedTargetId);
    if (!targetUserKey) {
      respond(cb, { error: "User identity not found" });
      return;
    }

    const alreadyAdmin = targetClient instanceof Admin;
    const promoted = currentRoom.promoteClientToAdmin(normalizedTargetId);
    if (!promoted) {
      respond(cb, { error: "Failed to promote user" });
      return;
    }

    if (!alreadyAdmin) {
      activatePromotedAdmin(context, promoted, currentRoom.id);
    }

    promoted.socket.emit("hostAssigned", {
      roomId: currentRoom.id,
      hostUserId: currentRoom.getHostUserId() ?? promoted.id,
    });

    context.io.to(currentRoom.channelId).emit("adminUsersChanged", {
      roomId: currentRoom.id,
      hostUserIds: currentRoom.getAdminUserIds(),
    });

    Logger.info(
      `Host privileges granted in room ${currentRoom.id}: ${context.currentClient.id} -> ${promoted.id}`,
    );
    respond(cb, {
      success: true,
      hostUserId: currentRoom.getHostUserId() ?? null,
      hostUserIds: currentRoom.getAdminUserIds(),
      promotedUserId: promoted.id,
      promotedUserKey: targetUserKey,
    });
  });

  socket.on("admin:transferHost", ({ userId: targetId }: { userId: string }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const currentRoom = guard.room;
    const normalizedTargetId = normalizeUserId(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }
    const targetClient = currentRoom.getClient(normalizedTargetId);
    if (!targetClient) {
      respond(cb, { error: "User not found" });
      return;
    }
    if (targetClient.isGhost || targetClient.isWebinarAttendee) {
      respond(cb, { error: "User cannot become host" });
      return;
    }

    const targetUserKey = currentRoom.userKeysById.get(normalizedTargetId);
    if (!targetUserKey) {
      respond(cb, { error: "User identity not found" });
      return;
    }

    const alreadyAdmin = targetClient instanceof Admin;
    const promoted = currentRoom.promoteClientToAdmin(normalizedTargetId);
    if (!promoted) {
      respond(cb, { error: "Failed to promote user" });
      return;
    }

    currentRoom.hostUserKey = targetUserKey;

    if (!alreadyAdmin) {
      activatePromotedAdmin(context, promoted, currentRoom.id);
    }

    io.to(currentRoom.channelId).emit("hostChanged", {
      roomId: currentRoom.id,
      hostUserId: currentRoom.getHostUserId(),
    });
    io.to(currentRoom.channelId).emit("adminUsersChanged", {
      roomId: currentRoom.id,
      hostUserIds: currentRoom.getAdminUserIds(),
    });

    promoted.socket.emit("hostAssigned", {
      roomId: currentRoom.id,
      hostUserId: promoted.id,
    });

    respond(cb, {
      success: true,
      hostUserId: currentRoom.getHostUserId(),
      hostUserIds: currentRoom.getAdminUserIds(),
      transferredTo: promoted.id,
    });
  });

  socket.on("getRooms", (cb) => {
    const clientId = resolveClientId(context);
    const roomList = Array.from(state.rooms.values())
      .filter((room) => room.clientId === clientId)
      .map((room) => ({
        id: room.id,
        userCount:
          room.getMeetingParticipantCount() + room.getWebinarAttendeeCount(),
      }));
    respond(cb, { rooms: roomList });
  });

  socket.on("admin:getRoomsDetailed", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const clientId = guard.room.clientId;
    const rooms = Array.from(state.rooms.values())
      .filter((room) => room.clientId === clientId)
      .map((room) => toRoomSnapshot(room));
    respond(cb, { rooms });
  });

  socket.on("admin:getRoomState", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    respond(cb, { room: toRoomSnapshot(guard.room) });
  });

  socket.on("admin:getParticipants", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    respond(cb, {
      participants: toRoomSnapshot(guard.room).participants,
      roomId: guard.room.id,
    });
  });

  socket.on("admin:getPendingUsers", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    respond(cb, {
      roomId: guard.room.id,
      users: toPendingUserSnapshots(guard.room),
    });
  });

  socket.on("admin:getAccessLists", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    respond(cb, {
      roomId: guard.room.id,
      access: toRoomSnapshot(guard.room).access,
    });
  });

  socket.on(
    "admin:allowUsers",
    (
      data: {
        userKeys?: string[] | string;
        allowWhenLocked?: boolean;
      },
      cb,
    ) => {
      const guard = ensureAdminRoom(context, { bulk: true });
      if ("error" in guard) {
        respond(cb, guard);
        return;
      }

      const userKeys = parseUserKeys(data?.userKeys);
      if (userKeys === null) {
        respond(cb, { error: "Invalid user key list" });
        return;
      }
      if (userKeys.length === 0) {
        respond(cb, { error: "At least one user key is required" });
        return;
      }

      const allowWhenLocked = data?.allowWhenLocked !== false;
      const admitted: string[] = [];
      for (const userKey of userKeys) {
        const pending = guard.room.pendingClients.get(userKey);
        guard.room.unblockUser(userKey);
        guard.room.allowUser(userKey);
        if (allowWhenLocked || guard.room.isLocked) {
          guard.room.allowLockedUser(userKey);
        }
        if (pending) {
          pending.socket.emit("joinApproved", { roomId: guard.room.id });
          admitted.push(userKey);
          for (const admin of guard.room.getAdmins()) {
            admin.socket.emit("userAdmitted", {
              userId: userKey,
              roomId: guard.room.id,
            });
          }
        }
      }

      io.to(guard.room.channelId).emit("pendingUsersSnapshot", {
        users: toPendingUserSnapshots(guard.room),
        roomId: guard.room.id,
      });

      respond(cb, {
        success: true,
        allowed: userKeys,
        admitted,
        access: toRoomSnapshot(guard.room).access,
      });
    },
  );

  socket.on(
    "admin:blockUsers",
    (
      data: {
        userKeys?: string[] | string;
        kickPresent?: boolean;
        reason?: string;
      },
      cb,
    ) => {
      const guard = ensureAdminRoom(context, { bulk: true });
      if ("error" in guard) {
        respond(cb, guard);
        return;
      }

      const userKeys = parseUserKeys(data?.userKeys);
      if (userKeys === null) {
        respond(cb, { error: "Invalid user key list" });
        return;
      }
      if (userKeys.length === 0) {
        respond(cb, { error: "At least one user key is required" });
        return;
      }

      const kickPresent = data?.kickPresent !== false;
      const reason =
        typeof data?.reason === "string" && data.reason.trim()
          ? normalizePlainText(data.reason, {
              maxLength: MAX_ADMIN_REASON_LENGTH,
              fallback: "Blocked by host",
            })
          : "Blocked by host";
      const kickedUserIds = new Set<string>();
      const rejectedPending: string[] = [];

      for (const userKey of userKeys) {
        const pending = guard.room.pendingClients.get(userKey);
        guard.room.blockUser(userKey);

        if (pending) {
          pending.socket.emit("joinRejected", { roomId: guard.room.id });
          rejectedPending.push(userKey);
          for (const admin of guard.room.getAdmins()) {
            admin.socket.emit("userRejected", {
              userId: userKey,
              roomId: guard.room.id,
            });
          }
        }

        if (kickPresent) {
          for (const [userId, key] of [
            ...guard.room.userKeysById.entries(),
          ]) {
            if (key !== userKey) continue;
            const target = guard.room.getClient(userId);
            if (!target) continue;
            target.socket.emit("kicked", { reason, roomId: guard.room.id });
            target.socket.disconnect(true);
            // Deterministically stop media now (cancel any disconnect grace).
            forceRemoveClientNow({ io, state, room: guard.room, userId });
            kickedUserIds.add(userId);
          }
        }
      }

      io.to(guard.room.channelId).emit("pendingUsersSnapshot", {
        users: toPendingUserSnapshots(guard.room),
        roomId: guard.room.id,
      });

      respond(cb, {
        success: true,
        blocked: userKeys,
        rejectedPending,
        kickedUserIds: Array.from(kickedUserIds.values()),
        access: toRoomSnapshot(guard.room).access,
      });
    },
  );

  socket.on(
    "admin:unblockUsers",
    (
      data: {
        userKeys?: string[] | string;
      },
      cb,
    ) => {
      const guard = ensureAdminRoom(context, { bulk: true });
      if ("error" in guard) {
        respond(cb, guard);
        return;
      }

      const userKeys = parseUserKeys(data?.userKeys);
      if (userKeys === null) {
        respond(cb, { error: "Invalid user key list" });
        return;
      }
      if (userKeys.length === 0) {
        respond(cb, { error: "At least one user key is required" });
        return;
      }

      for (const userKey of userKeys) {
        guard.room.unblockUser(userKey);
      }

      respond(cb, {
        success: true,
        unblocked: userKeys,
        access: toRoomSnapshot(guard.room).access,
      });
    },
  );

  socket.on(
    "admin:revokeAllowedUsers",
    (
      data: {
        userKeys?: string[] | string;
        revokeLocked?: boolean;
      },
      cb,
    ) => {
      const guard = ensureAdminRoom(context, { bulk: true });
      if ("error" in guard) {
        respond(cb, guard);
        return;
      }

      const userKeys = parseUserKeys(data?.userKeys);
      if (userKeys === null) {
        respond(cb, { error: "Invalid user key list" });
        return;
      }
      if (userKeys.length === 0) {
        respond(cb, { error: "At least one user key is required" });
        return;
      }

      const revokeLocked = data?.revokeLocked !== false;
      for (const userKey of userKeys) {
        guard.room.revokeAllowedUser(userKey);
        if (revokeLocked) {
          guard.room.revokeLockedAllowedUser(userKey);
        }
      }

      respond(cb, {
        success: true,
        revoked: userKeys,
        access: toRoomSnapshot(guard.room).access,
      });
    },
  );

  socket.on(
    "redirectUser",
    ({ userId: targetId, newRoomId }: RedirectData, cb) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(cb, guard);
        return;
      }

      const normalizedTargetId = normalizeUserId(targetId);
      const normalizedRoomId = normalizeRoomId(newRoomId);
      if (!normalizedTargetId) {
        respond(cb, { error: "Invalid user ID" });
        return;
      }
      if (!normalizedRoomId) {
        respond(cb, { error: "Invalid target room ID" });
        return;
      }
      const targetClient = guard.room.getClient(normalizedTargetId);
      if (targetClient) {
        Logger.info(`Admin redirecting user ${targetClient.id} to ${normalizedRoomId}`);
        targetClient.socket.emit("redirect", {
          roomId: guard.room.id,
          userId: targetClient.id,
          newRoomId: normalizedRoomId,
        });
        respond(cb, { success: true });
      } else {
        respond(cb, { error: "User not found" });
      }
    },
  );

  socket.on("admitUser", ({ userId: targetId }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const normalizedTargetId = normalizeUserKey(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }

    const pending = guard.room.pendingClients.get(normalizedTargetId);
    if (pending) {
      Logger.info(`Admin admitted user ${pending.userKey} to room ${options.roomId}`);
      if (guard.room.isLocked) {
        guard.room.allowLockedUser(pending.userKey);
      }
      guard.room.allowUser(pending.userKey);
      pending.socket.emit("joinApproved", { roomId: guard.room.id });

      for (const admin of guard.room.getAdmins()) {
        admin.socket.emit("userAdmitted", {
          userId: pending.userKey,
          roomId: guard.room.id,
        });
      }

      respond(cb, { success: true });
    } else {
      respond(cb, { error: "User not found in waiting room" });
    }
  });

  socket.on("rejectUser", ({ userId: targetId }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const normalizedTargetId = normalizeUserKey(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }

    const pending = guard.room.pendingClients.get(normalizedTargetId);
    if (pending) {
      Logger.info(
        `Admin rejected user ${pending.userKey} from room ${options.roomId}`,
      );
      guard.room.removePendingClient(pending.userKey);
      pending.socket.emit("joinRejected", { roomId: guard.room.id });

      for (const admin of guard.room.getAdmins()) {
        admin.socket.emit("userRejected", {
          userId: pending.userKey,
          roomId: guard.room.id,
        });
      }

      respond(cb, { success: true });
    } else {
      respond(cb, { error: "User not found in waiting room" });
    }
  });

  socket.on("admin:admitAllPending", (cb) => {
    const guard = ensureAdminRoom(context, { bulk: true });
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const admitted = admitAllPendingUsers(guard.room);
    io.to(guard.room.channelId).emit("pendingUsersSnapshot", {
      users: toPendingUserSnapshots(guard.room),
      roomId: guard.room.id,
    });

    respond(cb, {
      success: true,
      admittedCount: admitted.length,
      users: admitted,
    });
  });

  socket.on("admin:rejectAllPending", (cb) => {
    const guard = ensureAdminRoom(context, { bulk: true });
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const rejected = rejectAllPendingUsers(guard.room);
    io.to(guard.room.channelId).emit("pendingUsersSnapshot", {
      users: toPendingUserSnapshots(guard.room),
      roomId: guard.room.id,
    });

    respond(cb, {
      success: true,
      rejectedCount: rejected.length,
      users: rejected,
    });
  });

  socket.on("lockRoom", ({ locked }: { locked: boolean }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const update = applyRoomPolicyUpdate(io, guard.room, { locked });
    Logger.info(`Room ${guard.room.id} ${locked ? "locked" : "unlocked"} by admin`);

    respond(cb, {
      success: true,
      locked: guard.room.isLocked,
      changed: update.changed,
    });
  });

  socket.on("setNoGuests", ({ noGuests }: { noGuests: boolean }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const update = applyRoomPolicyUpdate(io, guard.room, { noGuests });
    Logger.info(
      `Room ${guard.room.id} ${noGuests ? "blocking" : "allowing"} guests`,
    );

    respond(cb, {
      success: true,
      noGuests: guard.room.noGuests,
      changed: update.changed,
    });
  });

  socket.on("lockChat", ({ locked }: { locked: boolean }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const update = applyRoomPolicyUpdate(io, guard.room, { chatLocked: locked });
    Logger.info(`Chat in room ${guard.room.id} ${locked ? "locked" : "unlocked"} by admin`);

    respond(cb, {
      success: true,
      locked: guard.room.isChatLocked,
      changed: update.changed,
    });
  });

  socket.on("getRoomLockStatus", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    respond(cb, { locked: guard.room.isLocked });
  });

  socket.on("getChatLockStatus", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    respond(cb, { locked: guard.room.isChatLocked });
  });

  socket.on("setTtsDisabled", ({ disabled }: { disabled: boolean }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const update = applyRoomPolicyUpdate(io, guard.room, { ttsDisabled: disabled });
    Logger.info(
      `Room ${guard.room.id} TTS ${disabled ? "disabled" : "enabled"} by admin`,
    );

    respond(cb, {
      success: true,
      disabled: guard.room.isTtsDisabled,
      changed: update.changed,
    });
  });

  socket.on("getTtsDisabledStatus", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    respond(cb, { disabled: guard.room.isTtsDisabled });
  });

  socket.on("setDmEnabled", ({ enabled }: { enabled: boolean }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    if (typeof enabled !== "boolean") {
      respond(cb, { error: "Invalid DM state" });
      return;
    }

    const update = applyRoomPolicyUpdate(io, guard.room, { dmEnabled: enabled });
    Logger.info(
      `Room ${guard.room.id} direct messages ${enabled ? "enabled" : "disabled"} by admin`,
    );

    respond(cb, {
      success: true,
      enabled: guard.room.isDmEnabled,
      changed: update.changed,
    });
  });

  socket.on("getDmEnabledStatus", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    respond(cb, { enabled: guard.room.isDmEnabled });
  });

  socket.on("setReactionsDisabled", ({ disabled }: { disabled: boolean }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const update = applyRoomPolicyUpdate(io, guard.room, { reactionsDisabled: disabled });
    Logger.info(
      `Room ${guard.room.id} reactions ${disabled ? "disabled" : "enabled"} by admin`,
    );

    respond(cb, {
      success: true,
      disabled: guard.room.isReactionsDisabled,
      changed: update.changed,
    });
  });

  socket.on("getReactionsDisabledStatus", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    respond(cb, { disabled: guard.room.isReactionsDisabled });
  });

  socket.on(
    "admin:setPolicies",
    (
      data: {
        locked?: boolean;
        noGuests?: boolean;
        chatLocked?: boolean;
        ttsDisabled?: boolean;
        dmEnabled?: boolean;
        reactionsDisabled?: boolean;
      },
      cb,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(cb, guard);
        return;
      }

      const update = applyRoomPolicyUpdate(io, guard.room, {
        locked:
          typeof data?.locked === "boolean" ? data.locked : undefined,
        noGuests:
          typeof data?.noGuests === "boolean" ? data.noGuests : undefined,
        chatLocked:
          typeof data?.chatLocked === "boolean" ? data.chatLocked : undefined,
        ttsDisabled:
          typeof data?.ttsDisabled === "boolean" ? data.ttsDisabled : undefined,
        dmEnabled:
          typeof data?.dmEnabled === "boolean" ? data.dmEnabled : undefined,
        reactionsDisabled:
          typeof data?.reactionsDisabled === "boolean" ? data.reactionsDisabled : undefined,
      });

      respond(cb, {
        success: true,
        changed: update.changed,
        policies: {
          locked: guard.room.isLocked,
          noGuests: guard.room.noGuests,
          chatLocked: guard.room.isChatLocked,
          ttsDisabled: guard.room.isTtsDisabled,
          dmEnabled: guard.room.isDmEnabled,
          reactionsDisabled: guard.room.isReactionsDisabled,
        },
      });
    },
  );

  socket.on("admin:clearRaisedHands", (cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const clearedCount = clearAllRaisedHands(io, guard.room);
    respond(cb, { success: true, clearedCount });
  });

  socket.on("admin:broadcastNotice", (data: { message?: string; level?: string }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const message = normalizePlainText(data?.message, {
      maxLength: MAX_ADMIN_NOTICE_LENGTH,
    });
    if (!message) {
      respond(cb, { error: "Message is required" });
      return;
    }

    const level =
      data?.level === "warning" || data?.level === "error" ? data.level : "info";

    io.to(guard.room.channelId).emit("adminNotice", {
      roomId: guard.room.id,
      message,
      level,
      timestamp: Date.now(),
      senderUserId: guard.adminId,
    });

    respond(cb, { success: true });
  });

  const scheduleRoomClosure = (
    roomChannelId: string,
    pendingSockets: Array<{ disconnect: (close?: boolean) => void }> = [],
  ) => {
    io.in(roomChannelId).disconnectSockets(true);
    for (const pendingSocket of pendingSockets) {
      pendingSocket.disconnect(true);
    }
    const closed = forceCloseRoom(state, roomChannelId);
    if (!closed) {
      Logger.warn(`Failed to force close room ${roomChannelId}: room not found`);
    }
  };

  const endRoom = (
    data: {
      message?: string;
      delayMs?: number;
    },
    cb: (payload: { success: boolean; roomId?: string; delayMs?: number; error?: string }) => void,
  ): void => {
    const guard = ensureAdminRoom(context, { bulk: true });
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }

    const message = parseEndRoomMessage(data?.message);
    const delayMs = parseEndRoomDelay(data?.delayMs);
    const roomChannelId = guard.room.channelId;
    const roomId = guard.room.id;

    markRoomEnded(state, guard.room, {
      message,
      endedBy: guard.adminId,
    });

    io.to(roomChannelId).emit("roomEnded", {
      roomId,
      message,
      endedBy: guard.adminId,
    });

    const pendingSockets = Array.from(
      guard.room.pendingClients.values(),
      (pending) => pending.socket,
    );

    for (const pendingSocket of pendingSockets) {
      pendingSocket.emit("roomEnded", {
        roomId,
        message,
        endedBy: guard.adminId,
      });
    }

    if (delayMs > 0) {
      setTimeout(() => {
        scheduleRoomClosure(roomChannelId, pendingSockets);
      }, delayMs);
    } else {
      setTimeout(() => {
        scheduleRoomClosure(roomChannelId, pendingSockets);
      }, 0);
    }

    respond(cb, {
      success: true,
      roomId,
      delayMs,
    });
  };

  socket.on(
    "admin:endRoom",
    (
      data: {
        message?: string;
        delayMs?: number;
      },
      cb,
    ) => {
      endRoom(data, cb);
    },
  );

  socket.on(
    "admin:closeRoom",
    (
      data: {
        message?: string;
        delayMs?: number;
      },
      cb,
    ) => {
      endRoom(data, cb);
    },
  );

  socket.on("admin:muteUserAudio", ({ userId: targetId }, cb) => {
    const guard = ensureAdminRoom(context);
    if ("error" in guard) {
      respond(cb, guard);
      return;
    }
    const normalizedTargetId = normalizeUserId(targetId);
    if (!normalizedTargetId) {
      respond(cb, { error: "Invalid user ID" });
      return;
    }

    const result = closeProducerForMediaKey({
      io,
      state,
      room: guard.room,
      userId: normalizedTargetId,
      mediaKey: "audio-webcam",
      reason: "Muted by host",
    });

    respond(cb, { success: true, closed: result.closed, producerId: result.producerId });
  });
};

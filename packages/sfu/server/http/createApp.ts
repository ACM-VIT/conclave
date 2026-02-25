import type { MediaKind } from "mediasoup/types";
import cors from "cors";
import express from "express";
import type { Express, Request, Response } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { Admin } from "../../config/classes/Admin.js";
import type { Room } from "../../config/classes/Room.js";
import type { ProducerType } from "../../config/classes/Client.js";
import { config as defaultConfig } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";
import {
  admitAllPendingUsers,
  applyRoomPolicyUpdate,
  clearAllRaisedHands,
  closeClientProducers,
  closeProducerById,
  kickClient,
  rejectAllPendingUsers,
  resolveRoom,
  toClusterSnapshot,
  toRoomSnapshot,
  toWorkerSnapshots,
} from "../admin/controlPlane.js";
import { forceCloseRoom } from "../rooms.js";
import type { SfuState } from "../state.js";

export type CreateSfuAppOptions = {
  state: SfuState;
  config?: typeof defaultConfig;
  getIo?: () => SocketIOServer | null;
};

const hasValidSecret = (req: Request, secret: string): boolean => {
  const provided = req.header("x-sfu-secret");
  return Boolean(provided && provided === secret);
};

const DEFAULT_SERVER_RESTART_NOTICE =
  "Meeting server is restarting. You will be reconnected automatically.";
const DEFAULT_SERVER_RESTART_NOTICE_MS = 4000;
const MAX_SERVER_RESTART_NOTICE_MS = 30000;

const DEFAULT_END_ROOM_MESSAGE =
  "This meeting has been ended by the host.";
const MAX_END_ROOM_DELAY_MS = 30000;

const parseRestartNoticeMs = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SERVER_RESTART_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_SERVER_RESTART_NOTICE_MS);
};

const parseRestartNotice = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_SERVER_RESTART_NOTICE;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SERVER_RESTART_NOTICE;
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
  if (typeof value !== "string") {
    return DEFAULT_END_ROOM_MESSAGE;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_END_ROOM_MESSAGE;
};

const toStringOrEmpty = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

const resolveClientId = (req: Request): string | undefined => {
  const headerValue = toStringOrEmpty(req.header("x-sfu-client"));
  const queryValue = toStringOrEmpty(req.query.clientId);
  const next = queryValue || headerValue;
  return next || undefined;
};

const parseMediaKinds = (value: unknown): MediaKind[] | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return undefined;
  }

  const kinds: MediaKind[] = [];
  for (const entry of value) {
    if (entry === "audio" || entry === "video") {
      kinds.push(entry);
      continue;
    }
    return null;
  }
  return kinds;
};

const parseMediaTypes = (value: unknown): ProducerType[] | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return undefined;
  }

  const types: ProducerType[] = [];
  for (const entry of value) {
    if (entry === "webcam" || entry === "screen") {
      types.push(entry);
      continue;
    }
    return null;
  }
  return types;
};

const parseUserKeys = (value: unknown): string[] | null => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    keys.push(normalized);
  }

  return Array.from(new Set(keys));
};

export const createSfuApp = ({
  state,
  config = defaultConfig,
  getIo,
}: CreateSfuAppOptions): Express => {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const requireSecret = (req: Request, res: Response): boolean => {
    if (hasValidSecret(req, config.sfuSecret)) {
      return true;
    }
    res.status(401).json({ error: "Unauthorized" });
    return false;
  };

  const requireIo = (res: Response): SocketIOServer | null => {
    const io = getIo?.() ?? null;
    if (io) {
      return io;
    }
    res.status(503).json({ error: "Socket server unavailable" });
    return null;
  };

  const resolveRoomForAdmin = (
    req: Request,
    res: Response,
  ): ReturnType<typeof resolveRoom> | null => {
    const roomId = toStringOrEmpty(req.params.roomId);
    if (!roomId) {
      res.status(400).json({ error: "Room ID is required" });
      return null;
    }

    const lookup = resolveRoom(state, roomId, {
      clientId: resolveClientId(req),
    });

    if ("error" in lookup) {
      res.status(lookup.candidates ? 409 : 404).json({
        error: lookup.error,
        ...(lookup.candidates ? { candidates: lookup.candidates } : {}),
      });
      return null;
    }

    return lookup;
  };

  const forceCloseRoomWithSockets = (
    io: SocketIOServer,
    roomChannelId: string,
    pendingSockets: Array<{ disconnect: (close?: boolean) => void }> = [],
  ): boolean => {
    io.in(roomChannelId).disconnectSockets(true);
    for (const pendingSocket of pendingSockets) {
      pendingSocket.disconnect(true);
    }
    return forceCloseRoom(state, roomChannelId);
  };

  const emitPendingUsersSnapshot = (
    io: SocketIOServer,
    room: Room,
  ): void => {
    io.to(room.channelId).emit("pendingUsersSnapshot", {
      users: Array.from(room.pendingClients.values()).map((pending) => ({
        userId: pending.userKey,
        displayName: pending.displayName || pending.userKey,
      })),
      roomId: room.id,
    });
  };

  const handleUserMediaControl = (
    req: Request,
    res: Response,
    overrides?: {
      kinds?: MediaKind[];
      types?: ProducerType[];
      defaultReason?: string;
    },
  ): void => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userId = toStringOrEmpty(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "User ID is required" });
      return;
    }

    const requestedKinds = overrides?.kinds ?? parseMediaKinds(req.body?.kinds);
    if (requestedKinds === null) {
      res.status(400).json({ error: "Invalid media kinds" });
      return;
    }

    const requestedTypes = overrides?.types ?? parseMediaTypes(req.body?.types);
    if (requestedTypes === null) {
      res.status(400).json({ error: "Invalid media types" });
      return;
    }

    const reason =
      toStringOrEmpty(req.body?.reason) ||
      overrides?.defaultReason ||
      "Operator moderation action";

    const result = closeClientProducers({
      io,
      state,
      room: lookup.room,
      userId,
      selector: {
        kinds: requestedKinds,
        types: requestedTypes,
      },
      reason,
    });

    res.json({
      success: true,
      userId,
      affectedProducers: result.closedCount,
      producers: result.closedProducers,
    });
  };

  const handleDrain = async (req: Request, res: Response): Promise<void> => {
    const { draining, force, notice, noticeMs } = req.body ?? {};
    if (typeof draining !== "boolean") {
      res.status(400).json({ error: "Invalid draining flag" });
      return;
    }

    state.isDraining = draining;
    Logger.info(`Draining mode ${state.isDraining ? "enabled" : "disabled"}`);

    const shouldForceDrain = state.isDraining && force === true;
    if (!shouldForceDrain) {
      res.json({ draining: state.isDraining, forced: false });
      return;
    }

    const io = getIo?.() ?? null;
    if (!io) {
      Logger.warn("Force drain requested before socket server was ready.");
      res.status(503).json({ error: "Socket server unavailable for force drain" });
      return;
    }

    const rooms = Array.from(state.rooms.values());
    const restartNotice = parseRestartNotice(notice);
    const restartNoticeMs = parseRestartNoticeMs(noticeMs);
    const connectedClients = rooms.reduce(
      (total, room) => total + room.clients.size,
      0,
    );

    const pendingSockets = new Set<{
      emit: (event: string, payload: unknown) => void;
      disconnect: (close?: boolean) => void;
    }>();

    for (const room of rooms) {
      io.to(room.channelId).emit("serverRestarting", {
        roomId: room.id,
        message: restartNotice,
        reconnecting: true,
      });

      for (const pending of room.pendingClients.values()) {
        const pendingSocket = pending.socket as
          | {
              emit: (event: string, payload: unknown) => void;
              disconnect: (close?: boolean) => void;
            }
          | undefined;
        if (pendingSocket) {
          pendingSockets.add(pendingSocket);
        }
      }
    }

    for (const pendingSocket of pendingSockets) {
      pendingSocket.emit("serverRestarting", {
        message: restartNotice,
        reconnecting: true,
      });
    }

    if (restartNoticeMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, restartNoticeMs);
      });
    }

    for (const room of rooms) {
      io.in(room.channelId).disconnectSockets(true);
    }
    for (const pendingSocket of pendingSockets) {
      pendingSocket.disconnect(true);
    }

    Logger.warn(
      `Forced drain executed for ${rooms.length} room(s), disconnecting ${connectedClients} active client(s).`,
    );

    res.json({
      draining: state.isDraining,
      forced: true,
      rooms: rooms.length,
      clients: connectedClients,
      noticeMs: restartNoticeMs,
    });
  };

  app.get("/health", (_req, res) => {
    const healthyWorkers = state.workers.filter((worker) => !worker.closed);
    const isHealthy = healthyWorkers.length > 0;

    const healthData = {
      status: isHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      port: config.port,
      workers: {
        total: state.workers.length,
        healthy: healthyWorkers.length,
        closed: state.workers.length - healthyWorkers.length,
      },
    };

    if (!isHealthy) {
      Logger.error("Health check failed: No healthy workers available");
      return res.status(503).json(healthData);
    }

    res.json(healthData);
  });

  app.get("/rooms", (req, res) => {
    if (!hasValidSecret(req, config.sfuSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const clientId = req.header("x-sfu-client") || "default";
    const roomDetails = Array.from(state.rooms.values())
      .filter((room) => room.clientId === clientId)
      .map((room) => ({
        id: room.id,
        clients: room.clientCount,
      }));

    return res.json({ rooms: roomDetails });
  });

  app.get("/status", (req, res) => {
    if (!hasValidSecret(req, config.sfuSecret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    return res.json({
      instanceId: config.instanceId,
      version: config.version,
      draining: state.isDraining,
      rooms: state.rooms.size,
      uptime: process.uptime(),
    });
  });

  app.post("/drain", async (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    await handleDrain(req, res);
  });

  app.get("/admin/overview", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    res.json({
      instanceId: config.instanceId,
      version: config.version,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      ...toClusterSnapshot(state),
    });
  });

  app.get("/admin/workers", async (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const workers = await toWorkerSnapshots(state);
    res.json({ workers });
  });

  app.get("/admin/rooms", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const clientId = resolveClientId(req);
    const rooms = Array.from(state.rooms.values())
      .filter((room) => (clientId ? room.clientId === clientId : true))
      .map((room) => toRoomSnapshot(room));

    res.json({
      rooms,
      count: rooms.length,
      ...(clientId ? { clientId } : {}),
    });
  });

  app.get("/admin/rooms/:roomId", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    res.json({ room: toRoomSnapshot(lookup.room) });
  });

  app.post("/admin/rooms/:roomId/policies", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const update = {
      locked:
        typeof req.body?.locked === "boolean" ? req.body.locked : undefined,
      chatLocked:
        typeof req.body?.chatLocked === "boolean"
          ? req.body.chatLocked
          : undefined,
      noGuests:
        typeof req.body?.noGuests === "boolean" ? req.body.noGuests : undefined,
      ttsDisabled:
        typeof req.body?.ttsDisabled === "boolean"
          ? req.body.ttsDisabled
          : undefined,
      dmEnabled:
        typeof req.body?.dmEnabled === "boolean"
          ? req.body.dmEnabled
          : undefined,
    };

    const hasUpdates = Object.values(update).some((value) => value !== undefined);
    if (!hasUpdates) {
      res.status(400).json({ error: "No policy changes provided" });
      return;
    }

    const result = applyRoomPolicyUpdate(io, lookup.room, update);
    res.json({
      success: true,
      changed: result.changed,
      policies: toRoomSnapshot(lookup.room).policies,
    });
  });

  app.post("/admin/rooms/:roomId/notice", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const message = toStringOrEmpty(req.body?.message);
    if (!message) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const level =
      req.body?.level === "warning" || req.body?.level === "error"
        ? req.body.level
        : "info";

    io.to(lookup.room.channelId).emit("adminNotice", {
      roomId: lookup.room.id,
      message,
      level,
      timestamp: Date.now(),
      senderUserId: "operator",
    });

    res.json({ success: true });
  });

  app.post("/admin/rooms/:roomId/producers/:producerId/close", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const producerId = toStringOrEmpty(req.params.producerId);
    if (!producerId) {
      res.status(400).json({ error: "Producer ID is required" });
      return;
    }

    const result = closeProducerById(io, state, lookup.room, producerId);
    if (!result.closed) {
      res.status(404).json({ error: "Producer not found" });
      return;
    }

    res.json({ success: true, ...result });
  });

  app.post("/admin/rooms/:roomId/users/:userId/kick", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userId = toStringOrEmpty(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "User ID is required" });
      return;
    }

    const reason =
      toStringOrEmpty(req.body?.reason) || "Removed by host";
    const kicked = kickClient(lookup.room, userId, reason);

    if (!kicked) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ success: true, userId, reason });
  });

  app.post("/admin/rooms/:roomId/users/:userId/media", (req, res) => {
    handleUserMediaControl(req, res);
  });

  app.post("/admin/rooms/:roomId/users/:userId/mute", (req, res) => {
    handleUserMediaControl(req, res, {
      kinds: ["audio"],
      defaultReason: "Muted by operator",
    });
  });

  app.post("/admin/rooms/:roomId/users/:userId/video-off", (req, res) => {
    handleUserMediaControl(req, res, {
      kinds: ["video"],
      types: ["webcam"],
      defaultReason: "Camera turned off by operator",
    });
  });

  app.post("/admin/rooms/:roomId/users/:userId/stop-screen", (req, res) => {
    handleUserMediaControl(req, res, {
      types: ["screen"],
      defaultReason: "Screen share stopped by operator",
    });
  });

  app.get("/admin/rooms/:roomId/access", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const roomSnapshot = toRoomSnapshot(lookup.room);
    res.json({
      roomId: lookup.room.id,
      channelId: lookup.room.channelId,
      access: roomSnapshot.access,
      pendingUsers: roomSnapshot.pendingUsers,
    });
  });

  app.post("/admin/rooms/:roomId/access/allow", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userKeys = parseUserKeys(req.body?.userKeys ?? req.body?.userKey);
    if (userKeys === null) {
      res.status(400).json({ error: "Invalid user key list" });
      return;
    }
    if (userKeys.length === 0) {
      res.status(400).json({ error: "At least one user key is required" });
      return;
    }

    const allowWhenLocked = req.body?.allowWhenLocked !== false;
    const admitted: string[] = [];

    for (const userKey of userKeys) {
      const pending = lookup.room.pendingClients.get(userKey);
      lookup.room.unblockUser(userKey);
      lookup.room.allowUser(userKey);
      if (allowWhenLocked || lookup.room.isLocked) {
        lookup.room.allowLockedUser(userKey);
      }

      if (pending) {
        pending.socket.emit("joinApproved");
        admitted.push(userKey);
        for (const admin of lookup.room.getAdmins()) {
          admin.socket.emit("userAdmitted", {
            userId: userKey,
            roomId: lookup.room.id,
          });
        }
      }
    }

    emitPendingUsersSnapshot(io, lookup.room);

    res.json({
      success: true,
      roomId: lookup.room.id,
      allowed: userKeys,
      admitted,
      access: toRoomSnapshot(lookup.room).access,
    });
  });

  app.post("/admin/rooms/:roomId/access/revoke", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userKeys = parseUserKeys(req.body?.userKeys ?? req.body?.userKey);
    if (userKeys === null) {
      res.status(400).json({ error: "Invalid user key list" });
      return;
    }
    if (userKeys.length === 0) {
      res.status(400).json({ error: "At least one user key is required" });
      return;
    }

    const revokeLocked = req.body?.revokeLocked !== false;
    for (const userKey of userKeys) {
      lookup.room.revokeAllowedUser(userKey);
      if (revokeLocked) {
        lookup.room.revokeLockedAllowedUser(userKey);
      }
    }

    res.json({
      success: true,
      roomId: lookup.room.id,
      revoked: userKeys,
      access: toRoomSnapshot(lookup.room).access,
    });
  });

  app.post("/admin/rooms/:roomId/access/block", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userKeys = parseUserKeys(req.body?.userKeys ?? req.body?.userKey);
    if (userKeys === null) {
      res.status(400).json({ error: "Invalid user key list" });
      return;
    }
    if (userKeys.length === 0) {
      res.status(400).json({ error: "At least one user key is required" });
      return;
    }

    const kickPresent = req.body?.kickPresent !== false;
    const reason = toStringOrEmpty(req.body?.reason) || "Blocked by operator";
    const kickedUserIds = new Set<string>();
    const rejectedPending: string[] = [];

    for (const userKey of userKeys) {
      const pending = lookup.room.pendingClients.get(userKey);
      lookup.room.blockUser(userKey);

      if (pending) {
        pending.socket.emit("joinRejected");
        rejectedPending.push(userKey);
      }

      if (kickPresent) {
        for (const [userId, key] of lookup.room.userKeysById.entries()) {
          if (key !== userKey) continue;
          const client = lookup.room.getClient(userId);
          if (!client) continue;
          client.socket.emit("kicked", { reason, roomId: lookup.room.id });
          client.socket.disconnect(true);
          kickedUserIds.add(userId);
        }
      }
    }

    emitPendingUsersSnapshot(io, lookup.room);

    res.json({
      success: true,
      roomId: lookup.room.id,
      blocked: userKeys,
      rejectedPending,
      kickedUserIds: Array.from(kickedUserIds.values()),
      access: toRoomSnapshot(lookup.room).access,
    });
  });

  app.post("/admin/rooms/:roomId/access/unblock", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userKeys = parseUserKeys(req.body?.userKeys ?? req.body?.userKey);
    if (userKeys === null) {
      res.status(400).json({ error: "Invalid user key list" });
      return;
    }
    if (userKeys.length === 0) {
      res.status(400).json({ error: "At least one user key is required" });
      return;
    }

    for (const userKey of userKeys) {
      lookup.room.unblockUser(userKey);
    }

    res.json({
      success: true,
      roomId: lookup.room.id,
      unblocked: userKeys,
      access: toRoomSnapshot(lookup.room).access,
    });
  });

  app.post("/admin/rooms/:roomId/users/remove-non-admins", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const includeGhosts = Boolean(req.body?.includeGhosts);
    const includeAttendees = Boolean(req.body?.includeAttendees);
    const reason = toStringOrEmpty(req.body?.reason) || "Meeting reset by operator";
    const kickedUserIds: string[] = [];

    for (const client of lookup.room.clients.values()) {
      if (client instanceof Admin) {
        continue;
      }
      if (!includeGhosts && client.isGhost) {
        continue;
      }
      if (!includeAttendees && client.isWebinarAttendee) {
        continue;
      }
      client.socket.emit("kicked", { reason, roomId: lookup.room.id });
      client.socket.disconnect(true);
      kickedUserIds.push(client.id);
    }

    res.json({
      success: true,
      roomId: lookup.room.id,
      kickedCount: kickedUserIds.length,
      kickedUserIds,
    });
  });

  app.post("/admin/rooms/:roomId/users/:userId/block", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userId = toStringOrEmpty(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "User ID is required" });
      return;
    }

    const userKey = lookup.room.userKeysById.get(userId);
    if (!userKey) {
      res.status(404).json({ error: "User identity not found" });
      return;
    }

    const reason = toStringOrEmpty(req.body?.reason) || "Blocked by operator";
    lookup.room.blockUser(userKey);
    const target = lookup.room.getClient(userId);
    if (target) {
      target.socket.emit("kicked", { reason, roomId: lookup.room.id });
      target.socket.disconnect(true);
    }

    res.json({
      success: true,
      roomId: lookup.room.id,
      userId,
      userKey,
      access: toRoomSnapshot(lookup.room).access,
    });
  });

  app.post("/admin/rooms/:roomId/users/:userId/unblock", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userId = toStringOrEmpty(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "User ID is required" });
      return;
    }

    const bodyUserKey = toStringOrEmpty(req.body?.userKey);
    const userKey = lookup.room.userKeysById.get(userId) || bodyUserKey;
    if (!userKey) {
      res.status(404).json({ error: "User identity not found" });
      return;
    }

    lookup.room.unblockUser(userKey);
    res.json({
      success: true,
      roomId: lookup.room.id,
      userId,
      userKey,
      access: toRoomSnapshot(lookup.room).access,
    });
  });

  app.post("/admin/rooms/:roomId/pending/:userKey/admit", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userKey = toStringOrEmpty(req.params.userKey);
    if (!userKey) {
      res.status(400).json({ error: "Pending user key is required" });
      return;
    }

    const pending = lookup.room.pendingClients.get(userKey);
    if (!pending) {
      res.status(404).json({ error: "Pending user not found" });
      return;
    }

    if (lookup.room.isLocked) {
      lookup.room.allowLockedUser(userKey);
    }
    lookup.room.allowUser(userKey);
    pending.socket.emit("joinApproved");

    for (const admin of lookup.room.getAdmins()) {
      admin.socket.emit("userAdmitted", {
        userId: userKey,
        roomId: lookup.room.id,
      });
    }

    emitPendingUsersSnapshot(io, lookup.room);
    res.json({ success: true, roomId: lookup.room.id, userKey });
  });

  app.post("/admin/rooms/:roomId/pending/:userKey/reject", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const userKey = toStringOrEmpty(req.params.userKey);
    if (!userKey) {
      res.status(400).json({ error: "Pending user key is required" });
      return;
    }

    const pending = lookup.room.pendingClients.get(userKey);
    if (!pending) {
      res.status(404).json({ error: "Pending user not found" });
      return;
    }

    lookup.room.removePendingClient(userKey);
    pending.socket.emit("joinRejected");

    for (const admin of lookup.room.getAdmins()) {
      admin.socket.emit("userRejected", {
        userId: userKey,
        roomId: lookup.room.id,
      });
    }

    emitPendingUsersSnapshot(io, lookup.room);
    res.json({ success: true, roomId: lookup.room.id, userKey });
  });

  app.post("/admin/rooms/:roomId/pending/admit-all", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const admitted = admitAllPendingUsers(lookup.room);
    emitPendingUsersSnapshot(io, lookup.room);

    res.json({
      success: true,
      admittedCount: admitted.length,
      users: admitted,
    });
  });

  app.post("/admin/rooms/:roomId/pending/reject-all", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const rejected = rejectAllPendingUsers(lookup.room);
    emitPendingUsersSnapshot(io, lookup.room);

    res.json({
      success: true,
      rejectedCount: rejected.length,
      users: rejected,
    });
  });

  app.post("/admin/rooms/:roomId/hands/clear", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const clearedCount = clearAllRaisedHands(io, lookup.room);
    res.json({ success: true, clearedCount });
  });

  app.post("/admin/rooms/:roomId/end", (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    const io = requireIo(res);
    if (!io) {
      return;
    }

    const lookup = resolveRoomForAdmin(req, res);
    if (!lookup || "error" in lookup) {
      return;
    }

    const room = lookup.room;
    const roomChannelId = room.channelId;
    const delayMs = parseEndRoomDelay(req.body?.delayMs);
    const message = parseEndRoomMessage(req.body?.message);

    const pendingSockets = Array.from(room.pendingClients.values())
      .map((pending) => pending.socket)
      .filter(
        (pendingSocket): pendingSocket is { disconnect: (close?: boolean) => void; emit: (event: string, payload: unknown) => void } =>
          Boolean(
            pendingSocket &&
              typeof pendingSocket.disconnect === "function" &&
              typeof pendingSocket.emit === "function",
          ),
      );

    io.to(roomChannelId).emit("roomEnded", {
      roomId: room.id,
      message,
      endedBy: "operator",
    });

    for (const pendingSocket of pendingSockets) {
      pendingSocket.emit("roomEnded", {
        roomId: room.id,
        message,
        endedBy: "operator",
      });
    }

    const closeNow = () => {
      forceCloseRoomWithSockets(io, roomChannelId, pendingSockets);
    };

    if (delayMs > 0) {
      setTimeout(closeNow, delayMs);
    } else {
      closeNow();
    }

    res.json({
      success: true,
      roomId: room.id,
      channelId: room.channelId,
      delayMs,
    });
  });

  app.post("/admin/drain", async (req, res) => {
    if (!requireSecret(req, res)) {
      return;
    }

    await handleDrain(req, res);
  });

  return app;
};

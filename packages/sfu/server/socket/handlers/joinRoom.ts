import { Admin } from "../../../config/classes/Admin.js";
import { Client } from "../../../config/classes/Client.js";
import { config } from "../../../config/config.js";
import type {
  HandRaisedSnapshot,
  JoinRoomData,
  JoinRoomResponse,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { MAX_DISPLAY_NAME_LENGTH } from "../../constants.js";
import { buildUserIdentity, normalizeDisplayName } from "../../identity.js";
import { emitUserJoined, emitUserLeft } from "../../notifications.js";
import { cleanupRoom, getOrCreateRoom, getRoomChannelId } from "../../rooms.js";
import type { ConnectionContext } from "../context.js";
import { registerAdminHandlers } from "./adminHandlers.js";

export const registerJoinRoomHandler = (context: ConnectionContext): void => {
  const { socket, io, state } = context;

  socket.on(
    "joinRoom",
    async (
      data: JoinRoomData,
      callback: (response: JoinRoomResponse | { error: string }) => void,
    ) => {
      try {
        const { roomId, sessionId } = data;
        const user = (socket as any).user;
        const hostRequested = Boolean(user?.isHost ?? user?.isAdmin);
        const clientId =
          typeof user?.clientId === "string" ? user.clientId : "default";
        const clientPolicy =
          config.clientPolicies[clientId] ?? config.clientPolicies.default;
        const displayNameCandidate = normalizeDisplayName(data?.displayName);
        if (
          displayNameCandidate &&
          displayNameCandidate.length > MAX_DISPLAY_NAME_LENGTH
        ) {
          callback({ error: "Display name too long" });
          return;
        }
        const identity = buildUserIdentity(user, sessionId, socket.id);
        if (!identity) {
          callback({ error: "Authentication error: Invalid token payload" });
          return;
        }
        if (user?.sessionId && sessionId && user.sessionId !== sessionId) {
          callback({ error: "Session mismatch" });
          return;
        }
        const { userKey, userId } = identity;
        const roomChannelId = getRoomChannelId(clientId, roomId);
        let room = state.rooms.get(roomChannelId);
        let createdRoom = false;

        if (!room) {
          if (state.isDraining) {
            callback({
              error: "Meeting server is draining. Try again shortly.",
            });
            return;
          }
          if (!hostRequested && !clientPolicy.allowNonHostRoomCreation) {
            callback({ error: "No room found." });
            return;
          }
          room = await getOrCreateRoom(state, clientId, roomId);
          createdRoom = true;
        } else if (room.getClient(userId)) {
          Logger.warn(`User ${userId} re-joining room ${roomId}`);
          room.removeClient(userId);
        }

        const isReturningPrimaryHost =
          Boolean(room.hostUserKey) && room.hostUserKey === userKey;
        const isHostForExistingRoom =
          hostRequested &&
          (clientPolicy.allowHostJoin || isReturningPrimaryHost);
        const isHost = createdRoom ? true : isHostForExistingRoom;

        if (isHost && !room.hostUserKey) {
          room.hostUserKey = userKey;
        }

        if (isHostForExistingRoom && room.cleanupTimer) {
          Logger.info(`Host returning to room ${roomId}, cleanup cancelled.`);
          room.stopCleanupTimer();
        }
        const requestedDisplayName = isHost ? displayNameCandidate : "";
        const displayName = requestedDisplayName || identity.displayName;
        const hasDisplayNameOverride = Boolean(requestedDisplayName);
        const isGhost = Boolean(data?.ghost) && Boolean(isHost);
        context.currentUserKey = userKey;

        if (!isHost && room.isLocked) {
          callback({ error: "This meeting is locked by the host." });
          return;
        }

        if (clientPolicy.useWaitingRoom && !isHost && !room.isAllowed(userKey)) {
          Logger.info(`User ${userKey} added to waiting room ${roomId}`);
          room.addPendingClient(userKey, userId, socket, displayName);
          context.pendingRoomId = roomId;
          context.pendingRoomChannelId = roomChannelId;
          context.pendingUserKey = userKey;

          if (!room.hasActiveAdmin()) {
            socket.emit("waitingRoomStatus", {
              message: "No one to let you in.",
              roomId,
            });
          }

          const admins = room.getAdmins();
          for (const admin of admins) {
            admin.socket.emit("userRequestedJoin", {
              userId: userKey,
              displayName,
              roomId,
            });
          }

          callback({
            rtpCapabilities: room.rtpCapabilities,
            existingProducers: [],
            status: "waiting",
          });
          return;
        }

        if (
          context.currentRoom &&
          context.currentRoom.channelId !== roomChannelId &&
          context.currentClient
        ) {
          Logger.info(
            `User ${userId} switching from ${context.currentRoom.id} to ${roomId}`,
          );

          context.currentRoom.removeClient(context.currentClient.id);

          if (context.currentClient.isGhost) {
            emitUserLeft(context.currentRoom, context.currentClient.id, {
              ghostOnly: true,
              excludeUserId: context.currentClient.id,
            });
          } else {
            socket
              .to(context.currentRoom.channelId)
              .emit("userLeft", { userId: context.currentClient.id });
          }

          socket.leave(context.currentRoom.channelId);
          cleanupRoom(state, context.currentRoom.channelId);

          context.currentRoom = null;
          context.currentClient = null;
        }

        context.currentRoom = room;
        context.pendingRoomId = null;
        context.pendingRoomChannelId = null;
        context.pendingUserKey = null;

        if (isHost) {
          context.currentClient = new Admin({ id: userId, socket, isGhost });
        } else {
          context.currentClient = new Client({ id: userId, socket, isGhost });
        }

        context.currentRoom.setUserIdentity(userId, userKey, displayName, {
          forceDisplayName: hasDisplayNameOverride,
        });
        context.currentRoom.addClient(context.currentClient);

        socket.join(roomChannelId);

        if (context.currentClient instanceof Admin) {
          const pendingUsers = Array.from(
            context.currentRoom.pendingClients.values(),
          ).map((pending) => ({
            userId: pending.userKey,
            displayName: pending.displayName || pending.userKey,
          }));
          socket.emit("pendingUsersSnapshot", {
            users: pendingUsers,
            roomId: context.currentRoom.id,
          });
        }

        const resolvedDisplayName =
          context.currentRoom.getDisplayNameForUser(userId) || displayName;
        if (context.currentClient.isGhost) {
          emitUserJoined(context.currentRoom, userId, resolvedDisplayName, {
            ghostOnly: true,
            excludeUserId: userId,
            isGhost: true,
          });
          for (const [clientId, client] of context.currentRoom.clients) {
            if (clientId === userId || !client.isGhost) continue;
            const ghostDisplayName =
              context.currentRoom.getDisplayNameForUser(clientId) || clientId;
            socket.emit("userJoined", {
              userId: clientId,
              displayName: ghostDisplayName,
              isGhost: true,
            });
          }
        } else {
          socket.to(roomChannelId).emit("userJoined", {
            userId,
            displayName: resolvedDisplayName,
          });
        }

        const displayNameSnapshot = context.currentRoom.getDisplayNameSnapshot({
          includeGhosts: context.currentClient.isGhost,
        });
        socket.emit("displayNameSnapshot", {
          users: displayNameSnapshot,
          roomId: context.currentRoom.id,
        });

        socket.emit("handRaisedSnapshot", {
          users: context.currentRoom.getHandRaisedSnapshot(),
          roomId: context.currentRoom.id,
        } satisfies HandRaisedSnapshot & { roomId: string });

        const newQuality = context.currentRoom.updateVideoQuality();
        if (newQuality) {
          io.to(roomChannelId).emit("setVideoQuality", { quality: newQuality });
        } else if (context.currentRoom.currentQuality === "low") {
          socket.emit("setVideoQuality", { quality: "low" });
        }

        const existingProducers = context.currentRoom.getAllProducers(userId);

        Logger.debug(
          `User ${userId} joined room ${roomId} as ${isHost ? "Host" : "Client"
          }`,
        );

        if (context.currentClient instanceof Admin) {
          registerAdminHandlers(context, { roomId });
        }

        callback({
          rtpCapabilities: context.currentRoom.rtpCapabilities,
          existingProducers,
          status: "joined",
        });
      } catch (error) {
        Logger.error("Error joining room:", error);
        callback({ error: (error as Error).message });
      }
    },
  );
};

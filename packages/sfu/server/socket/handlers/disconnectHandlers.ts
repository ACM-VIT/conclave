import { Admin } from "../../../config/classes/Admin.js";
import type { Room } from "../../../config/classes/Room.js";
import { config } from "../../../config/config.js";
import type { AppsAwarenessData } from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { cleanupRoom } from "../../rooms.js";
import { emitUserLeft } from "../../notifications.js";
import {
  emitWebinarAttendeeCountChanged,
  emitWebinarFeedChanged,
} from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { registerAdminHandlers } from "./adminHandlers.js";
import { cleanupRoomBrowser } from "./sharedBrowserHandlers.js";

const promoteNextAdmin = (room: Room): Admin | null => {
  for (const client of room.clients.values()) {
    if (client instanceof Admin || client.isGhost || client.isWebinarAttendee) {
      continue;
    }
    const promoted = room.promoteClientToAdmin(client.id);
    if (promoted) {
      return promoted;
    }
  }
  return null;
};

export const registerDisconnectHandlers = (
  context: ConnectionContext,
): void => {
  const { socket, state, io } = context;

  socket.on("disconnect", (reason) => {
    Logger.info(`Client disconnected: ${socket.id} (${reason})`);

    if (context.currentRoom && context.currentClient) {
      const room = context.currentRoom;
      const userId = context.currentClient.id;
      const roomId = room.id;
      const roomChannelId = room.channelId;
      const disconnectedSocketId = socket.id;

      const finalizeDisconnect = () => {
        const activeRoom = state.rooms.get(roomChannelId);
        if (!activeRoom) {
          return;
        }
        const activeClient = activeRoom.getClient(userId);

        if (!activeClient) {
          Logger.info(
            `Stale disconnect for ${userId} in room ${roomId}; client already removed.`,
          );
          return;
        }
        if (activeClient.socket.id !== disconnectedSocketId) {
          Logger.info(
            `Stale disconnect for ${userId} in room ${roomId}; active session exists.`,
          );
          return;
        }

        const wasAdmin = activeClient instanceof Admin;
        const isGhost = activeClient.isGhost;
        const isWebinarAttendee = activeClient.isWebinarAttendee;
        const awarenessRemovals = activeRoom.clearUserAwareness(userId);

        for (const removal of awarenessRemovals) {
          io.to(roomChannelId).emit("apps:awareness", {
            appId: removal.appId,
            awarenessUpdate: removal.awarenessUpdate,
          } satisfies AppsAwarenessData);
        }

        activeRoom.removeClient(userId);
        if (isGhost) {
          emitUserLeft(activeRoom, userId, {
            ghostOnly: true,
            excludeUserId: userId,
          });
        } else if (!isWebinarAttendee) {
          io.to(roomChannelId).emit("userLeft", { userId });
        }
        emitWebinarAttendeeCountChanged(io, state, activeRoom);
        emitWebinarFeedChanged(io, activeRoom);

        if (wasAdmin) {
          if (!activeRoom.hasActiveAdmin()) {
            const promoted = promoteNextAdmin(activeRoom);
            if (promoted) {
              Logger.info(
                `Promoted ${promoted.id} to admin in room ${roomId} after host disconnect.`,
              );
              const promotedContext = (promoted.socket as any).data
                ?.context as ConnectionContext | undefined;
              if (promotedContext) {
                promotedContext.currentClient = promoted;
                promotedContext.currentRoom = activeRoom;
                registerAdminHandlers(promotedContext, { roomId });
              }
              if (activeRoom.cleanupTimer) {
                activeRoom.stopCleanupTimer();
              }
              const pendingUsers = Array.from(
                activeRoom.pendingClients.values(),
              ).map((pending) => ({
                userId: pending.userKey,
                displayName: pending.displayName || pending.userKey,
              }));
              promoted.socket.emit("pendingUsersSnapshot", {
                users: pendingUsers,
                roomId,
              });
              promoted.socket.emit("roomLockChanged", {
                locked: activeRoom.isLocked,
                roomId,
              });
              promoted.socket.emit("hostAssigned", {
                roomId,
                hostUserId: promoted.id,
              });
              if (activeRoom.pendingClients.size > 0) {
                for (const pending of activeRoom.pendingClients.values()) {
                  pending.socket.emit("waitingRoomStatus", {
                    message: "A host is available to let you in.",
                    roomId,
                  });
                }
              }
            } else {
              Logger.info(
                `Last admin left room ${roomId}. Room remains open without an admin.`,
              );
              if (activeRoom.pendingClients.size > 0) {
                Logger.info(
                  `Room ${roomId} has pending users but no admins. Notifying waiting clients.`,
                );
                for (const pending of activeRoom.pendingClients.values()) {
                  pending.socket.emit("waitingRoomStatus", {
                    message: "No one to let you in.",
                    roomId,
                  });
                }
              }
              activeRoom.startCleanupTimer(() => {
                if (state.rooms.has(roomChannelId)) {
                  const roomInState = state.rooms.get(roomChannelId);
                  if (roomInState) {
                    if (roomInState.hasActiveAdmin()) {
                      return;
                    }
                    if (roomInState.pendingClients.size > 0) {
                      for (const pending of roomInState.pendingClients.values()) {
                        pending.socket.emit("waitingRoomStatus", {
                          message: "No one to let you in.",
                          roomId,
                        });
                      }
                    }
                    if (roomInState.isEmpty()) {
                      Logger.info(
                        `Cleanup executed for room ${roomId}. Room is empty.`,
                      );
                      if (cleanupRoom(state, roomChannelId)) {
                        void cleanupRoomBrowser(roomChannelId);
                      }
                    }
                  }
                }
              });
            }
          } else {
            Logger.info(`Admin left room ${roomId}, but other admins remain.`);
          }

          io.to(roomChannelId).emit("hostChanged", {
            roomId,
            hostUserId: activeRoom.getHostUserId(),
          });
          io.to(roomChannelId).emit("adminUsersChanged", {
            roomId,
            hostUserIds: activeRoom.getAdminUserIds(),
          });
        }

        if (state.rooms.has(roomChannelId)) {
          if (cleanupRoom(state, roomChannelId)) {
            void cleanupRoomBrowser(roomChannelId);
          }
        }

        Logger.info(`User ${userId} left room ${roomId}`);

        if (state.rooms.has(roomChannelId)) {
          const roomInState = state.rooms.get(roomChannelId);
          if (roomInState) {
            const newQuality = roomInState.updateVideoQuality();
            if (newQuality) {
              io.to(roomChannelId).emit("setVideoQuality", {
                quality: newQuality,
              });
            }
          }
        }
      };

      const graceMs = config.socket.disconnectGraceMs;
      const immediateReasons = new Set([
        "client namespace disconnect",
        "server namespace disconnect",
        "server shutting down",
        "forced close",
        "forced server close",
      ]);
      const shouldDelay = graceMs > 0 && !immediateReasons.has(reason);

      if (shouldDelay) {
        room.scheduleDisconnect(
          userId,
          disconnectedSocketId,
          graceMs,
          finalizeDisconnect,
        );
        Logger.info(
          `Delaying disconnect cleanup for ${userId} in room ${roomId} by ${graceMs}ms.`,
        );
      } else {
        finalizeDisconnect();
      }
    }

    if (
      !context.currentClient &&
      context.pendingRoomChannelId &&
      context.pendingUserKey
    ) {
      const pendingRoom = state.rooms.get(context.pendingRoomChannelId);
      if (pendingRoom) {
        const pending = pendingRoom.pendingClients.get(context.pendingUserKey);
        if (pending?.socket?.id === socket.id) {
          pendingRoom.removePendingClient(context.pendingUserKey);
          for (const admin of pendingRoom.getAdmins()) {
            admin.socket.emit("pendingUserLeft", {
              userId: context.pendingUserKey,
              roomId: context.pendingRoomId,
            });
          }
          if (pendingRoom.isEmpty()) {
            if (cleanupRoom(state, context.pendingRoomChannelId)) {
              void cleanupRoomBrowser(context.pendingRoomChannelId);
            }
          }
        }
      }
    }

    context.currentRoom = null;
    context.currentClient = null;
    context.pendingRoomId = null;
    context.pendingRoomChannelId = null;
    context.pendingUserKey = null;
    context.currentUserKey = null;
  });
};

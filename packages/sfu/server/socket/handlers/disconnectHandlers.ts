import { config } from "../../../config/config.js";
import type { AppsAwarenessData } from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { ensureHost } from "../../admin/controlPlane.js";
import { cleanupRoom } from "../../rooms.js";
import { leaveNextMeetingLobby } from "../../nextMeetingLobby.js";
import {
  emitWebinarAttendeeCountChanged,
  emitWebinarFeedChanged,
} from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { interruptActiveConclaveAnswers } from "../conclaveRelayLifecycle.js";

export const registerDisconnectHandlers = (
  context: ConnectionContext,
): void => {
  const { socket, state, io } = context;

  socket.on("disconnect", (reason) => {
    context.joinAttempts += 1;
    Logger.info(`Client disconnected: ${socket.id} (${reason})`);
    interruptActiveConclaveAnswers(io, context.activeConclaveAnswers);

    if (context.currentRoom && context.currentClient) {
      const room = context.currentRoom;
      const userId = context.currentClient.id;
      const roomId = room.id;
      const roomChannelId = room.channelId;
      const disconnectedSocketId = socket.id;

      // Proofs are not allowed to survive the socket grace window. A receiver
      // disconnect must revoke on the still-connected publisher immediately;
      // an owner disconnect fails closed by expiry if its socket cannot receive.
      room.refreshWebcamReceiverCapacityProofs();

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

        const isWebinarAttendee = activeClient.isWebinarAttendee;
        const awarenessRemovals = activeRoom.clearUserAwareness(userId);

        for (const removal of awarenessRemovals) {
          io.to(roomChannelId).emit("apps:awareness", {
            appId: removal.appId,
            awarenessUpdate: removal.awarenessUpdate,
          } satisfies AppsAwarenessData);
        }

        activeRoom.removeClient(userId);
        state.transcriptRelays
          .stopRoomForUser({
            roomKey: activeRoom.channelId,
            userId,
            canStopAnyRelay: false,
          })
          .catch((error) => {
            Logger.warn(
              `Transcript SFU relay stop on disconnect failed for room ${activeRoom.channelId}: ${error}`,
            );
          });
        void state.transcriptRelays.syncRoom(activeRoom);
        if (!isWebinarAttendee) {
          io.to(roomChannelId).emit("userLeft", {
            userId,
            roomId: activeRoom.id,
          });
        }
        emitWebinarAttendeeCountChanged(io, state, activeRoom);
        emitWebinarFeedChanged(io, state, activeRoom);

        if (state.rooms.has(roomChannelId)) {
          cleanupRoom(state, roomChannelId);
        }
        ensureHost(io, state, activeRoom);

        Logger.info(`User ${userId} left room ${roomId}`);

        if (state.rooms.has(roomChannelId)) {
          const roomInState = state.rooms.get(roomChannelId);
          if (roomInState) {
            const newQuality = roomInState.updateVideoQuality();
            if (newQuality) {
              io.to(roomChannelId).emit("setVideoQuality", {
                quality: newQuality,
                roomId: roomInState.id,
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
        // The pending-disconnect marker is itself authoritative even if a
        // Socket.IO implementation has not flipped `connected` yet.
        room.refreshWebcamReceiverCapacityProofs();
        // Browser background throttling can make a healthy hidden tab miss a
        // socket heartbeat. Keep the grace-window cleanup, but do not show peers
        // a premature "reconnecting" badge for a client that may recover before
        // final disconnect.
        Logger.info(
          `Delaying disconnect cleanup for ${userId} in room ${roomId} by ${graceMs}ms.`,
        );
      } else {
        finalizeDisconnect();
      }
    }

    // A socket can wait for one room while still seated in another (an
    // in-place room switch), so drop its waiting-room entry either way;
    // otherwise hosts are shown a knock no one is behind.
    if (context.pendingRoomChannelId && context.pendingUserKey) {
      leaveNextMeetingLobby(
        state,
        context.pendingRoomChannelId,
        context.pendingUserKey,
        socket.id,
      );
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
            cleanupRoom(state, context.pendingRoomChannelId);
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

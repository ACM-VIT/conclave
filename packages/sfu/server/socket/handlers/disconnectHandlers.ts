import { config } from "../../../config/config.js";
import { Logger } from "../../../utilities/loggers.js";
import { cleanupRoom } from "../../rooms.js";
import { disconnectNextMeetingLobby } from "../../nextMeetingLobby.js";
import {
  ensureHost,
  teardownClient,
  withdrawWaitingRequest,
} from "../../admin/controlPlane.js";
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

    const graceMs = config.socket.disconnectGraceMs;
    const immediateReasons = new Set([
      "client namespace disconnect",
      "server namespace disconnect",
      "server shutting down",
      "forced close",
      "forced server close",
    ]);
    const shouldDelay = graceMs > 0 && !immediateReasons.has(reason);

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
        if (activeRoom !== room) {
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

        teardownClient({
          io,
          state,
          room: activeRoom,
          userId,
        });
        cleanupRoom(state, activeRoom);
        ensureHost(io, state, activeRoom);
        Logger.info(`User ${userId} left room ${roomId}`);
      };


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

    if (context.pendingRoomChannelId && context.pendingUserKey) {
      disconnectNextMeetingLobby(
        state,
        context.pendingRoomChannelId,
        context.pendingUserKey,
        socket.id,
        shouldDelay ? graceMs : 0,
      );
      const pendingRoom = state.rooms.get(context.pendingRoomChannelId);
      if (pendingRoom) {
        const pending = pendingRoom.pendingClients.get(context.pendingUserKey);
        if (pending?.socket?.id === socket.id) {
          withdrawWaitingRequest(pendingRoom, context.pendingUserKey);
          cleanupRoom(state, pendingRoom);
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

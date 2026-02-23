import { Admin } from "../../../config/classes/Admin.js";
import type { RedirectData } from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { emitWebinarFeedChanged } from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerAdminHandlers = (
  context: ConnectionContext,
  options: { roomId: string },
): void => {
  const { socket, state } = context;

  socket.on("kickUser", ({ userId: targetId }: { userId: string }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }
    const target = context.currentRoom.getClient(targetId);
    if (target) {
      target.socket.emit("kicked");
      target.socket.disconnect(true);
      respond(cb, { success: true });
    } else {
      respond(cb, { error: "User not found" });
    }
  });

  socket.on("closeRemoteProducer", ({ producerId }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }
    for (const client of context.currentRoom.clients.values()) {
      if (client.removeProducerById(producerId)) {
        for (const [targetClientId, targetClient] of context.currentRoom.clients) {
          if (targetClientId === client.id || targetClient.isWebinarAttendee) {
            continue;
          }
          targetClient.socket.emit("producerClosed", {
            producerId,
            producerUserId: client.id,
          });
        }
        emitWebinarFeedChanged(context.io, context.currentRoom);
        respond(cb, { success: true });
        return;
      }
    }
    respond(cb, { error: "Producer not found" });
  });

  socket.on("muteAll", (cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }
    let count = 0;

    for (const client of context.currentRoom.clients.values()) {
      if (client instanceof Admin) continue;

      const audioProducer = client.getProducer("audio");
      if (audioProducer) {
        if (client.removeProducerById(audioProducer.id)) {
          for (const [targetClientId, targetClient] of context.currentRoom.clients) {
            if (targetClientId === client.id || targetClient.isWebinarAttendee) {
              continue;
            }
            targetClient.socket.emit("producerClosed", {
              producerId: audioProducer.id,
              producerUserId: client.id,
            });
          }
          count++;
        }
      }
    }
    emitWebinarFeedChanged(context.io, context.currentRoom);
    respond(cb, { success: true, count });
  });

  socket.on("closeAllVideo", (cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }
    let count = 0;

    for (const client of context.currentRoom.clients.values()) {
      if (client instanceof Admin) continue;

      const videoProducer = client.getProducer("video");
      if (videoProducer) {
        if (client.removeProducerById(videoProducer.id)) {
          for (const [targetClientId, targetClient] of context.currentRoom.clients) {
            if (targetClientId === client.id || targetClient.isWebinarAttendee) {
              continue;
            }
            targetClient.socket.emit("producerClosed", {
              producerId: videoProducer.id,
              producerUserId: client.id,
            });
          }
          count++;
        }
      }
    }
    emitWebinarFeedChanged(context.io, context.currentRoom);
    respond(cb, { success: true, count });
  });

  socket.on("promoteHost", ({ userId: targetId }: { userId: string }, cb) => {
    if (!context.currentRoom || !context.currentClient) {
      respond(cb, { error: "Room not found" });
      return;
    }

    const currentRoom = context.currentRoom;
    const isActiveAdmin = context.currentClient instanceof Admin;
    const hasPersistedAdminRole = Boolean(
      context.currentUserKey && currentRoom.isAdminUserKey(context.currentUserKey),
    );
    if (!isActiveAdmin && !hasPersistedAdminRole) {
      respond(cb, { error: "Only hosts can promote another host." });
      return;
    }

    const targetClient = currentRoom.getClient(targetId);
    if (!targetClient) {
      respond(cb, { error: "User not found" });
      return;
    }
    if (targetClient.isGhost || targetClient.isWebinarAttendee) {
      respond(cb, { error: "User cannot be promoted to host." });
      return;
    }

    const targetUserKey = currentRoom.userKeysById.get(targetId);
    if (!targetUserKey) {
      respond(cb, { error: "User identity not found" });
      return;
    }

    const alreadyAdmin = targetClient instanceof Admin;
    const promoted = currentRoom.promoteClientToAdmin(targetId);
    if (!promoted) {
      respond(cb, { error: "Failed to promote user" });
      return;
    }

    const promotedContext = (promoted.socket as any).data?.context as
      | ConnectionContext
      | undefined;
    if (!alreadyAdmin && promotedContext) {
      promotedContext.currentClient = promoted;
      promotedContext.currentRoom = currentRoom;
      registerAdminHandlers(promotedContext, { roomId: currentRoom.id });
      const pendingUsers = Array.from(currentRoom.pendingClients.values()).map(
        (pending) => ({
          userId: pending.userKey,
          displayName: pending.displayName || pending.userKey,
        }),
      );
      promoted.socket.emit("pendingUsersSnapshot", {
        users: pendingUsers,
        roomId: currentRoom.id,
      });
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
    });
  });

  socket.on("getRooms", (cb) => {
    const clientId =
      typeof (socket as any).user?.clientId === "string"
        ? (socket as any).user.clientId
        : "default";
    const roomList = Array.from(state.rooms.values())
      .filter((room) => room.clientId === clientId)
      .map((room) => ({
        id: room.id,
        userCount: room.clientCount,
      }));
    respond(cb, { rooms: roomList });
  });

  socket.on(
    "redirectUser",
    ({ userId: targetId, newRoomId }: RedirectData, cb) => {
      if (!context.currentRoom) {
        respond(cb, { error: "Room not found" });
        return;
      }

      const targetClient = context.currentRoom.getClient(targetId);
      if (targetClient) {
        Logger.info(`Admin redirecting user ${targetId} to ${newRoomId}`);
        targetClient.socket.emit("redirect", { newRoomId });
        respond(cb, { success: true });
      } else {
        respond(cb, { error: "User not found" });
      }
    },
  );

  socket.on("admitUser", ({ userId: targetId }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }

    const pending = context.currentRoom.pendingClients.get(targetId);
    if (pending) {
      Logger.info(
        `Admin admitted user ${pending.userKey} to room ${options.roomId}`,
      );
      if (context.currentRoom.isLocked) {
        context.currentRoom.allowLockedUser(pending.userKey);
      }
      context.currentRoom.allowUser(pending.userKey);
      pending.socket.emit("joinApproved");

      for (const admin of context.currentRoom.getAdmins()) {
        admin.socket.emit("userAdmitted", {
          userId: pending.userKey,
          roomId: context.currentRoom.id,
        });
      }

      respond(cb, { success: true });
    } else {
      respond(cb, { error: "User not found in waiting room" });
    }
  });

  socket.on("rejectUser", ({ userId: targetId }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }

    const pending = context.currentRoom.pendingClients.get(targetId);
    if (pending) {
      Logger.info(
        `Admin rejected user ${pending.userKey} from room ${options.roomId}`,
      );
      context.currentRoom.removePendingClient(pending.userKey);
      pending.socket.emit("joinRejected");

      for (const admin of context.currentRoom.getAdmins()) {
        admin.socket.emit("userRejected", {
          userId: pending.userKey,
          roomId: context.currentRoom.id,
        });
      }

      respond(cb, { success: true });
    } else {
      respond(cb, { error: "User not found in waiting room" });
    }
  });

  socket.on("lockRoom", ({ locked }: { locked: boolean }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }

    context.currentRoom.setLocked(locked);
    if (locked) {
      for (const userKey of context.currentRoom.userKeysById.values()) {
        context.currentRoom.allowLockedUser(userKey);
      }
    }
    Logger.info(
      `Room ${context.currentRoom.id} ${locked ? "locked" : "unlocked"} by admin`,
    );

    socket.to(context.currentRoom.channelId).emit("roomLockChanged", {
      locked,
      roomId: context.currentRoom.id,
    });

    socket.emit("roomLockChanged", {
      locked,
      roomId: context.currentRoom.id,
    });

    respond(cb, { success: true, locked });
  });

  socket.on("setNoGuests", ({ noGuests }: { noGuests: boolean }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }

    context.currentRoom.setNoGuests(noGuests);
    Logger.info(
      `Room ${context.currentRoom.id} ${noGuests ? "blocking" : "allowing"} guests`,
    );

    socket.to(context.currentRoom.channelId).emit("noGuestsChanged", {
      noGuests,
      roomId: context.currentRoom.id,
    });

    socket.emit("noGuestsChanged", {
      noGuests,
      roomId: context.currentRoom.id,
    });

    respond(cb, { success: true, noGuests });
  });

  socket.on("lockChat", ({ locked }: { locked: boolean }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }

    context.currentRoom.setChatLocked(locked);
    Logger.info(
      `Chat in room ${context.currentRoom.id} ${locked ? "locked" : "unlocked"} by admin`,
    );

    socket.to(context.currentRoom.channelId).emit("chatLockChanged", {
      locked,
      roomId: context.currentRoom.id,
    });

    socket.emit("chatLockChanged", {
      locked,
      roomId: context.currentRoom.id,
    });

    respond(cb, { success: true, locked });
  });

  socket.on("getRoomLockStatus", (cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }
    respond(cb, { locked: context.currentRoom.isLocked });
  });

  socket.on("getChatLockStatus", (cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }
    respond(cb, { locked: context.currentRoom.isChatLocked });
  });

  socket.on("setTtsDisabled", ({ disabled }: { disabled: boolean }, cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }

    context.currentRoom.setTtsDisabled(disabled);
    Logger.info(
      `Room ${context.currentRoom.id} TTS ${disabled ? "disabled" : "enabled"} by admin`,
    );

    socket.to(context.currentRoom.channelId).emit("ttsDisabledChanged", {
      disabled,
      roomId: context.currentRoom.id,
    });

    socket.emit("ttsDisabledChanged", {
      disabled,
      roomId: context.currentRoom.id,
    });

    respond(cb, { success: true, disabled });
  });

  socket.on("getTtsDisabledStatus", (cb) => {
    if (!context.currentRoom) {
      respond(cb, { error: "Room not found" });
      return;
    }
    respond(cb, { disabled: context.currentRoom.isTtsDisabled });
  });
};

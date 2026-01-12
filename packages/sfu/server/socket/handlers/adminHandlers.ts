import { Admin } from "../../../config/classes/Admin.js";
import type { RedirectData } from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";

export const registerAdminHandlers = (
  context: ConnectionContext,
  options: { roomId: string },
): void => {
  const { socket, state } = context;

  socket.on(
    "kickUser",
    ({ userId: targetId }: { userId: string }, cb) => {
      if (!context.currentRoom) return;
      const target = context.currentRoom.getClient(targetId);
      if (target) {
        target.socket.emit("kicked");
        target.socket.disconnect(true);
        cb({ success: true });
      } else {
        cb({ error: "User not found" });
      }
    },
  );

  socket.on("closeRemoteProducer", ({ producerId }, cb) => {
    if (!context.currentRoom) return;
    for (const client of context.currentRoom.clients.values()) {
      if (client.removeProducerById(producerId)) {
        socket.to(context.currentRoom.channelId).emit("producerClosed", {
          producerId,
          producerUserId: client.id,
        });
        cb({ success: true });
        return;
      }
    }
    cb({ error: "Producer not found" });
  });

  socket.on("muteAll", (cb) => {
    if (!context.currentRoom) return;
    let count = 0;

    for (const client of context.currentRoom.clients.values()) {
      if (client instanceof Admin) continue;

      const audioProducer = client.getProducer("audio");
      if (audioProducer) {
        if (client.removeProducerById(audioProducer.id)) {
          socket.to(context.currentRoom.channelId).emit("producerClosed", {
            producerId: audioProducer.id,
            producerUserId: client.id,
          });
          count++;
        }
      }
    }
    cb({ success: true, count });
  });

  socket.on("closeAllVideo", (cb) => {
    if (!context.currentRoom) return;
    let count = 0;

    for (const client of context.currentRoom.clients.values()) {
      if (client instanceof Admin) continue;

      const videoProducer = client.getProducer("video");
      if (videoProducer) {
        if (client.removeProducerById(videoProducer.id)) {
          socket.to(context.currentRoom.channelId).emit("producerClosed", {
            producerId: videoProducer.id,
            producerUserId: client.id,
          });
          count++;
        }
      }
    }
    cb({ success: true, count });
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
    cb({ rooms: roomList });
  });

  socket.on(
    "redirectUser",
    ({ userId: targetId, newRoomId }: RedirectData, cb) => {
      if (!context.currentRoom) return;

      const targetClient = context.currentRoom.getClient(targetId);
      if (targetClient) {
        Logger.info(`Admin redirecting user ${targetId} to ${newRoomId}`);
        targetClient.socket.emit("redirect", { newRoomId });
        cb({ success: true });
      } else {
        cb({ error: "User not found" });
      }
    },
  );

  socket.on("admitUser", ({ userId: targetId }, cb) => {
    if (!context.currentRoom) return;

    const pending = context.currentRoom.pendingClients.get(targetId);
    if (pending) {
      Logger.info(
        `Admin admitted user ${pending.userKey} to room ${options.roomId}`,
      );
      context.currentRoom.allowUser(pending.userKey);
      pending.socket.emit("joinApproved");

      for (const admin of context.currentRoom.getAdmins()) {
        admin.socket.emit("userAdmitted", {
          userId: pending.userKey,
          roomId: context.currentRoom.id,
        });
      }

      cb({ success: true });
    } else {
      cb({ error: "User not found in waiting room" });
    }
  });

  socket.on("rejectUser", ({ userId: targetId }, cb) => {
    if (!context.currentRoom) return;

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

      cb({ success: true });
    } else {
      cb({ error: "User not found in waiting room" });
    }
  });

  socket.on("lockRoom", ({ locked }: { locked: boolean }, cb) => {
    if (!context.currentRoom) return;

    context.currentRoom.setLocked(locked);
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

    cb({ success: true, locked });
  });

  socket.on("getRoomLockStatus", (cb) => {
    if (!context.currentRoom) return;
    cb({ locked: context.currentRoom.isLocked });
  });
};

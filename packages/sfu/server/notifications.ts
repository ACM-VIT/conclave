import type { Room } from "../config/classes/Room.js";

export const emitUserJoined = (
  room: Room,
  userId: string,
  displayName: string,
  options?: { excludeUserId?: string },
): void => {
  if (room.getClient(userId)?.isGhost) {
    return;
  }
  for (const client of room.clients.values()) {
    if (options?.excludeUserId && client.id === options.excludeUserId) {
      continue;
    }
    client.socket.emit("userJoined", {
      userId,
      displayName,
      roomId: room.id,
    });
  }
};

export const emitUserLeft = (
  room: Room,
  userId: string,
  options?: { excludeUserId?: string },
): void => {
  if (room.getClient(userId)?.isGhost) {
    return;
  }
  for (const client of room.clients.values()) {
    if (options?.excludeUserId && client.id === options.excludeUserId) {
      continue;
    }
    client.socket.emit("userLeft", { userId, roomId: room.id });
  }
};

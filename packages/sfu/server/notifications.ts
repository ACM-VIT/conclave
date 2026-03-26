import type { Room } from "../config/classes/Room.js";

export const emitUserJoined = (
  room: Room,
  userId: string,
  displayName: string,
  options?: {
    ghostOnly?: boolean;
    excludeUserId?: string;
    isGhost?: boolean;
    avatarUrl?: string;
  },
): void => {
  for (const client of room.clients.values()) {
    if (options?.excludeUserId && client.id === options.excludeUserId) {
      continue;
    }
    if (options?.ghostOnly && !client.isGhost) {
      continue;
    }
    client.socket.emit("userJoined", {
      userId,
      displayName,
      avatarUrl: options?.avatarUrl,
      isGhost: options?.isGhost,
    });
  }
};

export const emitUserLeft = (
  room: Room,
  userId: string,
  options?: { ghostOnly?: boolean; excludeUserId?: string },
): void => {
  for (const client of room.clients.values()) {
    if (options?.excludeUserId && client.id === options.excludeUserId) {
      continue;
    }
    if (options?.ghostOnly && !client.isGhost) {
      continue;
    }
    client.socket.emit("userLeft", { userId });
  }
};

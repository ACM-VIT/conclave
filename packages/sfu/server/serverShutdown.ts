import type { Server as SocketIOServer } from "socket.io";
import { takeNextMeetingLobby } from "./nextMeetingLobby.js";
import { forceCloseRoom, isCurrentRoom } from "./rooms.js";
import type { SfuState } from "./state.js";

type Disconnectable = {
  emit: (event: string, payload: unknown) => unknown;
  disconnect: (close?: boolean) => unknown;
};

export const handOffRooms = (state: SfuState): void => {
  for (const room of state.rooms.values()) room.beginHandOff();
};

export const forceDrainRooms = async (
  state: SfuState,
  io: SocketIOServer,
  options: { message: string; noticeMs: number },
): Promise<{ rooms: number; clients: number }> => {
  const rooms = Array.from(state.rooms.values());
  handOffRooms(state);
  const clients = rooms.reduce((total, room) => total + room.clients.size, 0);
  const waiting = new Set<Disconnectable>();
  for (const room of rooms) {
    io.to(room.channelId).emit("serverRestarting", {
      roomId: room.id,
      message: options.message,
      reconnecting: true,
    });
    for (const pending of room.pendingClients.values()) waiting.add(pending.socket);
  }
  for (const channelId of [...state.nextMeetingLobbies.keys()]) {
    for (const guest of takeNextMeetingLobby(state, channelId, { dropDisconnected: true })) {
      waiting.add(guest.socket);
    }
  }
  for (const socket of waiting) {
    socket.emit("serverRestarting", { message: options.message, reconnecting: true });
  }
  if (options.noticeMs > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, options.noticeMs);
    });
  }
  for (const room of rooms) {
    if (isCurrentRoom(state, room)) forceCloseRoom(state, room);
  }
  for (const room of rooms) io.in(room.channelId).disconnectSockets(true);
  for (const socket of waiting) socket.disconnect(true);
  return { rooms: rooms.length, clients };
};

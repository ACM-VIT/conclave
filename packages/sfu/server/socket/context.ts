import type { Socket, Server as SocketIOServer } from "socket.io";
import type { Room } from "../../config/classes/Room.js";
import type { Client } from "../../config/classes/Client.js";
import type { RecordingManager } from "../recording/recordingManager.js";
import type { SfuState } from "../state.js";

export type ConnectionContext = {
  io: SocketIOServer;
  socket: Socket;
  state: SfuState;
  recordings: RecordingManager;
  currentRoom: Room | null;
  currentClient: Client | null;
  pendingRoomId: string | null;
  pendingRoomChannelId: string | null;
  pendingUserKey: string | null;
  currentUserKey: string | null;
};

export const createConnectionContext = (
  io: SocketIOServer,
  socket: Socket,
  state: SfuState,
  recordings: RecordingManager,
): ConnectionContext => {
  return {
    io,
    socket,
    state,
    recordings,
    currentRoom: null,
    currentClient: null,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
  };
};

import type { Socket, Server as SocketIOServer } from "socket.io";
import type { Room } from "../../config/classes/Room.js";
import type { Client } from "../../config/classes/Client.js";
import type { SfuState } from "../state.js";

export type ConnectionContext = {
  io: SocketIOServer;
  socket: Socket;
  state: SfuState;
  currentRoom: Room | null;
  currentClient: Client | null;
  pendingRoomId: string | null;
  pendingRoomChannelId: string | null;
  pendingUserKey: string | null;
  currentUserKey: string | null;
  // True once admin socket handlers have been bound for this socket. joinRoom
  // (incl. the in-place room-switch path) and the host-promotion paths can each
  // call registerAdminHandlers on the SAME live socket; this guards against
  // stacking duplicate listeners (which would fire each admin action N times).
  adminHandlersRegistered: boolean;
};

// socket.io types `socket.data` as `any`; this pair is the single asserted
// view of the context slot. registerConnectionHandlers is the only writer,
// once per connection.
type SocketContextData = { context?: ConnectionContext };

export const getSocketContext = (
  socket: Socket,
): ConnectionContext | undefined => (socket.data as SocketContextData).context;

export const setSocketContext = (
  socket: Socket,
  context: ConnectionContext,
): void => {
  (socket.data as SocketContextData).context = context;
};

export const createConnectionContext = (
  io: SocketIOServer,
  socket: Socket,
  state: SfuState,
): ConnectionContext => {
  return {
    io,
    socket,
    state,
    currentRoom: null,
    currentClient: null,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
    adminHandlersRegistered: false,
  };
};

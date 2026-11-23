import type { Socket, Server as SocketIOServer } from "socket.io";
import type { Room } from "../../config/classes/Room.js";
import type { Client } from "../../config/classes/Client.js";
import type { SfuState } from "../state.js";
import type { LostRoom } from "../roomRecoveryLedger.js";
import type { ActiveConclaveAnswers } from "./conclaveRelayLifecycle.js";

// A room a join opened: whether it created it, and the lost call it brings
// back, if any.
export type OpenedRoom = { room: Room; created: boolean; lost: LostRoom | null };

// A room this socket's join is opening, or opened and did not take a seat
// in. Null once it failed.
export type RoomOpening = { channelId: string; outcome: Promise<OpenedRoom | null> };

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
  // How many joins this socket has asked for. Only the newest may act: an
  // older one still waiting when a newer one arrives answers and does
  // nothing.
  joinAttempts: number;
  // The room an older join of this socket is opening. A newer join for the
  // same code takes it over instead of opening another.
  opening: RoomOpening | null;
  // Answers are added only after their first signed packet is relayed and
  // removed when a terminal packet arrives. Socket disconnect cleanup drains
  // this map so peers never retain an orphaned streaming assistant bubble.
  activeConclaveAnswers: ActiveConclaveAnswers;
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
    joinAttempts: 0,
    opening: null,
    activeConclaveAnswers: new Map(),
    adminHandlersRegistered: false,
  };
};

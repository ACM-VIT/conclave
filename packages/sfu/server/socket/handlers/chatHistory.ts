import type { Socket } from "socket.io";
import type Room from "../../../config/classes/Room.js";
import type { ChatHistorySnapshot } from "../../../types.js";

export const emitChatHistorySnapshot = (socket: Socket, room: Room): void => {
  socket.emit("chatHistorySnapshot", {
    messages: room.getChatHistorySnapshot(),
    roomId: room.id,
  } satisfies ChatHistorySnapshot);
};

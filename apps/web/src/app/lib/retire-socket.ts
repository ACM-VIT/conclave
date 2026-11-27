import type { Socket } from "socket.io-client";

type SocketSlot = { current: Socket | null };

export const retireSocket = (
  socketRef: SocketSlot,
  onSocketReady?: (socket: Socket | null) => void,
): void => {
  const socket = socketRef.current;
  socketRef.current = null;
  onSocketReady?.(null);
  socket?.disconnect();
};

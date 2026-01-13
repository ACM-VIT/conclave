import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerRouterHandlers = (context: ConnectionContext): void => {
  const { socket } = context;

  socket.on(
    "getRouterRtpCapabilities",
    (
      callback: (
        response: { rtpCapabilities: any } | { error: string },
      ) => void,
    ) => {
      try {
        if (!context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        respond(callback, { rtpCapabilities: context.currentRoom.rtpCapabilities });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};

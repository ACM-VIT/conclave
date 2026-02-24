import type { HandRaisedNotification, SetHandRaisedData } from "../../../types.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerHandHandlers = (context: ConnectionContext): void => {
  const { socket, io } = context;

  socket.on(
    "setHandRaised",
    (
      data: SetHandRaisedData,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot raise a hand",
          });
          return;
        }

        const raised = Boolean(data?.raised);
        context.currentRoom.setHandRaised(context.currentClient.id, raised);

        const notification: HandRaisedNotification = {
          userId: context.currentClient.id,
          raised,
          timestamp: Date.now(),
        };

        io.to(context.currentRoom.channelId).emit("handRaised", notification);
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};

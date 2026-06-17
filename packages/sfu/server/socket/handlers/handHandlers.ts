import type { HandRaisedNotification, SetHandRaisedData } from "../../../types.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";

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

        // Throttle: drop over-budget toggles (ack an error, do not broadcast).
        if (!takeToken(socket, "setHandRaised", RATE_LIMITS.hand)) {
          respond(callback, { error: "You are raising your hand too quickly" });
          return;
        }

        if (typeof data?.raised !== "boolean") {
          respond(callback, { error: "Invalid hand state" });
          return;
        }

        const raised = data.raised;
        context.currentRoom.setHandRaised(context.currentClient.id, raised);

        const notification: HandRaisedNotification = {
          userId: context.currentClient.id,
          raised,
          timestamp: Date.now(),
          roomId: context.currentRoom.id,
        };

        io.to(context.currentRoom.channelId).emit("handRaised", notification);
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};

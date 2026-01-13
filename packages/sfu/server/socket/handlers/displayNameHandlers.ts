import { Admin } from "../../../config/classes/Admin.js";
import { MAX_DISPLAY_NAME_LENGTH } from "../../constants.js";
import { normalizeDisplayName } from "../../identity.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerDisplayNameHandlers = (
  context: ConnectionContext,
): void => {
  const { socket, io } = context;

  socket.on(
    "updateDisplayName",
    (
      data: { displayName?: string },
      callback: (
        response:
          | { success: boolean; displayName: string }
          | { error: string },
      ) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }

        if (!(context.currentClient instanceof Admin)) {
          respond(callback, { error: "Only admins can update display name" });
          return;
        }

        const displayName = normalizeDisplayName(data.displayName);
        if (!displayName) {
          respond(callback, { error: "Display name cannot be empty" });
          return;
        }

        if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
          respond(callback, { error: "Display name too long" });
          return;
        }

        if (!context.currentUserKey) {
          respond(callback, { error: "Missing user identity" });
          return;
        }

        const updatedUserIds = context.currentRoom.updateDisplayName(
          context.currentUserKey,
          displayName,
        );

        for (const userId of updatedUserIds) {
          io.to(context.currentRoom.channelId).emit("displayNameUpdated", {
            userId,
            displayName,
            roomId: context.currentRoom.id,
          });
        }

        respond(callback, { success: true, displayName });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};

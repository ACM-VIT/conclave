import { Admin } from "../../../config/classes/Admin.js";
import type {
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
} from "../../../types.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

const toMeetingConfigSnapshot = (
  context: ConnectionContext,
): MeetingConfigSnapshot => {
  return {
    requiresInviteCode: Boolean(context.currentRoom?.requiresMeetingInviteCode),
  };
};

const ensureAdminRoom = (
  context: ConnectionContext,
): { roomId: string } | { error: string } => {
  if (!context.currentRoom || !context.currentClient) {
    return { error: "Not in a room" };
  }

  if (!(context.currentClient instanceof Admin)) {
    return { error: "Only admins can manage meeting settings" };
  }

  return { roomId: context.currentRoom.id };
};

export const registerMeetingHandlers = (context: ConnectionContext): void => {
  const { socket, io } = context;

  socket.on(
    "meeting:getConfig",
    (
      callback: (
        response: MeetingConfigSnapshot | { error: string },
      ) => void,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }

      respond(callback, toMeetingConfigSnapshot(context));
    },
  );

  socket.on(
    "meeting:updateConfig",
    (
      data: MeetingUpdateRequest,
      callback: (
        response:
          | { success: boolean; config: MeetingConfigSnapshot }
          | { error: string },
      ) => void,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }

      const room = context.currentRoom!;
      const update = data ?? {};
      let changed = false;

      if (Object.prototype.hasOwnProperty.call(update, "inviteCode")) {
        const inviteCode =
          typeof update.inviteCode === "string" ? update.inviteCode : null;
        changed = room.setMeetingInviteCode(inviteCode) || changed;
      }

      if (changed) {
        io.to(room.channelId).emit(
          "meeting:configChanged",
          toMeetingConfigSnapshot(context),
        );
      }

      respond(callback, {
        success: true,
        config: toMeetingConfigSnapshot(context),
      });
    },
  );
};

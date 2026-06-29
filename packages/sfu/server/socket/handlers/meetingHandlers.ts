import { Admin } from "../../../config/classes/Admin.js";
import type {
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
} from "../../../types.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_INVITE_CODE_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizeInviteCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_INVITE_CODE_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
};

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

  if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
    return { error: "Only admins can manage meeting settings" };
  }

  if (!takeToken(context.socket, "meeting:admin", RATE_LIMITS.adminAction)) {
    return { error: "Too many admin requests; please retry shortly" };
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
        let inviteCode: string | null = null;
        if (typeof update.inviteCode === "string" && update.inviteCode.trim()) {
          const normalizedInviteCode = normalizeInviteCode(update.inviteCode);
          if (!normalizedInviteCode) {
            respond(callback, { error: "Invalid invite code" });
            return;
          }
          inviteCode = normalizedInviteCode;
        }
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

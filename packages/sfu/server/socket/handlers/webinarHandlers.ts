import { Admin } from "../../../config/classes/Admin.js";
import type {
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
} from "../../../types.js";
import {
  emitWebinarAttendeeCountChanged,
  emitWebinarConfigChanged,
  getWebinarConfigSnapshot,
  getWebinarLinkResponse,
} from "../../webinarNotifications.js";
import {
  clearWebinarLinkSlug,
  getOrCreateWebinarRoomConfig,
  rotateWebinarLinkSlug,
  setCustomWebinarLinkSlug,
  updateWebinarRoomConfig,
} from "../../webinar.js";
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

const ensureAdminRoom = (
  context: ConnectionContext,
): { roomId: string } | { error: string } => {
  if (!context.currentRoom || !context.currentClient) {
    return { error: "Not in a room" };
  }

  if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
    return { error: "Only admins can manage webinar settings" };
  }

  if (!takeToken(context.socket, "webinar:admin", RATE_LIMITS.adminAction)) {
    return { error: "Too many admin requests; please retry shortly" };
  }

  return { roomId: context.currentRoom.id };
};

export const registerWebinarHandlers = (context: ConnectionContext): void => {
  const { socket, io, state } = context;

  socket.on(
    "webinar:getConfig",
    (
      callback: (
        response: WebinarConfigSnapshot | { error: string },
      ) => void,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }

      respond(callback, getWebinarConfigSnapshot(state, context.currentRoom!));
    },
  );

  socket.on(
    "webinar:updateConfig",
    (
      data: WebinarUpdateRequest,
      callback: (
        response:
          | { success: boolean; config: WebinarConfigSnapshot }
          | { error: string },
      ) => void,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }

      const room = context.currentRoom!;
      const webinarConfig = getOrCreateWebinarRoomConfig(
        state.webinarConfigs,
        room.channelId,
      );

      try {
        const update = { ...(data ?? {}) };
        if (Object.prototype.hasOwnProperty.call(update, "inviteCode")) {
          if (
            typeof update.inviteCode === "string" &&
            update.inviteCode.trim()
          ) {
            const normalizedInviteCode = normalizeInviteCode(update.inviteCode);
            if (!normalizedInviteCode) {
              respond(callback, { error: "Invalid invite code" });
              return;
            }
            update.inviteCode = normalizedInviteCode;
          } else {
            update.inviteCode = null;
          }
        }
        const {
          changed: baseChanged,
          linkVersionBumped,
        } = updateWebinarRoomConfig(
          webinarConfig,
          update,
        );
        let changed = baseChanged;
        const disablingWebinar = update.enabled === false;

        if (
          !disablingWebinar &&
          Object.prototype.hasOwnProperty.call(update, "linkSlug")
        ) {
          const rawLinkSlug =
            typeof update.linkSlug === "string" ? update.linkSlug.trim() : "";

          if (!rawLinkSlug) {
            const cleared = clearWebinarLinkSlug({
              webinarConfig,
              webinarLinks: state.webinarLinks,
              roomChannelId: room.channelId,
            });
            changed = changed || cleared;
            if (cleared) {
              webinarConfig.linkVersion += 1;
            }
          } else {
            const { changed: slugChanged } = setCustomWebinarLinkSlug({
              webinarConfig,
              webinarLinks: state.webinarLinks,
              room,
              slug: rawLinkSlug,
            });
            changed = changed || slugChanged;
            if (slugChanged) {
              webinarConfig.linkVersion += 1;
            }
          }
        }

        if (disablingWebinar) {
          const cleared = clearWebinarLinkSlug({
            webinarConfig,
            webinarLinks: state.webinarLinks,
            roomChannelId: room.channelId,
          });
          changed = changed || cleared;
          if (cleared && !linkVersionBumped) {
            webinarConfig.linkVersion += 1;
          }
        }

        if (changed) {
          emitWebinarConfigChanged(io, state, room);
          emitWebinarAttendeeCountChanged(io, state, room);
        }

        respond(callback, {
          success: true,
          config: getWebinarConfigSnapshot(state, room),
        });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "webinar:rotateLink",
    (
      callback:
        | ((response: WebinarLinkResponse | { error: string }) => void)
        | undefined,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        if (callback) {
          respond(callback, guard);
        }
        return;
      }

      const room = context.currentRoom!;
      const webinarConfig = getOrCreateWebinarRoomConfig(
        state.webinarConfigs,
        room.channelId,
      );

      rotateWebinarLinkSlug({
        webinarConfig,
        webinarLinks: state.webinarLinks,
        room,
      });
      webinarConfig.linkVersion += 1;
      emitWebinarConfigChanged(io, state, room);

      if (callback) {
        respond(
          callback,
          getWebinarLinkResponse(state, room, {
            linkVersion: webinarConfig.linkVersion,
            publicAccess: webinarConfig.publicAccess,
          }),
        );
      }
    },
  );

  socket.on(
    "webinar:generateLink",
    (
      callback: (
        response: WebinarLinkResponse | { error: string },
      ) => void,
    ) => {
      const guard = ensureAdminRoom(context);
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }

      const room = context.currentRoom!;
      const webinarConfig = getOrCreateWebinarRoomConfig(
        state.webinarConfigs,
        room.channelId,
      );

      if (!webinarConfig.enabled) {
        respond(callback, { error: "Enable webinar mode before generating a link" });
        return;
      }

      respond(
        callback,
        getWebinarLinkResponse(state, room, {
          linkVersion: webinarConfig.linkVersion,
          publicAccess: webinarConfig.publicAccess,
        }),
      );
    },
  );
};

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
import type { Room } from "../../../config/classes/Room.js";
import { forgetLostSeat, type ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";
import { getRoomChannelId } from "../../rooms.js";
import { webinarBySlug } from "../../controlPlane/webinarCommands.js";

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

const adminRoomOf = (
  context: ConnectionContext,
): { room: Room } | { error: string } => {
  forgetLostSeat(context);
  if (!context.currentRoom || !context.currentClient) {
    return { error: "Not in a room" };
  }

  if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
    return { error: "Only admins can manage webinar settings" };
  }

  return { room: context.currentRoom };
};

const ensureAdminRoom = (
  context: ConnectionContext,
): { roomId: string } | { error: string } => {
  const seat = adminRoomOf(context);
  if ("error" in seat) return seat;

  if (!takeToken(context.socket, "webinar:admin", RATE_LIMITS.adminAction)) {
    return { error: "Too many admin requests; please retry shortly" };
  }

  return { roomId: seat.room.id };
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
    async (
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
        const disablingWebinar = update.enabled === false;
        const requestedLinkSlug =
          !disablingWebinar && typeof update.linkSlug === "string"
            ? update.linkSlug.trim()
            : "";
        const reservedBy = requestedLinkSlug
          ? await state.controlPlane.read(webinarBySlug(requestedLinkSlug))
          : null;
        const seat = adminRoomOf(context);
        if ("error" in seat) {
          respond(callback, seat);
          return;
        }
        const room = seat.room;
        const webinarConfig = getOrCreateWebinarRoomConfig(
          state.webinarConfigs,
          room.channelId,
        );
        const {
          changed: baseChanged,
          linkVersionBumped,
        } = updateWebinarRoomConfig(
          webinarConfig,
          update,
        );
        let changed = baseChanged;

        if (
          !disablingWebinar &&
          Object.prototype.hasOwnProperty.call(update, "linkSlug")
        ) {
          if (!requestedLinkSlug) {
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
            // A scheduled webinar's link code belongs to its room, even before
            // (or after) the scheduler binds it; an ad-hoc room must not take
            // it and receive that webinar's audience.
            if (
              reservedBy &&
              getRoomChannelId(reservedBy.clientId, reservedBy.roomId) !==
                room.channelId
            ) {
              throw new Error("This webinar link code is already in use.");
            }
            const { changed: slugChanged } = setCustomWebinarLinkSlug({
              webinarConfig,
              webinarLinks: state.webinarLinks,
              room,
              slug: requestedLinkSlug,
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

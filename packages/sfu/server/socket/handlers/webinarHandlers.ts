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
import { respond } from "./ack.js";

const ensureAdminRoom = (
  context: ConnectionContext,
): { roomId: string } | { error: string } => {
  if (!context.currentRoom || !context.currentClient) {
    return { error: "Not in a room" };
  }

  if (!(context.currentClient instanceof Admin)) {
    return { error: "Only admins can manage webinar settings" };
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
        const update = data ?? {};
        const { changed: baseChanged } = updateWebinarRoomConfig(
          webinarConfig,
          update,
        );
        let changed = baseChanged;

        if (Object.prototype.hasOwnProperty.call(update, "linkSlug")) {
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

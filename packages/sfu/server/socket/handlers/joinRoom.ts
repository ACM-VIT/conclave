import { Admin } from "../../../config/classes/Admin.js";
import { Client } from "../../../config/classes/Client.js";
import { config } from "../../../config/config.js";
import type {
  AppsAwarenessData,
  HandRaisedSnapshot,
  JoinRoomData,
  JoinRoomResponse,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { MAX_DISPLAY_NAME_LENGTH } from "../../constants.js";
import {
  buildUserIdentity,
  isGuestUserKey,
  normalizeDisplayName,
} from "../../identity.js";
import { emitUserJoined, emitUserLeft } from "../../notifications.js";
import { cleanupRoom, getOrCreateRoom, getRoomChannelId } from "../../rooms.js";
import {
  emitWebinarAttendeeCountChanged,
  emitWebinarFeedChanged,
} from "../../webinarNotifications.js";
import {
  getOrCreateWebinarRoomConfig,
  resolveWebinarLinkTarget,
  toWebinarConfigSnapshot,
  verifyInviteCode,
} from "../../webinar.js";
import type { ConnectionContext } from "../context.js";
import { registerAdminHandlers } from "./adminHandlers.js";
import { respond } from "./ack.js";
import {
  cleanupRoomBrowser,
  clearBrowserState,
  getBrowserState,
} from "./sharedBrowserHandlers.js";

export const registerJoinRoomHandler = (context: ConnectionContext): void => {
  const { socket, io, state } = context;

  socket.on(
    "joinRoom",
    async (
      data: JoinRoomData,
      callback: (response: JoinRoomResponse | { error: string }) => void,
    ) => {
      try {
        const requestedRoomId =
          typeof data?.roomId === "string" ? data.roomId.trim() : "";
        const { sessionId } = data;
        const user = (socket as any).user;
        if (!requestedRoomId) {
          respond(callback, { error: "Missing room ID" });
          return;
        }
        const joinMode =
          user?.joinMode === "webinar_attendee"
            ? "webinar_attendee"
            : "meeting";
        const isWebinarAttendeeJoin = joinMode === "webinar_attendee";
        const forcedHostJoin =
          !isWebinarAttendeeJoin && Boolean(user?.isForcedHost);

        const hostRequested =
          !isWebinarAttendeeJoin &&
          Boolean(user?.isHost ?? user?.isAdmin ?? user?.isForcedHost);
        const allowRoomCreation =
          !isWebinarAttendeeJoin && Boolean(user?.allowRoomCreation);
        const clientId =
          typeof user?.clientId === "string" ? user.clientId : "default";
        let roomId = requestedRoomId;
        if (isWebinarAttendeeJoin) {
          const webinarTarget = resolveWebinarLinkTarget(
            state.webinarLinks,
            requestedRoomId,
            clientId,
          );
          if (!webinarTarget) {
            respond(callback, { error: "Webinar is not live." });
            return;
          }
          roomId = webinarTarget.roomId;
        }
        const clientPolicy =
          config.clientPolicies[clientId] ?? config.clientPolicies.default;
        const displayNameCandidate = normalizeDisplayName(data?.displayName);
        if (
          displayNameCandidate &&
          displayNameCandidate.length > MAX_DISPLAY_NAME_LENGTH
        ) {
          respond(callback, { error: "Display name too long" });
          return;
        }

        const identity = buildUserIdentity(user, sessionId, socket.id);
        if (!identity) {
          respond(callback, {
            error: "Authentication error: Invalid token payload",
          });
          return;
        }
        if (user?.sessionId && sessionId && user.sessionId !== sessionId) {
          respond(callback, { error: "Session mismatch" });
          return;
        }

        const { userKey, userId } = identity;
        const roomChannelId = getRoomChannelId(clientId, roomId);
        let room = state.rooms.get(roomChannelId);
        let createdRoom = false;

        if (!room) {
          if (isWebinarAttendeeJoin) {
            respond(callback, { error: "Webinar is not live." });
            return;
          }
          if (state.isDraining) {
            respond(callback, {
              error: "Meeting server is draining. Try again shortly.",
            });
            return;
          }
          if (
            !hostRequested &&
            !allowRoomCreation &&
            !clientPolicy.allowNonHostRoomCreation
          ) {
            respond(callback, { error: "No room found." });
            return;
          }
          room = await getOrCreateRoom(state, clientId, roomId);
          createdRoom = true;
        }

        const webinarConfig = getOrCreateWebinarRoomConfig(
          state.webinarConfigs,
          roomChannelId,
        );

        if (isWebinarAttendeeJoin) {
          if (!webinarConfig.enabled) {
            respond(callback, { error: "Webinar is not enabled." });
            return;
          }

          const inviteCode = data?.webinarInviteCode?.trim() || "";
          const inviteCodeHash = webinarConfig.inviteCodeHash;
          const hasInviteCodeConfig = Boolean(inviteCodeHash);

          if (hasInviteCodeConfig && webinarConfig.publicAccess && !inviteCode) {
            respond(callback, { error: "Webinar invite code required." });
            return;
          }

          if (
            inviteCodeHash &&
            inviteCode &&
            !verifyInviteCode(inviteCode, inviteCodeHash)
          ) {
            respond(callback, { error: "Invalid webinar invite code." });
            return;
          }

          if (webinarConfig.locked) {
            respond(callback, { error: "Webinar is locked." });
            return;
          }
        }

        const wasReconnecting = room.clearPendingDisconnect(userId);
        const existingClient = room.getClient(userId);
        const reclaimingWebinarSeat = existingClient
          ? Boolean(existingClient.isWebinarAttendee)
          : false;

        if (existingClient) {
          Logger.warn(`User ${userId} re-joining room ${roomId}`);
          const awarenessRemovals = room.clearUserAwareness(userId);
          for (const removal of awarenessRemovals) {
            io.to(roomChannelId).emit("apps:awareness", {
              appId: removal.appId,
              awarenessUpdate: removal.awarenessUpdate,
            } satisfies AppsAwarenessData);
          }
          room.removeClient(userId);
        }

        if (
          isWebinarAttendeeJoin &&
          !reclaimingWebinarSeat &&
          room.getWebinarAttendeeCount() >= webinarConfig.maxAttendees
        ) {
          respond(callback, { error: "Webinar is full." });
          return;
        }

        const browserState = getBrowserState(roomChannelId);
        if (browserState.active && room.clients.size === 0) {
          Logger.info(
            `[SharedBrowser] Clearing stale browser session for empty room ${roomId}`,
          );
          clearBrowserState(roomChannelId);
        }

        const isReturningPrimaryHost =
          !isWebinarAttendeeJoin &&
          Boolean(room.hostUserKey) &&
          room.hostUserKey === userKey;
        const isHostForExistingRoom =
          !isWebinarAttendeeJoin &&
          (isReturningPrimaryHost ||
            (hostRequested &&
              (clientPolicy.allowHostJoin || forcedHostJoin)));
        const isHost = isWebinarAttendeeJoin
          ? false
          : createdRoom
            ? true
            : isHostForExistingRoom;

        const meetingInviteCode = data?.meetingInviteCode?.trim() || "";
        const requiresMeetingInviteCode = room.requiresMeetingInviteCode;
        const shouldValidateMeetingInviteCode =
          !isWebinarAttendeeJoin &&
          !isHost &&
          requiresMeetingInviteCode &&
          !wasReconnecting &&
          !existingClient;

        if (shouldValidateMeetingInviteCode && !meetingInviteCode) {
          respond(callback, { error: "Meeting invite code required." });
          return;
        }

        if (
          shouldValidateMeetingInviteCode &&
          !room.verifyMeetingInviteCode(meetingInviteCode)
        ) {
          respond(callback, { error: "Invalid meeting invite code." });
          return;
        }

        if (isHost && !room.hostUserKey) {
          room.hostUserKey = userKey;
        }
        const isPrimaryHost = room.hostUserKey === userKey;

        if (
          !isWebinarAttendeeJoin &&
          room.noGuests &&
          !isHost &&
          isGuestUserKey(userKey)
        ) {
          Logger.info(
            `Guest ${userKey} blocked from room ${roomId} (no guests allowed).`,
          );
          respond(callback, { error: "Guests are not allowed in this meeting." });
          return;
        }

        if (isHost) {
          socket.emit("hostAssigned", { roomId, hostUserId: userId });
        }

        if (isHostForExistingRoom && room.cleanupTimer) {
          Logger.info(`Host returning to room ${roomId}, cleanup cancelled.`);
          room.stopCleanupTimer();
        }

        const canSetDisplayName = Boolean(
          !isWebinarAttendeeJoin &&
            (clientPolicy.allowDisplayNameUpdate || isHost),
        );
        const requestedDisplayName =
          canSetDisplayName && displayNameCandidate ? displayNameCandidate : "";
        const displayName = requestedDisplayName || identity.displayName;
        const hasDisplayNameOverride = Boolean(requestedDisplayName);
        const isGhost =
          !isWebinarAttendeeJoin && Boolean(data?.ghost) && Boolean(isHost);
        context.currentUserKey = userKey;

        if (
          !isWebinarAttendeeJoin &&
          room.isLocked &&
          !isPrimaryHost &&
          !room.isLockedAllowed(userKey)
        ) {
          Logger.info(
            `User ${userKey} trying to join locked room ${roomId}, adding to waiting room`,
          );
          room.addPendingClient(userKey, userId, socket, displayName);
          context.pendingRoomId = roomId;
          context.pendingRoomChannelId = roomChannelId;
          context.pendingUserKey = userKey;

          socket.emit("waitingRoomStatus", {
            message:
              "This meeting is locked. Waiting for the host to let you in.",
            roomId,
          });

          const admins = room.getAdmins();
          for (const admin of admins) {
            admin.socket.emit("userRequestedJoin", {
              userId: userKey,
              displayName,
              roomId,
              reason: "locked",
            });
          }

          respond(callback, {
            roomId,
            rtpCapabilities: room.rtpCapabilities,
            existingProducers: [],
            status: "waiting",
            hostUserId: room.getHostUserId(),
            isLocked: room.isLocked,
            isTtsDisabled: room.isTtsDisabled,
            meetingRequiresInviteCode: room.requiresMeetingInviteCode,
          });
          return;
        }

        if (
          !isWebinarAttendeeJoin &&
          clientPolicy.useWaitingRoom &&
          !isHost &&
          !room.isAllowed(userKey) &&
          !(room.isLocked && room.isLockedAllowed(userKey))
        ) {
          Logger.info(`User ${userKey} added to waiting room ${roomId}`);
          room.addPendingClient(userKey, userId, socket, displayName);
          context.pendingRoomId = roomId;
          context.pendingRoomChannelId = roomChannelId;
          context.pendingUserKey = userKey;

          if (!room.hasActiveAdmin()) {
            socket.emit("waitingRoomStatus", {
              message: "No one to let you in.",
              roomId,
            });
          }

          const admins = room.getAdmins();
          for (const admin of admins) {
            admin.socket.emit("userRequestedJoin", {
              userId: userKey,
              displayName,
              roomId,
            });
          }

          respond(callback, {
            roomId,
            rtpCapabilities: room.rtpCapabilities,
            existingProducers: [],
            status: "waiting",
            hostUserId: room.getHostUserId(),
            isLocked: room.isLocked,
            isTtsDisabled: room.isTtsDisabled,
            meetingRequiresInviteCode: room.requiresMeetingInviteCode,
          });
          return;
        }

        if (
          context.currentRoom &&
          context.currentRoom.channelId !== roomChannelId &&
          context.currentClient
        ) {
          const previousRoom = context.currentRoom;
          const previousChannelId = previousRoom.channelId;
          const previousClientId = context.currentClient.id;
          Logger.info(
            `User ${userId} switching from ${previousRoom.id} to ${roomId}`,
          );

          const awarenessRemovals =
            previousRoom.clearUserAwareness(previousClientId);
          for (const removal of awarenessRemovals) {
            socket.to(previousChannelId).emit("apps:awareness", {
              appId: removal.appId,
              awarenessUpdate: removal.awarenessUpdate,
            } satisfies AppsAwarenessData);
          }

          previousRoom.removeClient(previousClientId);

          if (context.currentClient.isGhost) {
            emitUserLeft(previousRoom, previousClientId, {
              ghostOnly: true,
              excludeUserId: previousClientId,
            });
          } else if (!context.currentClient.isWebinarAttendee) {
            socket
              .to(previousChannelId)
              .emit("userLeft", { userId: previousClientId });
          }

          emitWebinarAttendeeCountChanged(io, state, previousRoom);
          emitWebinarFeedChanged(io, previousRoom);

          socket.leave(previousChannelId);
          if (cleanupRoom(state, previousChannelId)) {
            void cleanupRoomBrowser(previousChannelId);
          }

          context.currentRoom = null;
          context.currentClient = null;
        }

        context.currentRoom = room;
        context.pendingRoomId = null;
        context.pendingRoomChannelId = null;
        context.pendingUserKey = null;

        if (isHost) {
          context.currentClient = new Admin({
            id: userId,
            socket,
            mode: isGhost ? "ghost" : "participant",
          });
        } else if (isWebinarAttendeeJoin) {
          context.currentClient = new Client({
            id: userId,
            socket,
            mode: "webinar_attendee",
          });
        } else {
          context.currentClient = new Client({
            id: userId,
            socket,
            mode: isGhost ? "ghost" : "participant",
          });
        }

        context.currentRoom.setUserIdentity(userId, userKey, displayName, {
          forceDisplayName: hasDisplayNameOverride,
        });
        context.currentRoom.addClient(context.currentClient);

        socket.join(roomChannelId);

        io.to(roomChannelId).emit("hostChanged", {
          roomId: context.currentRoom.id,
          hostUserId: context.currentRoom.getHostUserId(),
        });

        if (context.currentClient instanceof Admin) {
          const pendingUsers = Array.from(
            context.currentRoom.pendingClients.values(),
          ).map((pending) => ({
            userId: pending.userKey,
            displayName: pending.displayName || pending.userKey,
          }));
          socket.emit("pendingUsersSnapshot", {
            users: pendingUsers,
            roomId: context.currentRoom.id,
          });
        }

        const resolvedDisplayName =
          context.currentRoom.getDisplayNameForUser(userId) || displayName;
        if (!wasReconnecting) {
          if (context.currentClient.isGhost) {
            emitUserJoined(context.currentRoom, userId, resolvedDisplayName, {
              ghostOnly: true,
              excludeUserId: userId,
              isGhost: true,
            });
            for (const [clientId, client] of context.currentRoom.clients) {
              if (clientId === userId || !client.isGhost) continue;
              const ghostDisplayName =
                context.currentRoom.getDisplayNameForUser(clientId) || clientId;
              socket.emit("userJoined", {
                userId: clientId,
                displayName: ghostDisplayName,
                isGhost: true,
              });
            }
          } else if (!context.currentClient.isWebinarAttendee) {
            for (const [clientId, client] of context.currentRoom.clients) {
              if (clientId === userId || client.isWebinarAttendee) {
                continue;
              }
              client.socket.emit("userJoined", {
                userId,
                displayName: resolvedDisplayName,
              });
            }
          }
        } else {
          Logger.info(`User ${userId} reconnected to room ${roomId}.`);
        }

        const displayNameSnapshot = context.currentRoom.getDisplayNameSnapshot({
          includeGhosts: context.currentClient.isGhost,
          includeWebinarAttendees: false,
        });
        socket.emit("displayNameSnapshot", {
          users: displayNameSnapshot,
          roomId: context.currentRoom.id,
        });

        socket.emit("handRaisedSnapshot", {
          users: context.currentRoom.getHandRaisedSnapshot(),
          roomId: context.currentRoom.id,
        } satisfies HandRaisedSnapshot & { roomId: string });

        socket.emit("roomLockChanged", {
          locked: context.currentRoom.isLocked,
          roomId: context.currentRoom.id,
        });

        socket.emit("noGuestsChanged", {
          noGuests: context.currentRoom.noGuests,
          roomId: context.currentRoom.id,
        });

        socket.emit("chatLockChanged", {
          locked: context.currentRoom.isChatLocked,
          roomId: context.currentRoom.id,
        });

        socket.emit("apps:state", {
          activeAppId: context.currentRoom.appsState.activeAppId,
          locked: context.currentRoom.appsState.locked,
        });

        const newQuality = context.currentRoom.updateVideoQuality();
        if (newQuality) {
          io.to(roomChannelId).emit("setVideoQuality", { quality: newQuality });
        } else if (context.currentRoom.currentQuality === "low") {
          socket.emit("setVideoQuality", { quality: "low" });
        }

        const feedSnapshot = context.currentRoom.refreshWebinarFeedSnapshot();
        const existingProducers = context.currentClient.isWebinarAttendee
          ? feedSnapshot.producers
          : context.currentRoom.getAllProducers(userId);

        emitWebinarAttendeeCountChanged(io, state, context.currentRoom);
        emitWebinarFeedChanged(io, context.currentRoom);

        const webinarSnapshot = toWebinarConfigSnapshot(
          webinarConfig,
          context.currentRoom.getWebinarAttendeeCount(),
        );

        Logger.debug(
          `User ${userId} joined room ${roomId} as ${
            isHost
              ? "Host"
              : context.currentClient.isWebinarAttendee
                ? "WebinarAttendee"
                : "Client"
          }`,
        );

        if (context.currentClient instanceof Admin) {
          registerAdminHandlers(context, { roomId });
        }

        respond(callback, {
          roomId,
          rtpCapabilities: context.currentRoom.rtpCapabilities,
          existingProducers,
          status: "joined",
          hostUserId: context.currentRoom.getHostUserId(),
          isLocked: context.currentRoom.isLocked,
          isTtsDisabled: context.currentRoom.isTtsDisabled,
          meetingRequiresInviteCode: context.currentRoom.requiresMeetingInviteCode,
          webinarRole: context.currentClient.isWebinarAttendee
            ? "attendee"
            : isHost
              ? "host"
              : "participant",
          isWebinarEnabled: webinarSnapshot.enabled,
          webinarLocked: webinarSnapshot.locked,
          webinarRequiresInviteCode: webinarSnapshot.requiresInviteCode,
          webinarAttendeeCount: webinarSnapshot.attendeeCount,
          webinarMaxAttendees: webinarSnapshot.maxAttendees,
        });
      } catch (error) {
        Logger.error("Error joining room:", error);
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};

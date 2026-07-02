import { Admin } from "../../../config/classes/Admin.js";
import { Client } from "../../../config/classes/Client.js";
import { config } from "../../../config/config.js";
import type {
  AppsAwarenessData,
  HandRaisedSnapshot,
  JoinRoomData,
  JoinRoomErrorResponse,
  JoinRoomResponse,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { MAX_DISPLAY_NAME_LENGTH } from "../../constants.js";
import {
  buildUserIdentity,
  isGuestUserKey,
  normalizeDisplayName,
} from "../../identity.js";
import {
  cleanupRoom,
  cleanupStaleRoom,
  clearEndedRoom,
  getEndedRoom,
  getOrCreateRoom,
  getRoomChannelId,
} from "../../rooms.js";
import {
  RoomOwnershipError,
  type RoomOwnerRecord,
} from "../../roomRegistry.js";
import {
  emitWebinarAttendeeCountChanged,
  emitWebinarFeedChanged,
} from "../../webinarNotifications.js";
import {
  getOrCreateWebinarRoomConfig,
  normalizeHostEmail,
  resolveWebinarLinkTarget,
  toWebinarConfigSnapshot,
  verifyInviteCode,
} from "../../webinar.js";
import {
  getScheduledWebinarForRoom,
  getScheduledWebinarBySlug,
  isWithinEarlyEntryWindow,
  persistScheduledWebinarChanges,
  recordWebinarJoin,
} from "../../scheduledWebinars.js";
import { ensureWebinarRoomConfig } from "../../scheduledWebinarScheduler.js";
import { getSocketAuthUser } from "../auth.js";
import type { ConnectionContext } from "../context.js";
import { registerAdminHandlers } from "./adminHandlers.js";
import { respond } from "./ack.js";
import { emitChatHistorySnapshot } from "./chatHistory.js";
import { emitGameSnapshot } from "./gameHandlers.js";
import {
  clearBrowserState,
  getBrowserState,
} from "./sharedBrowserHandlers.js";

const MAX_CLIENT_ID_LENGTH = 256;
const MAX_ROOM_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_INVITE_CODE_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizeIdentifier = (
  value: unknown,
  maxLength: number,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
};

export const registerJoinRoomHandler = (context: ConnectionContext): void => {
  const { socket, io, state } = context;

  socket.on(
    "joinRoom",
    async (
      data: JoinRoomData,
      callback: (response: JoinRoomResponse | JoinRoomErrorResponse) => void,
    ) => {
      try {
        const requestedRoomId = normalizeIdentifier(
          data?.roomId,
          MAX_ROOM_ID_LENGTH,
        );
        let sessionId: string | undefined;
        const user = getSocketAuthUser(socket);
        if (!requestedRoomId) {
          respond(callback, { error: "Missing room ID" });
          return;
        }
        if (data?.sessionId !== undefined) {
          const normalizedSessionId = normalizeIdentifier(
            data.sessionId,
            MAX_SESSION_ID_LENGTH,
          );
          if (!normalizedSessionId) {
            respond(callback, { error: "Invalid session ID" });
            return;
          }
          sessionId = normalizedSessionId;
        }
        const joinMode =
          user?.joinMode === "webinar_attendee"
            ? "webinar_attendee"
            : "meeting";
        const isWebinarAttendeeJoin = joinMode === "webinar_attendee";
        const requestedGhostJoin =
          !isWebinarAttendeeJoin && data?.ghost === true;
        const canJoinAsGhost =
          requestedGhostJoin && user?.canGhostJoin === true;
        if (requestedGhostJoin && !canJoinAsGhost) {
          respond(callback, { error: "Ghost mode is not available for this session" });
          return;
        }
        const tokenClientId =
          typeof user?.clientId === "string"
            ? normalizeIdentifier(user.clientId, MAX_CLIENT_ID_LENGTH)
            : "default";
        if (!tokenClientId) {
          respond(callback, { error: "Invalid client ID" });
          return;
        }
        const clientId = tokenClientId;
        let roomId = requestedRoomId;
        if (isWebinarAttendeeJoin) {
          let webinarTarget = resolveWebinarLinkTarget(
            state.webinarLinks,
            requestedRoomId,
            clientId,
          );
          if (!webinarTarget) {
            const scheduledWebinar = getScheduledWebinarBySlug(
              state.scheduledWebinars,
              requestedRoomId,
            );
            const canRebindScheduledLink =
              scheduledWebinar &&
              scheduledWebinar.clientId === clientId &&
              scheduledWebinar.status !== "ended" &&
              scheduledWebinar.status !== "cancelled" &&
              isWithinEarlyEntryWindow(scheduledWebinar);
            if (canRebindScheduledLink) {
              ensureWebinarRoomConfig(state, scheduledWebinar, null);
              webinarTarget = resolveWebinarLinkTarget(
                state.webinarLinks,
                requestedRoomId,
                clientId,
              );
            }
          }
          if (!webinarTarget) {
            respond(callback, { error: "Webinar is not live." });
            return;
          }
          roomId = webinarTarget.roomId;
        }

        let scheduledWebinarForRoom: ReturnType<
          typeof getScheduledWebinarForRoom
        > = null;
        if (!isWebinarAttendeeJoin) {
          scheduledWebinarForRoom = getScheduledWebinarForRoom(
            state.scheduledWebinars,
            clientId,
            roomId,
          );
          if (
            scheduledWebinarForRoom &&
            scheduledWebinarForRoom.status !== "ended" &&
            scheduledWebinarForRoom.status !== "cancelled"
          ) {
            ensureWebinarRoomConfig(state, scheduledWebinarForRoom, null);
          }
        }

        const resolvedChannelId = getRoomChannelId(clientId, roomId);
        const preexistingWebinarConfig =
          state.webinarConfigs.get(resolvedChannelId);
        const normalizedJoinEmail = normalizeHostEmail(
          typeof user?.email === "string" ? user.email : "",
        );
        const scheduledForcedHost =
          !isWebinarAttendeeJoin &&
          Boolean(normalizedJoinEmail) &&
          Boolean(
            preexistingWebinarConfig?.forcedHostEmails?.has?.(normalizedJoinEmail),
          );
        const forcedHostJoin =
          !isWebinarAttendeeJoin &&
          (Boolean(user?.isForcedHost) || scheduledForcedHost);

        const hostRequested =
          !isWebinarAttendeeJoin &&
          (Boolean(user?.isHost ?? user?.isAdmin ?? user?.isForcedHost) ||
            scheduledForcedHost);
        const allowRoomCreation =
          !isWebinarAttendeeJoin &&
          (Boolean(user?.allowRoomCreation) || scheduledForcedHost);
        const isActiveScheduledWebinarRoom =
          Boolean(scheduledWebinarForRoom) &&
          scheduledWebinarForRoom?.status !== "ended" &&
          scheduledWebinarForRoom?.status !== "cancelled";
        if (
          isActiveScheduledWebinarRoom &&
          !forcedHostJoin &&
          !hostRequested
        ) {
          respond(callback, {
            error: "Use the public webinar link to join as an attendee.",
          });
          return;
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

        const identity = buildUserIdentity(user ?? {}, sessionId, socket.id);
        if (!identity) {
          respond(callback, {
            error: "Authentication error: Invalid token payload",
          });
          return;
        }
        const tokenSessionId = normalizeIdentifier(
          user?.sessionId,
          MAX_SESSION_ID_LENGTH,
        );
        if (tokenSessionId && sessionId && tokenSessionId !== sessionId) {
          respond(callback, { error: "Session mismatch" });
          return;
        }

        const { userKey, userId } = identity;
        const roomChannelId = getRoomChannelId(clientId, roomId);
        let room = state.rooms.get(roomChannelId);
        let createdRoom = false;
        const respondWithRoomOwner = (owner: RoomOwnerRecord): void => {
          Logger.info(
            `Join for ${roomId} (${clientId}) routed to SFU instance ${owner.instanceId}`,
          );
          respond(callback, {
            error: "Room is hosted by another SFU instance.",
            roomId: owner.roomId,
            redirectInstanceId: owner.instanceId,
            ...(owner.instanceUrl ? { redirectUrl: owner.instanceUrl } : {}),
          } satisfies JoinRoomErrorResponse);
        };

        if (room?.router.closed) {
          cleanupStaleRoom(state, roomChannelId);
          room = undefined;
        }

        const endedRoom = getEndedRoom(state, roomChannelId);
        const canReopenEndedRoom =
          Boolean(endedRoom) &&
          !room &&
          !isWebinarAttendeeJoin &&
          (hostRequested || allowRoomCreation);

        if (endedRoom && !canReopenEndedRoom) {
          Logger.info(`Join denied for ended room ${roomId} (${clientId})`);
          respond(callback, { error: endedRoom.message });
          return;
        }

        if (room) {
          try {
            room = await getOrCreateRoom(state, clientId, roomId);
          } catch (error) {
            if (error instanceof RoomOwnershipError) {
              respondWithRoomOwner(error.owner);
              return;
            }
            throw error;
          }
        }

        if (!room) {
          const owner = await state.roomRegistry.getOwner(roomChannelId);
          if (owner && !state.roomRegistry.isLocalOwner(owner)) {
            respondWithRoomOwner(owner);
            return;
          }

          if (isWebinarAttendeeJoin) {
            respond(callback, { error: "Webinar is not live." });
            return;
          }
          if (canJoinAsGhost) {
            respond(callback, { error: "No room found." });
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
          try {
            room = await getOrCreateRoom(state, clientId, roomId);
          } catch (error) {
            if (error instanceof RoomOwnershipError) {
              respondWithRoomOwner(error.owner);
              return;
            }
            throw error;
          }
          if (canReopenEndedRoom) {
            clearEndedRoom(state, roomChannelId);
            Logger.info(
              `Re-opened ended room ${roomId} (${clientId}) for ${userId}`,
            );
          }
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

          let inviteCode = "";
          if (data?.webinarInviteCode !== undefined) {
            const normalizedInviteCode = normalizeIdentifier(
              data.webinarInviteCode,
              MAX_INVITE_CODE_LENGTH,
            );
            if (!normalizedInviteCode) {
              respond(callback, { error: "Invalid webinar invite code." });
              return;
            }
            inviteCode = normalizedInviteCode;
          }
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

        const existingClient = room.getClient(userId);
        const staleSameIdentitySeats = Array.from(
          room.userKeysById.entries(),
        )
          .flatMap(([candidateUserId, candidateUserKey]) => {
            if (candidateUserId === userId || candidateUserKey !== userKey) {
              return [];
            }
            const candidateClient = room.getClient(candidateUserId);
            if (
              !(
                room.hasPendingDisconnect(candidateUserId) ||
                candidateClient?.socket.connected === false
              )
            ) {
              return [];
            }
            return [
              {
                userId: candidateUserId,
                isMeetingParticipant: Boolean(
                  candidateClient && !candidateClient.isObserver,
                ),
                isWebinarAttendee: Boolean(candidateClient?.isWebinarAttendee),
              },
            ];
          });
        const pendingDisconnectStartedAt =
          room.getPendingDisconnectStartedAt(userId);
        const wasReconnectNoticeEmitted =
          room.wasPendingDisconnectNotified(userId);
        const wasReconnecting = room.clearPendingDisconnect(userId);
        const isReplacingExistingSeat =
          Boolean(existingClient) || staleSameIdentitySeats.length > 0;
        const isSameSessionMeetingParticipantRejoin =
          !isWebinarAttendeeJoin &&
          Boolean(
            wasReconnecting || (existingClient && !existingClient.isObserver),
          );
        const reclaimingWebinarSeat =
          isWebinarAttendeeJoin &&
          Boolean(
            existingClient?.isWebinarAttendee ||
              staleSameIdentitySeats.some((seat) => seat.isWebinarAttendee),
          );

        const removeClientForRejoin = (
          targetUserId: string,
          options?: { notifyPeers?: boolean },
        ) => {
          const client = room.getClient(targetUserId);
          if (!client) return;

          const awarenessRemovals = room.clearUserAwareness(targetUserId);
          if (!client.isGhost) {
            for (const removal of awarenessRemovals) {
              io.to(roomChannelId).emit("apps:awareness", {
                appId: removal.appId,
                awarenessUpdate: removal.awarenessUpdate,
              } satisfies AppsAwarenessData);
            }
          }

          room.removeClient(targetUserId);

          if (!options?.notifyPeers) return;
          if (!client.isGhost && !client.isWebinarAttendee) {
            io.to(roomChannelId).emit("userLeft", {
              userId: targetUserId,
              roomId: room.id,
            });
          }
        };

        if (
          isWebinarAttendeeJoin &&
          !reclaimingWebinarSeat &&
          room.getWebinarAttendeeCount() >= webinarConfig.maxAttendees
        ) {
          respond(callback, { error: "Webinar is full." });
          return;
        }

        const isReturningPrimaryHost =
          !isWebinarAttendeeJoin &&
          Boolean(room.hostUserKey) &&
          room.hostUserKey === userKey;
        const isPersistedAdminForExistingRoom =
          !isWebinarAttendeeJoin && room.isAdminUserKey(userKey);
        const isAdminForExistingRoom =
          !isWebinarAttendeeJoin &&
          (isReturningPrimaryHost ||
            isPersistedAdminForExistingRoom ||
            (hostRequested &&
              (clientPolicy.allowHostJoin || forcedHostJoin)));
        const isGhost = canJoinAsGhost;
        const isAdminJoin = isWebinarAttendeeJoin || isGhost
          ? false
          : createdRoom
            ? true
            : isAdminForExistingRoom;
        const hasPrivilegedJoinAccess = isAdminJoin || isGhost;

        if (!hasPrivilegedJoinAccess && room.isBlocked(userKey)) {
          Logger.info(`Blocked identity ${userKey} denied access to room ${roomId}`);
          respond(callback, { error: "You are not allowed to join this meeting." });
          return;
        }

        let meetingInviteCode = "";
        if (data?.meetingInviteCode !== undefined) {
          const normalizedInviteCode = normalizeIdentifier(
            data.meetingInviteCode,
            MAX_INVITE_CODE_LENGTH,
          );
          if (!normalizedInviteCode) {
            respond(callback, { error: "Invalid meeting invite code." });
            return;
          }
          meetingInviteCode = normalizedInviteCode;
        }
        const requiresMeetingInviteCode = room.requiresMeetingInviteCode;
        const shouldValidateMeetingInviteCode =
          !isWebinarAttendeeJoin &&
          !hasPrivilegedJoinAccess &&
          requiresMeetingInviteCode &&
          !isSameSessionMeetingParticipantRejoin;

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

        if (isAdminJoin) {
          room.registerAdminUserKey(userKey);
        }
        if (isAdminJoin && !room.hostUserKey) {
          room.hostUserKey = userKey;
        }
        const isPrimaryHost = room.hostUserKey === userKey;

        if (
          !isWebinarAttendeeJoin &&
          room.noGuests &&
          !hasPrivilegedJoinAccess &&
          isGuestUserKey(userKey)
        ) {
          Logger.info(
            `Guest ${userKey} blocked from room ${roomId} (no guests allowed).`,
          );
          respond(callback, { error: "Guests are not allowed in this meeting." });
          return;
        }

        if (isAdminJoin) {
          socket.emit("hostAssigned", {
            roomId,
            hostUserId: room.getHostUserId() ?? (isPrimaryHost ? userId : null),
          });
        }

        if (isAdminForExistingRoom && room.cleanupTimer) {
          Logger.info(`Host returning to room ${roomId}, cleanup cancelled.`);
          room.stopCleanupTimer();
        }

        const canSetDisplayName = Boolean(
          !isWebinarAttendeeJoin &&
            (clientPolicy.allowDisplayNameUpdate || isAdminJoin),
        );
        const requestedDisplayName =
          canSetDisplayName && displayNameCandidate ? displayNameCandidate : "";
        const displayName = requestedDisplayName || identity.displayName;
        const hasDisplayNameOverride = Boolean(requestedDisplayName);
        context.currentUserKey = userKey;

        if (
          !isWebinarAttendeeJoin &&
          room.isLocked &&
          !hasPrivilegedJoinAccess &&
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
            hostUserIds: room.getAdminUserIds(),
            isLocked: room.isLocked,
            isTtsDisabled: room.isTtsDisabled,
            isChatLocked: room.isChatLocked,
            isDmEnabled: room.isDmEnabled,
            isReactionsDisabled: room.isReactionsDisabled,
            meetingRequiresInviteCode: room.requiresMeetingInviteCode,
          });
          return;
        }

        if (
          !isWebinarAttendeeJoin &&
          clientPolicy.useWaitingRoom &&
          !hasPrivilegedJoinAccess &&
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
            hostUserIds: room.getAdminUserIds(),
            isLocked: room.isLocked,
            isTtsDisabled: room.isTtsDisabled,
            isChatLocked: room.isChatLocked,
            isDmEnabled: room.isDmEnabled,
            isReactionsDisabled: room.isReactionsDisabled,
            meetingRequiresInviteCode: room.requiresMeetingInviteCode,
          });
          return;
        }

        for (const { userId: staleUserId } of staleSameIdentitySeats) {
          Logger.warn(
            `Reclaiming stale session ${staleUserId} for identity ${userKey} in room ${roomId}`,
          );
          removeClientForRejoin(staleUserId, { notifyPeers: true });
        }

        if (existingClient) {
          Logger.warn(`User ${userId} re-joining room ${roomId}`);
          removeClientForRejoin(userId);
        }

        const browserState = getBrowserState(roomChannelId);
        if (
          browserState.active &&
          room.clients.size === 0 &&
          !isReplacingExistingSeat
        ) {
          Logger.info(
            `[SharedBrowser] Clearing stale browser session for empty room ${roomId}`,
          );
          clearBrowserState(roomChannelId);
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
          if (!context.currentClient.isGhost) {
            for (const removal of awarenessRemovals) {
              socket.to(previousChannelId).emit("apps:awareness", {
                appId: removal.appId,
                awarenessUpdate: removal.awarenessUpdate,
              } satisfies AppsAwarenessData);
            }
          }

          previousRoom.removeClient(previousClientId);

          if (!context.currentClient.isGhost && !context.currentClient.isWebinarAttendee) {
            socket
              .to(previousChannelId)
              .emit("userLeft", {
                userId: previousClientId,
                roomId: previousRoom.id,
              });
          }

          if (!context.currentClient.isGhost) {
            emitWebinarAttendeeCountChanged(io, state, previousRoom);
            emitWebinarFeedChanged(io, state, previousRoom);
          }

          await socket.leave(previousChannelId);
          cleanupRoom(state, previousChannelId);

          context.currentRoom = null;
          context.currentClient = null;
        }

        context.currentRoom = room;
        context.currentRoom.setWebinarFeedRefreshNotifier((targetRoom) => {
          emitWebinarFeedChanged(io, state, targetRoom);
        });
        context.pendingRoomId = null;
        context.pendingRoomChannelId = null;
        context.pendingUserKey = null;

        if (isAdminJoin) {
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

        await socket.join(roomChannelId);

        if (!context.currentClient.isGhost) {
          io.to(roomChannelId).emit("hostChanged", {
            roomId: context.currentRoom.id,
            hostUserId: context.currentRoom.getHostUserId(),
          });
          io.to(roomChannelId).emit("adminUsersChanged", {
            roomId: context.currentRoom.id,
            hostUserIds: context.currentRoom.getAdminUserIds(),
          });
        }

        if (context.currentClient instanceof Admin && !context.currentClient.isObserver) {
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
            // Ghost joins are intentionally invisible to every other room socket.
          } else if (!context.currentClient.isWebinarAttendee) {
            for (const [clientId, client] of context.currentRoom.clients) {
              if (clientId === userId) {
                continue;
              }
              if (client.isWebinarAttendee) {
                client.socket.emit("webinar:participantJoined", {
                  userId,
                  displayName: resolvedDisplayName,
                  roomId: context.currentRoom.id,
                });
                continue;
              }
              client.socket.emit("userJoined", {
                userId,
                displayName: resolvedDisplayName,
                roomId: context.currentRoom.id,
              });
            }
          }
        } else if (wasReconnectNoticeEmitted) {
          Logger.info(`User ${userId} reconnected to room ${roomId}.`);
          if (
            context.currentClient &&
            !context.currentClient.isGhost &&
            !context.currentClient.isWebinarAttendee
          ) {
            io.to(roomChannelId).emit("participantConnectionState", {
              userId,
              roomId: context.currentRoom.id,
              state: "reconnected",
              downtimeMs: pendingDisconnectStartedAt
                ? Date.now() - pendingDisconnectStartedAt
                : undefined,
              updatedAt: Date.now(),
            });
          }
        }

        const displayNameSnapshot = context.currentRoom.getDisplayNameSnapshot({
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

        if (context.currentClient instanceof Admin && !context.currentClient.isObserver) {
          emitChatHistorySnapshot(socket, context.currentRoom);
        }

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

        socket.emit("dmStateChanged", {
          enabled: context.currentRoom.isDmEnabled,
          roomId: context.currentRoom.id,
        });

        socket.emit("reactionsDisabledChanged", {
          disabled: context.currentRoom.isReactionsDisabled,
          roomId: context.currentRoom.id,
        });

        socket.emit("apps:state", {
          activeAppId: context.currentRoom.appsState.activeAppId,
          locked: context.currentRoom.appsState.locked,
          roomId: context.currentRoom.id,
        });
        emitGameSnapshot(socket, context.currentRoom, context.currentClient.id);

        const newQuality = context.currentRoom.updateVideoQuality();
        if (newQuality) {
          io.to(roomChannelId).emit("setVideoQuality", {
            quality: newQuality,
            roomId: context.currentRoom.id,
          });
        } else if (context.currentRoom.currentQuality === "low") {
          socket.emit("setVideoQuality", {
            quality: "low",
            roomId: context.currentRoom.id,
          });
        }

        const feedSnapshot = context.currentRoom.refreshWebinarFeedSnapshot();
        const existingProducers = context.currentClient.isWebinarAttendee
          ? feedSnapshot.producers
          : context.currentRoom.getAllProducers(userId);

        if (!context.currentClient.isGhost) {
          emitWebinarAttendeeCountChanged(io, state, context.currentRoom);
          emitWebinarFeedChanged(io, state, context.currentRoom);
        }

        if (
          webinarConfig.scheduledWebinarId &&
          !wasReconnecting &&
          !existingClient &&
          !context.currentClient.isGhost
        ) {
          const attendeeCount = context.currentRoom.getWebinarAttendeeCount();
          const webinarWithJoinMetric = recordWebinarJoin(
            state.scheduledWebinars,
            webinarConfig.scheduledWebinarId,
            attendeeCount,
          );
          if (state.scheduledWebinarPersistence && webinarWithJoinMetric) {
            try {
              persistScheduledWebinarChanges(
                state.scheduledWebinars,
                state.scheduledWebinarPersistence,
                [webinarWithJoinMetric],
              );
            } catch (error) {
              Logger.warn("Failed to persist join metric", error);
            }
          }
        }

        const webinarSnapshot = toWebinarConfigSnapshot(
          webinarConfig,
          context.currentRoom.getWebinarAttendeeCount(),
        );

        Logger.debug(
          `User ${userId} joined room ${roomId} as ${
            isAdminJoin
              ? "Host"
              : context.currentClient.isWebinarAttendee
                ? "WebinarAttendee"
                : "Client"
          }`,
        );

        if (context.currentClient instanceof Admin && !context.currentClient.isObserver) {
          registerAdminHandlers(context, { roomId });
        }

        respond(callback, {
          roomId,
          rtpCapabilities: context.currentRoom.rtpCapabilities,
          existingProducers,
          ...(context.currentRoom.isMeetingActiveSpeakerSignalAvailable
            ? { activeSpeakerId: context.currentRoom.activeSpeakerUserId }
            : {}),
          displayNameSnapshot,
          status: "joined",
          hostUserId: context.currentRoom.getHostUserId(),
          hostUserIds: context.currentRoom.getAdminUserIds(),
          isLocked: context.currentRoom.isLocked,
          isTtsDisabled: context.currentRoom.isTtsDisabled,
          isChatLocked: context.currentRoom.isChatLocked,
          isDmEnabled: context.currentRoom.isDmEnabled,
          isReactionsDisabled: context.currentRoom.isReactionsDisabled,
          meetingRequiresInviteCode: context.currentRoom.requiresMeetingInviteCode,
          webinarRole: context.currentClient.isWebinarAttendee
            ? "attendee"
            : isAdminJoin
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

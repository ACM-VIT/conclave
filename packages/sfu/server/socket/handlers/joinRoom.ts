import { readAiEnvironment } from "@conclave/ai/models";
import { parseGuestJoinClaims } from "@conclave/meeting-core/guest-join-claims";
import { Admin } from "../../../config/classes/Admin.js";
import { Client } from "../../../config/classes/Client.js";
import type { Room } from "../../../config/classes/Room.js";
import { config } from "../../../config/config.js";
import type {
  AppsAwarenessData,
  HandRaisedSnapshot,
  JoinRoomData,
  JoinRoomErrorResponse,
  JoinRoomResponse,
  ScheduledWebinar,
} from "../../../types.js";
import { Logger } from "../../../utilities/loggers.js";
import { canonicalizeClientId } from "../../clientIds.js";
import { MAX_DISPLAY_NAME_LENGTH } from "../../constants.js";
import {
  buildUserIdentity,
  isGuestUserKey,
  seatIdOf,
  normalizeDisplayName,
} from "../../identity.js";
import {
  cleanupRoom,
  cleanupStaleRoom,
  clearEndedRoom,
  getEndedRoom,
  getOrCreateRoomWithOrigin,
  renewLocalRoom,
  getRoomChannelId,
} from "../../rooms.js";
import {
  RoomOwnershipError,
  type RoomAssignmentRecord,
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
  resolveScheduledWebinarAttendeeEntry,
} from "../../scheduledWebinars.js";
import {
  recordWebinarJoin,
  webinarBySlug,
  webinarForRoom,
} from "../../controlPlane/webinarCommands.js";
import { ensureWebinarRoomConfig, notifyRoomConfig } from "../../scheduledWebinarScheduler.js";
import {
  answerSettledRequests,
  handOffRoom,
  publishLobby,
  removeBlockedGuest,
  teardownClient,
  withdrawWaitingRequest,
} from "../../admin/controlPlane.js";
import { emitToHost } from "../../admin/hostOnlyEvents.js";
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
const MAX_ADMISSION_CODE_LENGTH = 128;
const GUEST_NOT_VERIFIED_ERROR =
  "This guest session could not be verified. Reload the page to join again.";
const WAITING_ROOM_FULL_ERROR =
  "The waiting room is full. Try again in a moment.";
const MEETING_FULL_ERROR = "This meeting is full.";

// A new request to be let in past the room's limit is refused. A tab that
// already waits keeps its place.
const isWaitingRoomFull = (room: Room, userKey: string): boolean =>
  !room.pendingClients.has(userKey) &&
  room.pendingClients.size >= config.waitingRequestLimit;
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

const JOIN_SUPERSEDED_ERROR = "A newer join for this tab took its place.";

type JoinAttempts = {
  byTab: Map<string, { seated: number; inFlight: number }>;
  byRoom: Map<string, number>;
  unclaimedRooms: Map<string, string>;
  turns: Map<string, Promise<void>>;
};
const joinAttemptsByState = new WeakMap<ConnectionContext["state"], JoinAttempts>();
let joinAttemptCount = 0;

const attemptsOf = (state: ConnectionContext["state"]): JoinAttempts => {
  let attempts = joinAttemptsByState.get(state);
  if (!attempts) {
    attempts = { byTab: new Map(), byRoom: new Map(), unclaimedRooms: new Map(), turns: new Map() };
    joinAttemptsByState.set(state, attempts);
  }
  return attempts;
};

const beginJoinAttempt = (
  state: ConnectionContext["state"],
  channelId: string,
  key: string,
): number => {
  const attempts = attemptsOf(state);
  const record = attempts.byTab.get(key);
  if (record) record.inFlight += 1;
  else attempts.byTab.set(key, { seated: 0, inFlight: 1 });
  attempts.byRoom.set(channelId, (attempts.byRoom.get(channelId) ?? 0) + 1);
  return (joinAttemptCount += 1);
};

const takeJoinTurn = async (
  state: ConnectionContext["state"],
  tab: string,
): Promise<() => void> => {
  const turns = attemptsOf(state).turns;
  const earlier = turns.get(tab);
  let end!: () => void;
  const mine = new Promise<void>((resolve) => {
    end = resolve;
  });
  const queued = (earlier ?? Promise.resolve()).then(() => mine);
  turns.set(tab, queued);
  void queued.then(() => {
    if (turns.get(tab) === queued) turns.delete(tab);
  });
  await earlier;
  return end;
};

const endJoinAttempt = (
  context: ConnectionContext,
  channelId: string,
  key: string,
): void => {
  const attempts = attemptsOf(context.state);
  const record = attempts.byTab.get(key);
  if (record) {
    record.inFlight -= 1;
    if (record.inFlight <= 0) attempts.byTab.delete(key);
  }
  const inRoom = (attempts.byRoom.get(channelId) ?? 1) - 1;
  if (inRoom > 0) {
    attempts.byRoom.set(channelId, inRoom);
    return;
  }
  attempts.byRoom.delete(channelId);
  if (!attempts.unclaimedRooms.delete(channelId)) return;
  const room = context.state.rooms.get(channelId);
  if (!room) return;
  if (room.isEmpty()) {
    cleanupRoom(context.state, channelId);
  } else if (!room.hasActiveAdmin()) {
    handOffRoom(context.io, context.state, room);
  }
};

export const registerJoinRoomHandler = (context: ConnectionContext): void => {
  const { socket, io, state } = context;

  socket.on(
    "joinRoom",
    async (
      data: JoinRoomData,
      callback: (response: JoinRoomResponse | JoinRoomErrorResponse) => void,
    ) => {
      let attemptKey: string | null = null;
      let attemptRoom: string | null = null;
      let endJoinTurn = (): void => {};
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
        const tokenClientId =
          typeof user?.clientId === "string"
            ? normalizeIdentifier(user.clientId, MAX_CLIENT_ID_LENGTH)
            : "default";
        if (!tokenClientId) {
          respond(callback, { error: "Invalid client ID" });
          return;
        }
        const clientId = canonicalizeClientId(tokenClientId);

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
        const guestClaims = isGuestUserKey(userKey)
          ? parseGuestJoinClaims(user)
          : null;
        if (isGuestUserKey(userKey) && !guestClaims) {
          respond(callback, { error: GUEST_NOT_VERIFIED_ERROR });
          return;
        }
        // A guest's seat key is issued for one room. Its token joins that
        // room and no other, whatever room this call names.
        if (
          guestClaims?.scope === "room" &&
          guestClaims.guestRoom !== requestedRoomId
        ) {
          respond(callback, {
            error:
              "This join token is for another meeting. Reload the page to join again.",
          });
          return;
        }

        endJoinTurn = await takeJoinTurn(state, userId);
        let roomId = requestedRoomId;
        let scheduledWebinarForAttendee: ReturnType<
          typeof resolveScheduledWebinarAttendeeEntry
        >["webinar"] = null;
        if (isWebinarAttendeeJoin) {
          const scheduledEntry = resolveScheduledWebinarAttendeeEntry(
            await state.controlPlane.read(webinarBySlug(requestedRoomId)),
            clientId,
          );
          if (scheduledEntry.kind === "closed") {
            respond(callback, { error: "Webinar is not live." });
            return;
          }
          scheduledWebinarForAttendee = scheduledEntry.webinar;
          let webinarTarget = resolveWebinarLinkTarget(
            state.webinarLinks,
            requestedRoomId,
            clientId,
          );
          if (scheduledWebinarForAttendee) {
            // A scheduled webinar's link always leads to its own room. Another
            // room that bound the same code (before the scheduler did, e.g.
            // after a restart) must not receive the webinar's audience.
            if (webinarTarget?.roomId !== scheduledWebinarForAttendee.roomId) {
              ensureWebinarRoomConfig(state, scheduledWebinarForAttendee, notifyRoomConfig(state, () => io));
            }
            webinarTarget = {
              roomChannelId: getRoomChannelId(
                scheduledWebinarForAttendee.clientId,
                scheduledWebinarForAttendee.roomId,
              ),
              roomId: scheduledWebinarForAttendee.roomId,
              clientId: scheduledWebinarForAttendee.clientId,
            };
          }
          if (!webinarTarget) {
            respond(callback, { error: "Webinar is not live." });
            return;
          }
          roomId = webinarTarget.roomId;
        }

        let scheduledWebinarForRoom: ScheduledWebinar | null = null;
        if (!isWebinarAttendeeJoin) {
          scheduledWebinarForRoom = await state.controlPlane.read(
            webinarForRoom(clientId, roomId),
          );
          if (
            scheduledWebinarForRoom &&
            scheduledWebinarForRoom.status !== "ended" &&
            scheduledWebinarForRoom.status !== "cancelled"
          ) {
            ensureWebinarRoomConfig(state, scheduledWebinarForRoom, notifyRoomConfig(state, () => io));
          }
        }

        if (!socket.connected) return;

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
          (user?.isSuperAdmin === true || Boolean(user?.isForcedHost) || scheduledForcedHost);

        const hostRequested =
          !isWebinarAttendeeJoin &&
          (user?.isSuperAdmin === true ||
            Boolean(user?.isHost ?? user?.isAdmin ?? user?.isForcedHost) ||
            scheduledForcedHost);
        const allowRoomCreation =
          !isWebinarAttendeeJoin &&
          (Boolean(user?.allowRoomCreation) || scheduledForcedHost);
        const isActiveScheduledWebinarRoom =
          Boolean(scheduledWebinarForRoom) &&
          scheduledWebinarForRoom?.status !== "ended" &&
          scheduledWebinarForRoom?.status !== "cancelled";
        // A block follows any proof. A right does not: only a token issued
        // for this room speaks for the guest behind its pass, and so holds
        // what the guest's other tabs hold here, or takes a stage invite.
        const guestProof = guestClaims?.guestProof;
        const roomScopedClaims =
          guestClaims?.scope === "room" ? guestClaims : null;
        const roomGuestProof = roomScopedClaims?.guestProof;
        const otherGuestSeats = roomScopedClaims?.guestWas ?? [];
        // What the token shows of the guest's other passes is decided on,
        // not recorded: only a join that is let in or waits records it
        // (`commitLink` below). A refused join leaves the room as it was,
        // except that a guest a block turns out to cover leaves at once.
        const planLink = (forRoom: Room | undefined) =>
          forRoom && roomGuestProof !== undefined && otherGuestSeats.length > 0
            ? forRoom.planGuestLink(otherGuestSeats, roomGuestProof)
            : undefined;
        const knownRoom = state.rooms.get(resolvedChannelId);
        const earlyLink = planLink(knownRoom);
        if (knownRoom && earlyLink?.blocked) {
          removeBlockedGuest(knownRoom, knownRoom.refuseBlockedLink(earlyLink), {
            io,
            state,
          });
        }
        // A host invite ("bring on stage") lets an attendee identity rejoin as
        // a full participant; the promotion registry lives on the live room.
        // Honored only while webinar mode is on, so a stale invite can never
        // bypass an ordinary meeting's lock or invite code later.
        const isWebinarPromotedJoin =
          !isWebinarAttendeeJoin &&
          Boolean(preexistingWebinarConfig?.enabled) &&
          Boolean(
            state.rooms
              .get(resolvedChannelId)
              ?.hasStageInvite(userKey, roomGuestProof, earlyLink),
          );
        if (
          isActiveScheduledWebinarRoom &&
          !forcedHostJoin &&
          !hostRequested &&
          !isWebinarPromotedJoin
        ) {
          respond(callback, {
            error: "Use the public webinar link to join as an attendee.",
          });
          return;
        }
        // A speaker the host moved back to the audience cannot re-enter as a
        // participant while webinar mode is on; the audience link is the way
        // back in (a fresh stage invite clears the mark).
        if (
          !isWebinarAttendeeJoin &&
          !forcedHostJoin &&
          !hostRequested &&
          Boolean(preexistingWebinarConfig?.enabled) &&
          Boolean(
            state.rooms
              .get(resolvedChannelId)
              ?.isWebinarDemotedUserKey(userKey, guestProof, earlyLink),
          )
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

        const roomChannelId = getRoomChannelId(clientId, roomId);
        const joinKey = `${roomChannelId} ${userId}`;
        attemptKey = joinKey;
        attemptRoom = roomChannelId;
        const attempt = beginJoinAttempt(state, roomChannelId, joinKey);
        endJoinTurn();
        const superseded = (): boolean => {
          if (socket.connected && (attemptsOf(state).byTab.get(joinKey)?.seated ?? 0) <= attempt) {
            return false;
          }
          respond(callback, { error: JOIN_SUPERSEDED_ERROR });
          return true;
        };
        let room = state.rooms.get(roomChannelId);
        let createdRoom = false;
        const respondWithRoomOwner = (owner: RoomAssignmentRecord): void => {
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
            // Renew only. If the room closed during the renewal, fall through
            // to the creation path below, which applies the creation checks
            // and makes this joiner the creator if it creates the room.
            room = (await renewLocalRoom(state, clientId, roomId)) ?? undefined;
            if (superseded()) return;
          } catch (error) {
            if (error instanceof RoomOwnershipError) {
              respondWithRoomOwner(error.owner);
              return;
            }
            throw error;
          }
        }

        if (!room) {
          const assignment = await state.roomRegistry.getAssignment(roomChannelId);
          if (superseded()) return;
          if (assignment && !state.roomRegistry.isLocalOwner(assignment)) {
            respondWithRoomOwner(assignment);
            return;
          }
          const hasReservedLocalPlacement = assignment?.kind === "placement";

          if (isWebinarAttendeeJoin && !scheduledWebinarForAttendee) {
            respond(callback, { error: "Webinar is not live." });
            return;
          }
          if (state.isDraining && !hasReservedLocalPlacement) {
            respond(callback, {
              error: "Meeting server is draining. Try again shortly.",
            });
            return;
          }
          if (
            !scheduledWebinarForAttendee &&
            !hostRequested &&
            !allowRoomCreation &&
            !clientPolicy.allowNonHostRoomCreation
          ) {
            respond(callback, { error: "No room found." });
            return;
          }
          try {
            // Several joiners can miss the lookup above while the room is
            // still being created; only the one whose call created it is the
            // creator (and so the host). The rest join it as an existing room.
            const result = await getOrCreateRoomWithOrigin(
              state,
              clientId,
              roomId,
            );
            room = result.room;
            createdRoom = result.created;
            if (result.created && !isWebinarAttendeeJoin) {
              attemptsOf(state).unclaimedRooms.set(roomChannelId, joinKey);
            }
            if (superseded()) return;
          } catch (error) {
            if (error instanceof RoomOwnershipError) {
              respondWithRoomOwner(error.owner);
              return;
            }
            throw error;
          }
          if (createdRoom && canReopenEndedRoom) {
            clearEndedRoom(state, roomChannelId);
            Logger.info(
              `Re-opened ended room ${roomId} (${clientId}) for ${userId}`,
            );
          }
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

        const guestLink = planLink(room);
        if (guestLink?.blocked && !(room === knownRoom && earlyLink?.blocked)) {
          removeBlockedGuest(room, room.refuseBlockedLink(guestLink), {
            io,
            state,
          });
        }
        const joinedRoom = room;
        const commitLink = () => {
          if (!guestLink) return;
          answerSettledRequests(joinedRoom, joinedRoom.commitGuestLink(guestLink));
        };

        const guestClaim = room.claimGuestIdentity(userKey, guestProof);
        if (!guestClaim.ok) {
          Logger.warn(
            `Join as ${userKey} in room ${roomId} refused: guest pass does not match`,
          );
          respond(callback, { error: GUEST_NOT_VERIFIED_ERROR });
          return;
        }

        // The seats this tab held under the browser's other passes. The tab
        // is back on a new socket, so they are replaced whatever their old
        // sockets look like.
        const formerSeatIds = new Set(
          otherGuestSeats
            .filter((seat) => room.isGuestKeyOfPass(seat.userKey, seat.guestProof))
            .map((seat) => seatIdOf(seat.userKey, identity.sessionId)),
        );
        // A request to be let in that this tab made under another pass is
        // withdrawn now. Left in the lobby, the host would see two requests
        // for one tab, and admitting the old one would answer a dead socket.
        for (const seat of otherGuestSeats) {
          const waiting = room.pendingClients.get(seat.userKey);
          if (
            !waiting ||
            waiting.socket.id === socket.id ||
            waiting.userId !== seatIdOf(seat.userKey, identity.sessionId) ||
            !room.isGuestKeyOfPass(seat.userKey, seat.guestProof)
          ) {
            continue;
          }
          withdrawWaitingRequest(room, seat.userKey);
          waiting.socket.disconnect(true);
        }
        const existingClient = room.getClient(userId);
        const staleSameIdentitySeats = Array.from(
          room.userKeysById.entries(),
        )
          .flatMap(([candidateUserId, candidateUserKey]) => {
            const isFormerSeat = formerSeatIds.has(candidateUserId);
            if (
              candidateUserId === userId ||
              (candidateUserKey !== userKey && !isFormerSeat)
            ) {
              return [];
            }
            const candidateClient = room.getClient(candidateUserId);
            if (
              !(
                isFormerSeat ||
                room.hasPendingDisconnect(candidateUserId) ||
                candidateClient?.socket.connected === false
              )
            ) {
              return [];
            }
            return [
              {
                userId: candidateUserId,
                isFormerSeat,
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
        // Only peek here: the grace timer is the one thing that removes the
        // old seat if this rejoin is refused or parked in the waiting room
        // below, so it is cancelled only once the join is going through.
        const wasReconnecting = room.hasPendingDisconnect(userId);
        const isReplacingExistingSeat =
          Boolean(existingClient) || staleSameIdentitySeats.length > 0;
        // Only a join that takes the place of a meeting seat keeps the
        // meeting's seat count as it was. One that replaces this tab's
        // audience seat adds a meeting seat.
        const isReplacingMeetingSeat =
          (existingClient !== undefined && !existingClient.isWebinarAttendee) ||
          staleSameIdentitySeats.some((seat) => !seat.isWebinarAttendee);
        const isSameSessionMeetingParticipantRejoin =
          !isWebinarAttendeeJoin &&
          Boolean(
            wasReconnecting ||
              (existingClient && !existingClient.isObserver) ||
              staleSameIdentitySeats.some(
                (seat) => seat.isFormerSeat && seat.isMeetingParticipant,
              ),
          );
        const reclaimingWebinarSeat =
          isWebinarAttendeeJoin &&
          Boolean(
            existingClient?.isWebinarAttendee ||
              staleSameIdentitySeats.some((seat) => seat.isWebinarAttendee),
          );

        let replacedHostSeat = false;
        const removeClientForRejoin = (
          targetUserId: string,
          options?: { notifyPeers?: boolean },
        ) => {
          const client = room.getClient(targetUserId);
          if (!client) return;
          if (client instanceof Admin && !client.isObserver) replacedHostSeat = true;

          const awarenessRemovals = room.clearUserAwareness(targetUserId);
          for (const removal of awarenessRemovals) {
            io.to(roomChannelId).emit("apps:awareness", {
              appId: removal.appId,
              awarenessUpdate: removal.awarenessUpdate,
            } satisfies AppsAwarenessData);
          }

          room.removeClient(targetUserId);
          if (isWebinarAttendeeJoin) {
            state.transcriptRelays
              .releaseSeat({ roomKey: roomChannelId, userId: targetUserId })
              .catch((error) => {
                Logger.warn(
                  `Transcript SFU relay stop for ${targetUserId} in room ${roomChannelId} failed: ${error}`,
                );
              });
          } else {
            state.transcriptRelays.handOver({
              roomKey: roomChannelId,
              fromUserId: targetUserId,
              toUserId: userId,
            });
          }
          if (client.socket.id !== socket.id) {
            client.socket.disconnect(true);
          }

          if (!options?.notifyPeers) return;
          if (!client.isWebinarAttendee) {
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

        // A block comes before every right the room keeps for a rejoin: host,
        // co-host, an admission, a stage invite. The one exemption is an
        // account that is a host by configuration outside the room, which
        // the room also refuses to block or remove.
        if (
          !forcedHostJoin &&
          user?.isSuperAdmin !== true &&
          room.isBlocked(userKey, guestProof, guestLink)
        ) {
          Logger.info(`Blocked identity ${userKey} denied access to room ${roomId}`);
          respond(callback, { error: "You are not allowed to join this meeting." });
          return;
        }

        const isReturningPrimaryHost =
          !isWebinarAttendeeJoin &&
          room.isHostUserKey(userKey, roomGuestProof, guestLink);
        const isPersistedAdminForExistingRoom =
          !isWebinarAttendeeJoin &&
          room.isAdminUserKey(userKey, roomGuestProof, guestLink);
        const isAdminForExistingRoom =
          !isWebinarAttendeeJoin &&
          (isReturningPrimaryHost ||
            isPersistedAdminForExistingRoom ||
            (hostRequested &&
              (clientPolicy.allowHostJoin || forcedHostJoin)));
        const createdBySupersededAttempt =
          attemptsOf(state).unclaimedRooms.get(roomChannelId) === joinKey;
        const isAdminJoin = isWebinarAttendeeJoin
          ? false
          : createdRoom || createdBySupersededAttempt
            ? true
            : isAdminForExistingRoom;
        const hasPrivilegedJoinAccess = isAdminJoin;

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
          !isWebinarPromotedJoin &&
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

        const mayChangeRoster = isAdminJoin ||
          existingClient instanceof Admin ||
          staleSameIdentitySeats.some(({ userId: staleUserId }) =>
            room.getClient(staleUserId) instanceof Admin,
          );
        const previousHostUserId = mayChangeRoster ? room.getHostUserId() : null;
        const previousAdminUserIds = mayChangeRoster ? room.getAdminUserIds() : [];

        if (isAdminJoin) {
          room.registerAdminUserKey(userKey);
        }
        if (isAdminJoin && !room.hostUserKey) {
          room.hostUserKey = userKey;
        }
        const isPrimaryHost = room.isHostUserKey(userKey, roomGuestProof, guestLink);

        if (
          !isWebinarAttendeeJoin &&
          room.noGuests &&
          !hasPrivilegedJoinAccess &&
          !isWebinarPromotedJoin &&
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

        // An admission the host created lets this join past the waiting
        // room and the lock below, and stays with its key.
        const admissionCode = normalizeIdentifier(
          data?.admissionCode,
          MAX_ADMISSION_CODE_LENGTH,
        );
        if (admissionCode && !isWebinarAttendeeJoin && !hasPrivilegedJoinAccess) {
          room.redeemAdmission(admissionCode, userKey, guestProof);
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
          !isWebinarPromotedJoin &&
          !room.isLockedAllowed(userKey, roomGuestProof, guestLink)
        ) {
          if (isWaitingRoomFull(room, userKey)) {
            respond(callback, { error: WAITING_ROOM_FULL_ERROR });
            return;
          }
          commitLink();
          Logger.info(
            `User ${userKey} trying to join locked room ${roomId}, adding to waiting room`,
          );
          room.addPendingClient(
            userKey,
            userId,
            socket,
            displayName,
            guestClaim.bindTo,
          );
          context.pendingRoomId = roomId;
          context.pendingRoomChannelId = roomChannelId;
          context.pendingUserKey = userKey;

          socket.emit("waitingRoomStatus", {
            message:
              "This meeting is locked. Waiting for the host to let you in.",
            roomId,
          });

          // Hosts are shown one request per guest. A second tab of a guest
          // who already waits joins that request without a new knock.
          publishLobby(room, { reason: "locked" });

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
            areImageAttachmentsEnabled: room.areImageAttachmentsEnabled,
            isReactionsDisabled: room.isReactionsDisabled,
            isParticipantUnmuteAllowed: room.isParticipantUnmuteAllowed,
            isParticipantVideoAllowed: room.isParticipantVideoAllowed,
            meetingRequiresInviteCode: room.requiresMeetingInviteCode,
            webcamCodecPolicy: room.webcamCodecPolicy,
          });
          return;
        }

        if (
          !isWebinarAttendeeJoin &&
          clientPolicy.useWaitingRoom &&
          !hasPrivilegedJoinAccess &&
          !isWebinarPromotedJoin &&
          !room.isAllowed(userKey, roomGuestProof, guestLink) &&
          !(
            room.isLocked &&
            room.isLockedAllowed(userKey, roomGuestProof, guestLink)
          )
        ) {
          if (isWaitingRoomFull(room, userKey)) {
            respond(callback, { error: WAITING_ROOM_FULL_ERROR });
            return;
          }
          commitLink();
          Logger.info(`User ${userKey} added to waiting room ${roomId}`);
          room.addPendingClient(
            userKey,
            userId,
            socket,
            displayName,
            guestClaim.bindTo,
          );
          context.pendingRoomId = roomId;
          context.pendingRoomChannelId = roomChannelId;
          context.pendingUserKey = userKey;

          if (!room.hasActiveAdmin()) {
            socket.emit("waitingRoomStatus", {
              message: "No one to let you in.",
              roomId,
            });
          }

          publishLobby(room);

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
            areImageAttachmentsEnabled: room.areImageAttachmentsEnabled,
            isReactionsDisabled: room.isReactionsDisabled,
            isParticipantUnmuteAllowed: room.isParticipantUnmuteAllowed,
            isParticipantVideoAllowed: room.isParticipantVideoAllowed,
            meetingRequiresInviteCode: room.requiresMeetingInviteCode,
            webcamCodecPolicy: room.webcamCodecPolicy,
          });
          return;
        }

        if (
          !isWebinarAttendeeJoin &&
          !hasPrivilegedJoinAccess &&
          !isReplacingMeetingSeat &&
          room.clients.size - room.getWebinarAttendeeCount() >=
            config.meetingSeatLimit
        ) {
          respond(callback, { error: MEETING_FULL_ERROR });
          return;
        }
        commitLink();
        const attempts = attemptsOf(state);
        const tabAttempts = attempts.byTab.get(joinKey);
        if (tabAttempts) tabAttempts.seated = Math.max(tabAttempts.seated, attempt);
        if (isAdminJoin && attempts.unclaimedRooms.get(roomChannelId) === joinKey) {
          attempts.unclaimedRooms.delete(roomChannelId);
        }

        room.clearPendingDisconnect(userId);
        // This tab is let in, so a request it left in the lobby is over.
        // Another tab under the same key keeps its own request.
        if (room.pendingClients.get(userKey)?.userId === userId) {
          withdrawWaitingRequest(room, userKey);
        }

        for (const stale of staleSameIdentitySeats) {
          Logger.warn(
            `Reclaiming stale session ${stale.userId} for identity ${userKey} in room ${roomId}`,
          );
          removeClientForRejoin(stale.userId, { notifyPeers: true });
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

        let previousChannelIdToLeave: string | null = null;
        if (
          context.currentRoom &&
          context.currentRoom.channelId !== roomChannelId &&
          context.currentClient
        ) {
          const previousRoom = context.currentRoom;
          const previousChannelId = previousRoom.channelId;
          const previousClient = context.currentClient;
          const previousClientId = previousClient.id;
          Logger.info(
            `User ${userId} switching from ${previousRoom.id} to ${roomId}`,
          );

          // Leaving for another room ends the seat as a disconnect does: it
          // releases what the seat held there, then hands that room on.
          const previousPeers = socket.to(previousChannelId);
          const { wasAdmin } = teardownClient({
            io,
            state,
            room: previousRoom,
            userId: previousClientId,
            peers: previousPeers,
          });
          if (wasAdmin) {
            handOffRoom(io, state, previousRoom, new Set(), previousPeers);
          }

          previousChannelIdToLeave = previousChannelId;
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
            mediaCapabilities: data?.mediaCapabilities,
          });
        } else if (isWebinarAttendeeJoin) {
          context.currentClient = new Client({
            id: userId,
            socket,
            mode: "webinar_attendee",
            mediaCapabilities: data?.mediaCapabilities,
          });
        } else {
          context.currentClient = new Client({
            id: userId,
            socket,
            mediaCapabilities: data?.mediaCapabilities,
          });
        }

        context.currentRoom.setUserIdentity(userId, userKey, displayName, {
          forceDisplayName: hasDisplayNameOverride,
          guestProof: guestClaim.bindTo,
        });
        context.currentRoom.addClient(context.currentClient);
        if (replacedHostSeat && !room.hasActiveAdmin()) handOffRoom(io, state, room);

        // The previous room's channel is left only now. Nothing awaits between
        // the identity checks above and this seat, so a second join under the
        // same user key is always judged against the seat.
        if (previousChannelIdToLeave) {
          await socket.leave(previousChannelIdToLeave);
          cleanupRoom(state, previousChannelIdToLeave);
          if (superseded()) return;
        }
        await socket.join(roomChannelId);
        if (superseded()) return;

        const hostUserId = room.getHostUserId();
        const hostUserIds = room.getAdminUserIds();
        const hasPeers = room.clients.size > 1;
        const hostChanged = mayChangeRoster && hostUserId !== previousHostUserId;
        const adminsChanged = mayChangeRoster && (
          hostUserIds.length !== previousAdminUserIds.length ||
          previousAdminUserIds.some((id) => !hostUserIds.includes(id))
        );
        (hasPeers && hostChanged ? io.to(roomChannelId) : socket).emit("hostChanged", {
          roomId,
          hostUserId,
        });
        (hasPeers && adminsChanged ? io.to(roomChannelId) : socket).emit("adminUsersChanged", {
          roomId,
          hostUserIds,
        });

        if (context.currentClient instanceof Admin) {
          const pendingUsers = context.currentRoom.waitingGuests().map((pending) => ({
            userId: pending.userKey,
            displayName: pending.displayName || pending.userKey,
          }));
          emitToHost(context.currentClient, "pendingUsersSnapshot", {
            users: pendingUsers,
            roomId: context.currentRoom.id,
          });
        }

        const resolvedDisplayName =
          context.currentRoom.getDisplayNameForUser(userId) || displayName;
        if (!wasReconnecting) {
          if (!context.currentClient.isWebinarAttendee) {
            const usedStageInvites = isWebinarPromotedJoin
              ? context.currentRoom.stageInviteKeys(userKey, roomGuestProof, guestLink)
              : [];
            for (const [clientId, client] of context.currentRoom.clients) {
              if (clientId === userId) {
                continue;
              }
              if (usedStageInvites.length > 0 && client instanceof Admin) {
                emitToHost(client, "webinar:stageInviteUsed", {
                  roomId: context.currentRoom.id,
                  userId,
                  invitedUserKeys: usedStageInvites,
                });
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

        const isModeratorClient =
          context.currentClient instanceof Admin &&
          !context.currentClient.isObserver;
        if (
          webinarConfig.enabled &&
          (isModeratorClient || context.currentClient.isWebinarAttendee)
        ) {
          socket.emit("webinar:qaSnapshot", {
            roomId: context.currentRoom.id,
            entries: context.currentRoom.getWebinarQaSnapshotFor(
              userId,
              isModeratorClient,
            ),
          });
        }
        if (webinarConfig.enabled && context.currentClient instanceof Admin) {
          emitToHost(context.currentClient, "webinar:handQueueChanged", {
            roomId: context.currentRoom.id,
            queue: context.currentRoom.getWebinarHandQueue(),
          });
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
        socket.emit("imageAttachmentsStateChanged", {
          enabled: context.currentRoom.areImageAttachmentsEnabled,
          roomId: context.currentRoom.id,
        });

        socket.emit("reactionsDisabledChanged", {
          disabled: context.currentRoom.isReactionsDisabled,
          roomId: context.currentRoom.id,
        });

        socket.emit("participantMediaPermissionsChanged", {
          unmuteAllowed: context.currentRoom.isParticipantUnmuteAllowed,
          videoAllowed: context.currentRoom.isParticipantVideoAllowed,
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

        emitWebinarAttendeeCountChanged(io, state, context.currentRoom);
        emitWebinarFeedChanged(io, state, context.currentRoom);

        if (
          webinarConfig.scheduledWebinarId &&
          context.currentClient.isWebinarAttendee &&
          !wasReconnecting &&
          !existingClient
        ) {
          const attendeeCount = context.currentRoom.getWebinarAttendeeCount();
          state.controlPlane
            .commit(recordWebinarJoin(webinarConfig.scheduledWebinarId, attendeeCount))
            .catch((error: unknown) => {
              Logger.warn("Failed to record the webinar join metric", error);
            });
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

        // Publish settings only after this socket's room membership is restored.
        // A transport reconnect can happen before joinRoom finishes.
        if (!context.currentClient.isObserver) {
          socket.emit(
            "ai:changed",
            context.currentRoom.aiCredentials.status(readAiEnvironment(process.env)),
          );
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
          hostUserId,
          hostUserIds,
          isLocked: context.currentRoom.isLocked,
          isTtsDisabled: context.currentRoom.isTtsDisabled,
          isChatLocked: context.currentRoom.isChatLocked,
          isDmEnabled: context.currentRoom.isDmEnabled,
          areImageAttachmentsEnabled:
            context.currentRoom.areImageAttachmentsEnabled,
          isReactionsDisabled: context.currentRoom.isReactionsDisabled,
          isParticipantUnmuteAllowed:
            context.currentRoom.isParticipantUnmuteAllowed,
          isParticipantVideoAllowed: context.currentRoom.isParticipantVideoAllowed,
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
          webinarQaEnabled: webinarSnapshot.qaEnabled,
          ...(context.currentClient.isWebinarAttendee
            ? { webinarSpeakerUserId: feedSnapshot.speakerUserId }
            : {}),
          webcamCodecPolicy: context.currentRoom.webcamCodecPolicy,
        });
      } catch (error) {
        Logger.error("Error joining room:", error);
        respond(callback, { error: (error as Error).message });
      } finally {
        endJoinTurn();
        if (attemptKey !== null && attemptRoom !== null) {
          endJoinAttempt(context, attemptRoom, attemptKey);
        }
      }
    },
  );
};

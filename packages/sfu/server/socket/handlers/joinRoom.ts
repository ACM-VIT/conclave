import { readAiEnvironment } from "@conclave/ai/models";
import { parseGuestJoinClaims } from "@conclave/meeting-core/guest-join-claims";
import { Admin } from "../../../config/classes/Admin.js";
import type { Room } from "../../../config/classes/Room.js";
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
  MEETING_ENDED_WHILE_WAITING,
  leaveNextMeetingLobby,
  lobbyGuestOf,
} from "../../nextMeetingLobby.js";
import type { EndedRoom } from "../../state.js";
import { ROOM_OPEN_DEADLINE_MS } from "../../joinDeadlines.js";
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
  getScheduledWebinarForRoom,
  persistScheduledWebinarChanges,
  recordWebinarJoin,
  resolveScheduledWebinarAttendeeEntry,
} from "../../scheduledWebinars.js";
import { ensureWebinarRoomConfig } from "../../scheduledWebinarScheduler.js";
import {
  getScheduledMeetingByRoomCode,
  isScheduledMeetingInvitee,
} from "../../scheduledMeetings.js";
import {
  issueRoomRecoveryPass,
  isRecoveryPassFor,
  provesEarlierRoomMembership,
  ROOM_RECOVERY_PASS_TTL_MS,
} from "../../roomRecoveryPass.js";
import {
  announcePromotedHost,
  answerSettledRequests,
  ensureHost,
  offerLapsedRoom,
  publishLobby,
  removeBlockedGuest,
  settleUnclaimedRoom,
  teardownClient,
  withdrawWaitingRequest,
} from "../../admin/controlPlane.js";
import type { LostRoom, RecalledRoom } from "../../roomRecoveryLedger.js";
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

// Whose code it is, as far as anyone recorded: who booked it, else whoever
// made it, which the recovery record keeps. Undefined when no one recorded.
const recordedOwnerOf = (
  booking: ReturnType<typeof getScheduledMeetingByRoomCode>,
  recalled: RecalledRoom,
): string | null | undefined =>
  booking && booking.status !== "cancelled"
    ? booking.hostEmail
    : recalled.owner
      ? recalled.owner.email
      : undefined;

const JOIN_OVERTAKEN = "A newer join from this connection took over.";

type OpenedRoom = { room: Room; created: boolean };

const ROOM_STILL_OPENING = "The meeting is still opening. Try again in a moment.";
const STILL_OPENING = Symbol("still opening");
const withinOpenDeadline = async <T>(work: Promise<T>): Promise<T | typeof STILL_OPENING> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof STILL_OPENING>((resolve) => {
        timer = setTimeout(() => resolve(STILL_OPENING), ROOM_OPEN_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// The gate a join meets at a code with no live room, in order. Whoever may
// open the code (a host, the account the code belongs to or that booked it,
// a visitor the web lets open rooms) opens it past every refusal after it:
// an end for everyone, or an unknown code.
const decideOpening = async (gate: {
  mayOpen: () => Promise<boolean>;
  ended: EndedRoom | null;
  opensForAnyone: boolean;
}): Promise<{ opens: true } | { opens: false; refusal: string }> => {
  if (await gate.mayOpen()) return { opens: true };
  if (gate.ended) return { opens: false, refusal: gate.ended.message };
  if (gate.opensForAnyone) return { opens: true };
  return { opens: false, refusal: "No room found." };
};

const JOIN_SUPERSEDED_ERROR = "A newer join for this tab took its place.";

type JoinAttempts = {
  byTab: Map<string, { seated: number; inFlight: number }>;
  byRoom: Map<string, number>;
};
const joinAttemptsByState = new WeakMap<ConnectionContext["state"], JoinAttempts>();
let joinAttemptCount = 0;

const attemptsOf = (state: ConnectionContext["state"]): JoinAttempts => {
  let attempts = joinAttemptsByState.get(state);
  if (!attempts) {
    attempts = { byTab: new Map(), byRoom: new Map() };
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

const endJoinAttempt = (context: ConnectionContext, channelId: string, key: string): void => {
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
  const room = context.state.rooms.get(channelId);
  if (room?.awaitingOpener) settleUnclaimedRoom(context.io, context.state, room);
};
export const registerJoinRoomHandler = (context: ConnectionContext): void => {
  const { socket, io, state } = context;

  socket.on(
    "joinRoom",
    async (
      data: JoinRoomData,
      callback: (response: JoinRoomResponse | JoinRoomErrorResponse) => void,
    ) => {
      // Only the newest join this socket asked for acts. One that a newer
      // join overtook while it waited answers so, and changes nothing.
      const attempt = ++context.joinAttempts;
      const overtaken = (): boolean => {
        if (context.joinAttempts === attempt) return false;
        respond(callback, { error: JOIN_OVERTAKEN });
        return true;
      };
      let attemptKey: string | null = null;
      let attemptRoom: string | null = null;
      try {
        // A socket waiting for the next meeting keeps its place while this
        // join is decided, so a room opening meanwhile takes it in.
        const parkedChannelId = context.pendingRoomChannelId;
        const parked =
          parkedChannelId && context.pendingUserKey
            ? lobbyGuestOf(state, parkedChannelId, context.pendingUserKey, socket.id)
            : null;
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

        let roomId = requestedRoomId;
        let scheduledWebinarForAttendee: ReturnType<
          typeof resolveScheduledWebinarAttendeeEntry
        >["webinar"] = null;
        if (isWebinarAttendeeJoin) {
          const scheduledEntry = resolveScheduledWebinarAttendeeEntry(
            state.scheduledWebinars,
            requestedRoomId,
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
              ensureWebinarRoomConfig(state, scheduledWebinarForAttendee, null);
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
        // Asking for another code ends waiting for the next meeting here.
        if (parked && parkedChannelId && parkedChannelId !== roomChannelId) {
          leaveNextMeetingLobby(state, parkedChannelId, parked.userKey, socket.id);
        }
        const joinKey = `${roomChannelId} ${userId}`;
        attemptKey = joinKey;
        attemptRoom = roomChannelId;
        const tabAttempt = beginJoinAttempt(state, roomChannelId, joinKey);
        const superseded = (): boolean => {
          if (socket.connected && (attemptsOf(state).byTab.get(joinKey)?.seated ?? 0) <= tabAttempt) {
            return false;
          }
          respond(callback, { error: JOIN_SUPERSEDED_ERROR });
          return true;
        };
        const stopped = (): boolean => overtaken() || superseded();
        let room = state.rooms.get(roomChannelId);
        let createdRoom = false;
        let lostRoom: LostRoom | null = null;
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

        // A meeting being ended for everyone takes no one in.
        const endedRoom = getEndedRoom(state, roomChannelId) ?? null;
        if (endedRoom && room) {
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
            if (stopped()) return;
          } catch (error) {
            if (error instanceof RoomOwnershipError) {
              respondWithRoomOwner(error.owner);
              return;
            }
            throw error;
          }
        }

        // A guest waiting for the next meeting here may see it open while
        // this retry waits on the registry or the ledger. The room that
        // opened took them into its waiting list, so the live room is read
        // again after every wait: a knock still in its waiting list stands
        // as it is, a guest a host has let in since is seated, and a retry
        // whose tab has gone does nothing. Other joins reach a room opening
        // meanwhile through its creation, once its creator has set it up.
        const openedForThisGuest = (): Room | undefined =>
          parked && parkedChannelId === roomChannelId
            ? state.rooms.get(roomChannelId)
            : undefined;
        const joinOpenedRoom = (opened: Room): OpenedRoom | null => {
          if (!socket.connected) return null;
          if (opened.pendingClients.get(userKey)?.socket.id !== socket.id) {
            return { room: opened, created: false };
          }
          respond(callback, {
            roomId,
            rtpCapabilities: opened.rtpCapabilities,
            existingProducers: [],
            status: "waiting",
            isLocked: opened.isLocked,
          });
          return null;
        };
        // The room for a code with no room here yet: one that opened
        // meanwhile, or this join opens it. Null once the join is answered.
        const findOrOpenRoom = async (): Promise<OpenedRoom | null> => {
          const assignment = await state.roomRegistry.getAssignment(roomChannelId);
          if (stopped()) return null;
          const openedWhileAsking = openedForThisGuest();
          if (openedWhileAsking) return joinOpenedRoom(openedWhileAsking);
          if (assignment && !state.roomRegistry.isLocalOwner(assignment)) {
            respondWithRoomOwner(assignment);
            return null;
          }
          const hasReservedLocalPlacement = assignment?.kind === "placement";

          if (isWebinarAttendeeJoin && !scheduledWebinarForAttendee) {
            respond(callback, { error: "Webinar is not live." });
            return null;
          }
          // Someone waiting for the next meeting who asks again before it is
          // open anywhere the registry knows of keeps their place in the
          // lobby, which nothing took them out of.
          const keepWaiting = (): boolean => {
            if (!parked || parkedChannelId !== roomChannelId) return false;
            socket.emit("waitingRoomStatus", {
              message: MEETING_ENDED_WHILE_WAITING,
              roomId,
            });
            respond(callback, {
              roomId,
              rtpCapabilities: { codecs: [], headerExtensions: [] },
              existingProducers: [],
              status: "waiting",
              isLocked: true,
            });
            return true;
          };
          if (state.isDraining && !hasReservedLocalPlacement) {
            if (keepWaiting()) return null;
            respond(callback, {
              error: "Meeting server is draining. Try again shortly.",
            });
            return null;
          }
          // The account a code belongs to opens it from anywhere: ownership
          // is on the server, not in what a tab remembers.
          const opening = await decideOpening({
            mayOpen: async () =>
              !isWebinarAttendeeJoin &&
              (hostRequested ||
                allowRoomCreation ||
                (Boolean(normalizedJoinEmail) &&
                  recordedOwnerOf(
                    getScheduledMeetingByRoomCode(state.scheduledMeetings, clientId, roomId),
                    await state.roomRecovery.recall(roomChannelId),
                  ) === normalizedJoinEmail)),
            ended: endedRoom,
            opensForAnyone:
              Boolean(scheduledWebinarForAttendee) ||
              clientPolicy.allowNonHostRoomCreation,
          });
          if (stopped()) return null;
          const openedWhileDeciding = openedForThisGuest();
          if (openedWhileDeciding) return joinOpenedRoom(openedWhileDeciding);
          if (!opening.opens) {
            if (keepWaiting()) return null;
            Logger.info(`Join refused for ${roomId} (${clientId}): ${opening.refusal}`);
            respond(callback, { error: opening.refusal });
            return null;
          }
          // Opening the room is its own piece of work, kept on the connection:
          // a newer join from this socket takes it over instead of opening a
          // second one, whether this one is overtaken or answered first.
          const openRoom = async (): Promise<OpenedRoom> => {
            let lost: LostRoom | null = null;
            // Several joiners can miss the lookup above while the room is
            // still being created; only the one whose call created it is the
            // creator (and so the host). The rest join it as an existing room.
            const result = await getOrCreateRoomWithOrigin(
              state,
              clientId,
              roomId,
            );
            const openedRoom = result.room;
            const created = result.created;
            // The recovery record was read once this SFU held the code, so
            // nothing awaits between creating the room and settling who
            // hosts it.
            const recalled = result.recalled;
            if (created && recalled) {
              lost = recalled.lost;
              // A code no one has recorded an owner for is made by this
              // join, and belongs to its account if it is signed in, unless
              // the join brings a recovery pass for the code: then a call ran
              // here before, on an SFU whose record this one cannot read, and
              // nobody here knows whose it was.
              const recordedOwner = recordedOwnerOf(
                getScheduledMeetingByRoomCode(state.scheduledMeetings, clientId, roomId),
                recalled,
              );
              openedRoom.ownerEmail =
                recordedOwner !== undefined
                  ? recordedOwner
                  : isWebinarAttendeeJoin ||
                      isRecoveryPassFor(
                        data?.roomRecoveryPass,
                        roomChannelId,
                        config.sfuSecret,
                      )
                    ? null
                    : normalizedJoinEmail || null;
            }
            if (created && endedRoom) {
              clearEndedRoom(state, roomChannelId);
              Logger.info(
                `Re-opened ended room ${roomId} (${clientId}) for ${userId}`,
              );
            }
            if (created && clientPolicy.knockByDefault) {
              openedRoom.setLocked(true);
            }
            // The SFU lost this call and it is coming back: its hosts are
            // hosts again when they return, and the people a host had put out
            // still have to be let in.
            if (lost) {
              openedRoom.restoreLostCall(lost);
            }
            if (created) {
              openedRoom.armOpeningDeadline(ROOM_OPEN_DEADLINE_MS, () =>
                settleUnclaimedRoom(io, state, openedRoom),
              );
            }
            return { room: openedRoom, created };
          };
          const opened = openRoom();
          opened.catch(() => undefined);
          let found: OpenedRoom | typeof STILL_OPENING;
          try {
            found = await withinOpenDeadline(opened);
          } catch (error) {
            if (error instanceof RoomOwnershipError) {
              respondWithRoomOwner(error.owner);
              return null;
            }
            throw error;
          }
          if (found === STILL_OPENING) {
            respond(callback, { error: ROOM_STILL_OPENING });
            return null;
          }
          if (stopped()) return null;
          if (state.rooms.get(roomChannelId) !== found.room) {
            respond(callback, { error: ROOM_STILL_OPENING });
            return null;
          }
          return found;
        };
        if (!room) {
          const found = await findOrOpenRoom();
          if (!found) return;
          room = found.room;
          createdRoom = found.created;
        }

        const mayOpenThisCode =
          !isWebinarAttendeeJoin &&
          (hostRequested ||
            allowRoomCreation ||
            clientPolicy.allowNonHostRoomCreation ||
            (Boolean(normalizedJoinEmail) && room.ownerEmail === normalizedJoinEmail));
        const unclaimed = room.awaitingOpener;
        createdRoom = unclaimed !== null && (createdRoom || mayOpenThisCode);
        const lostCall = createdRoom ? (unclaimed?.lost ?? null) : null;
        lostRoom = lostCall && Date.now() <= lostCall.claimableUntil ? lostCall : null;
        if (lostCall && !lostRoom) room.endLostCall();

        // Past its deadline, a room that stood in for a lost call is a new
        // meeting to whoever opens it. Nothing of that call holds in it.
        if (room.restorerState(Date.now()) === "lapsed") {
          room.endLostCall();
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

        const removeClientForRejoin = (
          targetUserId: string,
          options?: { notifyPeers?: boolean },
        ) => {
          const client = room.getClient(targetUserId);
          if (!client) return;

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

        // The verified account the code belongs to hosts whenever it is
        // here, without knocking, whoever opened the room before it came.
        const isCodeOwner =
          !isWebinarAttendeeJoin &&
          Boolean(normalizedJoinEmail) &&
          room.ownerEmail === normalizedJoinEmail;
        // A block comes before every right the room keeps for a rejoin: host,
        // co-host, an admission, a stage invite. The one exemption is an
        // account that is a host by configuration outside the room, which
        // the room also refuses to block or remove.
        if (
          !forcedHostJoin &&
          !isCodeOwner &&
          user?.isSuperAdmin !== true &&
          room.isBlocked(userKey, guestProof, guestLink)
        ) {
          Logger.info(`Blocked identity ${userKey} denied access to room ${roomId}`);
          respond(callback, { error: "You are not allowed to join this meeting." });
          return;
        }

        const needsReadmission = room.needsReadmission(userKey, roomGuestProof, guestLink);
        const isReturningPrimaryHost =
          !isWebinarAttendeeJoin &&
          !needsReadmission &&
          room.isHostUserKey(userKey, roomGuestProof, guestLink);
        const isPersistedAdminForExistingRoom =
          !isWebinarAttendeeJoin &&
          !needsReadmission &&
          room.isAdminUserKey(userKey, roomGuestProof, guestLink);
        const holdsLiveHostSeat = room.hasLiveHostSeat(userKey, roomGuestProof, guestLink);
        const isAdminForExistingRoom =
          !isWebinarAttendeeJoin &&
          (isReturningPrimaryHost ||
            isPersistedAdminForExistingRoom ||
            holdsLiveHostSeat ||
            isCodeOwner ||
            (hostRequested &&
              (clientPolicy.allowHostJoin || forcedHostJoin)));
        const provesMembership =
          !isWebinarAttendeeJoin &&
          !needsReadmission &&
          provesEarlierRoomMembership(
            data?.roomRecoveryPass,
            room,
            userKey,
            config.sfuSecret,
          );
        // Recreating a room the SFU lost is restoring a call, not starting
        // one. Its host's seat goes to someone from that call: a host of it,
        // or a member who holds its pass. Anyone else who recreates it, such
        // as a tab that was only knocking, waits as before, and the room
        // waits for its people. A room with no gate has nothing to wait at.
        const hostsLostCall = hostRequested || isAdminForExistingRoom;
        if (
          createdRoom &&
          !isWebinarAttendeeJoin &&
          !hostsLostCall &&
          (clientPolicy.knockByDefault || clientPolicy.useWaitingRoom)
        ) {
          const onLapse = () => offerLapsedRoom(io, state, room);
          if (lostRoom && !provesMembership) {
            room.awaitRestorer({
              until: lostRoom.claimableUntil,
              rosterKnown: true,
              onLapse,
            });
          }
          // A pass, but no record of its call: the call was lost by another
          // SFU whose ledger this one cannot read. Its people come back in
          // on their passes. Who hosted it, and whether it was ended, is
          // unknown here, so no pass gets the host's seat. A pass from a
          // meeting this SFU saw end or empty is void, and proves nothing.
          if (!lostRoom && provesMembership) {
            room.awaitRestorer({
              until: Date.now() + ROOM_RECOVERY_PASS_TTL_MS,
              rosterKnown: false,
              onLapse,
            });
          }
        }
        const restorerState = room.restorerState(Date.now());
        const takesOverRecreatedRoom =
          restorerState === "awaited"
            ? hostsLostCall || (provesMembership && room.knowsLostRoster)
            : restorerState === "lapsed" && (allowRoomCreation || hostRequested);
        const isAdminJoin = isWebinarAttendeeJoin
          ? false
          : createdRoom
            ? restorerState === "none"
            : isAdminForExistingRoom || takesOverRecreatedRoom;
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

        const claimsOpening = createdRoom || (isAdminJoin && room.awaitingOpener !== null);
        const releaseClaim = (): void => {
          if (claimsOpening) room.awaitingOpener = null;
        };

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

        const isInvitedJoin =
          !isWebinarAttendeeJoin &&
          !needsReadmission &&
          isScheduledMeetingInvitee(
            state.scheduledMeetings,
            clientId,
            roomId,
            normalizedJoinEmail,
          );
        // This room was recreated after the SFU lost the one this person was
        // in. Record the admission they prove, so they rejoin as they would
        // have and everyone who was only knocking still knocks.
        if (
          provesMembership &&
          !hasPrivilegedJoinAccess &&
          room.isLocked &&
          !room.isLockedAllowed(userKey, roomGuestProof, guestLink) &&
          room.restoreAdmission(userKey, guestProof, { pastLock: true })
        ) {
          Logger.info(
            `Recovered ${userKey}'s admission to recreated room ${roomId} (${clientId})`,
          );
        }
        if (
          !isWebinarAttendeeJoin &&
          (room.isLocked || needsReadmission) &&
          !hasPrivilegedJoinAccess &&
          !isWebinarPromotedJoin &&
          !isInvitedJoin &&
          !room.isLockedAllowed(userKey, roomGuestProof, guestLink)
        ) {
          if (isWaitingRoomFull(room, userKey)) {
            respond(callback, { error: WAITING_ROOM_FULL_ERROR });
            return;
          }
          commitLink();
          releaseClaim();
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

          // Nothing here names anyone in the meeting: a user id holds its
          // owner's guest session, and that is all a guest needs to be them.
          respond(callback, {
            roomId,
            rtpCapabilities: room.rtpCapabilities,
            existingProducers: [],
            status: "waiting",
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
          releaseClaim();
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
        releaseClaim();
        if (
          isAdminJoin &&
          isCodeOwner &&
          (room.isBlocked(userKey) || room.needsReadmission(userKey))
        ) {
          room.allowLockedUser(userKey);
        }
        let otherHostTabs: Admin[] = [];
        if (isAdminJoin) {
          otherHostTabs = room.grantHost(
            userKey,
            isCodeOwner
              ? "owner"
              : hostRequested && (clientPolicy.allowHostJoin || forcedHostJoin)
                ? "promoted"
                : "fallback",
          );
          if (!room.hostUserKey) room.makePrimaryHost(userKey);
        }
        let demotedForOwner: Client[] = [];
        if (isAdminJoin && isCodeOwner) {
          demotedForOwner = room.welcomeOwner(userKey);
        }
        if (isAdminJoin && (claimsOpening || restorerState !== "none")) {
          room.markRestored();
          state.roomRecovery.noteRunning(room);
        }
        const isPrimaryHost = room.isHostUserKey(userKey, roomGuestProof, guestLink);
        if (isAdminJoin) {
          socket.emit("hostAssigned", {
            roomId,
            hostUserId: room.getHostUserId() ?? (isPrimaryHost ? userId : null),
          });
        }
        if (isAdminForExistingRoom && room.cleanupDeadline !== null) {
          Logger.info(`Host returning to room ${roomId}, cleanup cancelled.`);
          room.stopCleanupTimer();
        }
        const attempts = attemptsOf(state);
        const tabAttempts = attempts.byTab.get(joinKey);
        if (tabAttempts) tabAttempts.seated = Math.max(tabAttempts.seated, tabAttempt);

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
          teardownClient({
            io,
            state,
            room: previousRoom,
            userId: previousClientId,
            peers: previousPeers,
          });
          ensureHost(io, state, previousRoom, previousPeers);

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
        const joiningChannel = socket.join(roomChannelId);
        context.currentRoom.addClient(context.currentClient);
        if (!room.hasActiveAdmin()) ensureHost(io, state, room);

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

        // The previous room's channel is left only now. Nothing awaits between
        // the identity checks above and this seat, so a second join under the
        // same user key is always judged against the seat.
        if (previousChannelIdToLeave) {
          await socket.leave(previousChannelIdToLeave);
          cleanupRoom(state, previousChannelIdToLeave);
          if (stopped()) return;
        }
        await joiningChannel;
        if (stopped()) return;

        room.tellOwnerTookOver(demotedForOwner);
        for (const tab of otherHostTabs) {
          if (tab.socket.id !== socket.id && room.getClient(tab.id) === tab) {
            announcePromotedHost(room, tab);
          }
        }

        if (context.currentClient instanceof Admin && !context.currentClient.isObserver) {
          const pendingUsers = context.currentRoom.waitingGuests().map((pending) => ({
            userId: pending.userKey,
            displayName: pending.displayName || pending.userKey,
          }));
          emitToHost(context.currentClient, "pendingUsersSnapshot", {
            users: pendingUsers,
            roomId: context.currentRoom.id,
          });
          // Those waiting in a room this join opened were waiting for it.
          if (createdRoom) {
            for (const pending of context.currentRoom.pendingClients.values()) {
              pending.socket.emit("waitingRoomStatus", {
                message: "A host is available to let you in.",
                roomId: context.currentRoom.id,
              });
            }
          }
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

        // Publish settings only after this socket's room membership is restored.
        // A transport reconnect can happen before joinRoom finishes.
        if (!context.currentClient.isObserver) {
          socket.emit(
            "ai:changed",
            context.currentRoom.aiCredentials.status(readAiEnvironment(process.env)),
          );
        }

        const roomRecoveryPass = issueRoomRecoveryPass(
          context.currentRoom,
          context.currentClient,
          config.sfuSecret,
        );
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
          ...(roomRecoveryPass ? { roomRecoveryPass } : {}),
        });
      } catch (error) {
        Logger.error("Error joining room:", error);
        respond(callback, { error: (error as Error).message });
      } finally {
        if (attemptKey !== null && attemptRoom !== null) {
          endJoinAttempt(context, attemptRoom, attemptKey);
        }
      }
    },
  );
};

import { Admin } from "../../../config/classes/Admin.js";
import type {
  WebinarDemotedNotification,
  WebinarPromotedNotification,
  WebinarQaModerateRequest,
} from "../../../types.js";
import { forceRemoveClientNow } from "../../admin/controlPlane.js";
import { getOrCreateWebinarRoomConfig } from "../../webinar.js";
import {
  emitWebinarHandQueueChanged,
  emitWebinarQaEntryChanged,
} from "../../webinarNotifications.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_QA_QUESTION_LENGTH = 500;
const MAX_QA_ANSWER_LENGTH = 1000;
const MAX_QA_ID_LENGTH = 64;

/** Collapse all whitespace runs; strips control characters as a side effect. */
const normalizePlainLine = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
};

const normalizeQaId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_QA_ID_LENGTH) return null;
  return normalized;
};

const QA_MODERATE_ACTIONS = new Set([
  "answering",
  "answered",
  "dismissed",
  "reopen",
]);

/**
 * Webinar attendee interaction: Q&A, stage-request hands, and the host's
 * promote/demote controls. Registered for every socket; each handler guards
 * on the caller's current role.
 */
export const registerWebinarInteractionHandlers = (
  context: ConnectionContext,
): void => {
  const { socket, io, state } = context;

  const requireAttendee = ():
    | { error: string }
    | { room: NonNullable<ConnectionContext["currentRoom"]>; userId: string } => {
    if (!context.currentRoom || !context.currentClient) {
      return { error: "Not in a room" };
    }
    if (!context.currentClient.isWebinarAttendee) {
      return { error: "Only webinar attendees can do this" };
    }
    return { room: context.currentRoom, userId: context.currentClient.id };
  };

  const requireHost = ():
    | { error: string }
    | {
        room: NonNullable<ConnectionContext["currentRoom"]>;
        hostUserId: string;
      } => {
    if (!context.currentRoom || !context.currentClient) {
      return { error: "Not in a room" };
    }
    if (
      !(context.currentClient instanceof Admin) ||
      context.currentClient.isObserver
    ) {
      return { error: "Only hosts can do this" };
    }
    if (!takeToken(socket, "webinar:hostAction", RATE_LIMITS.adminAction)) {
      return { error: "Too many host actions; please retry shortly" };
    }
    return { room: context.currentRoom, hostUserId: context.currentClient.id };
  };

  socket.on(
    "webinar:qa:submit",
    (
      data: { question?: string },
      callback: (
        response: { success: boolean; id: string } | { error: string },
      ) => void,
    ) => {
      try {
        const guard = requireAttendee();
        if ("error" in guard) {
          respond(callback, guard);
          return;
        }

        const webinarConfig = getOrCreateWebinarRoomConfig(
          state.webinarConfigs,
          guard.room.channelId,
        );
        if (!webinarConfig.enabled || !webinarConfig.qaEnabled) {
          respond(callback, { error: "Q&A is turned off for this webinar" });
          return;
        }

        if (!takeToken(socket, "webinar:qaSubmit", RATE_LIMITS.webinarQa)) {
          respond(callback, {
            error: "You are sending questions too quickly",
          });
          return;
        }

        const question = normalizePlainLine(
          data?.question,
          MAX_QA_QUESTION_LENGTH,
        );
        if (question.length < 2) {
          respond(callback, { error: "Ask a longer question" });
          return;
        }

        const displayName =
          guard.room.getDisplayNameForUser(guard.userId) || "Attendee";
        const result = guard.room.submitWebinarQuestion(
          guard.userId,
          displayName,
          question,
        );
        if ("error" in result) {
          respond(callback, result);
          return;
        }

        // Capacity evictions must reach every client that may render the
        // dropped rows, or the store and the UIs drift apart.
        for (const removedId of result.evictedIds) {
          io.to(guard.room.channelId).emit("webinar:qaChanged", {
            roomId: guard.room.id,
            removedId,
          });
        }
        emitWebinarQaEntryChanged(io, guard.room, result.entry);
        respond(callback, { success: true, id: result.entry.id });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "webinar:qa:upvote",
    (
      data: { id?: string },
      callback: (
        response:
          | { success: boolean; upvotes: number; hasUpvoted: boolean }
          | { error: string },
      ) => void,
    ) => {
      try {
        const guard = requireAttendee();
        if ("error" in guard) {
          respond(callback, guard);
          return;
        }

        const webinarConfig = getOrCreateWebinarRoomConfig(
          state.webinarConfigs,
          guard.room.channelId,
        );
        if (!webinarConfig.enabled || !webinarConfig.qaEnabled) {
          respond(callback, { error: "Q&A is turned off for this webinar" });
          return;
        }

        if (!takeToken(socket, "webinar:qaUpvote", RATE_LIMITS.webinarQaVote)) {
          respond(callback, { error: "You are voting too quickly" });
          return;
        }

        const questionId = normalizeQaId(data?.id);
        if (!questionId) {
          respond(callback, { error: "Invalid question" });
          return;
        }

        const entryState = guard.room.toggleWebinarQuestionUpvote(
          guard.userId,
          questionId,
        );
        if (!entryState) {
          respond(callback, { error: "Question not found" });
          return;
        }

        // Attendees may only vote on questions they can see.
        if (
          !guard.room.isWebinarQaEntryVisibleTo(entryState, guard.userId, false)
        ) {
          guard.room.toggleWebinarQuestionUpvote(guard.userId, questionId);
          respond(callback, { error: "Question not found" });
          return;
        }

        const entry = guard.room.projectWebinarQaEntry(
          entryState,
          guard.userId,
        );
        emitWebinarQaEntryChanged(
          io,
          guard.room,
          guard.room.projectWebinarQaEntry(entryState),
        );
        respond(callback, {
          success: true,
          upvotes: entry.upvotes,
          hasUpvoted: Boolean(entry.hasUpvoted),
        });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "webinar:qa:moderate",
    (
      data: WebinarQaModerateRequest,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const guard = requireHost();
        if ("error" in guard) {
          respond(callback, guard);
          return;
        }

        const questionId = normalizeQaId(data?.id);
        const action = data?.action;
        if (!questionId || !QA_MODERATE_ACTIONS.has(action)) {
          respond(callback, { error: "Invalid moderation request" });
          return;
        }

        const before = guard.room.getWebinarQaEntryState(questionId);
        if (!before) {
          respond(callback, { error: "Question not found" });
          return;
        }
        const wasPublished =
          before.status === "answering" || before.status === "answered";

        const moderatorName =
          guard.room.getDisplayNameForUser(guard.hostUserId) || "Host";
        const answerText =
          data?.answerText !== undefined
            ? normalizePlainLine(data.answerText, MAX_QA_ANSWER_LENGTH)
            : undefined;

        const updated = guard.room.moderateWebinarQuestion(
          questionId,
          action,
          { answerText, moderatorName },
        );
        if (!updated) {
          respond(callback, { error: "Question not found" });
          return;
        }

        emitWebinarQaEntryChanged(
          io,
          guard.room,
          guard.room.projectWebinarQaEntry(updated),
          { wasPublished },
        );
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "webinar:setHandRaised",
    (
      data: { raised?: boolean },
      callback: (
        response: { success: boolean; raised: boolean } | { error: string },
      ) => void,
    ) => {
      try {
        const guard = requireAttendee();
        if ("error" in guard) {
          respond(callback, guard);
          return;
        }

        if (!takeToken(socket, "webinar:hand", RATE_LIMITS.hand)) {
          respond(callback, { error: "You are raising your hand too quickly" });
          return;
        }

        if (typeof data?.raised !== "boolean") {
          respond(callback, { error: "Invalid hand state" });
          return;
        }

        const changed = guard.room.setWebinarHandRaised(
          guard.userId,
          data.raised,
        );
        if (changed) {
          emitWebinarHandQueueChanged(guard.room);
        }
        respond(callback, { success: true, raised: data.raised });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "webinar:declineStage",
    (
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const guard = requireAttendee();
        if ("error" in guard) {
          respond(callback, guard);
          return;
        }
        const userKey = guard.room.userKeysById.get(guard.userId);
        if (userKey) {
          guard.room.declineStageInvite(userKey);
        }
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "webinar:promoteAttendee",
    (
      data: { userId?: string },
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const guard = requireHost();
        if ("error" in guard) {
          respond(callback, guard);
          return;
        }

        const targetUserId =
          typeof data?.userId === "string" ? data.userId.trim() : "";
        const target = targetUserId
          ? guard.room.getClient(targetUserId)
          : undefined;
        if (!target || !target.isWebinarAttendee) {
          respond(callback, { error: "Attendee not found" });
          return;
        }

        const targetUserKey = guard.room.userKeysById.get(targetUserId);
        if (!targetUserKey) {
          respond(callback, { error: "Attendee not found" });
          return;
        }

        guard.room.promoteWebinarUserKey(targetUserKey);
        if (guard.room.setWebinarHandRaised(targetUserId, false)) {
          emitWebinarHandQueueChanged(guard.room);
        }

        target.socket.emit("webinar:promoted", {
          roomId: guard.room.id,
          rejoinRoomId: guard.room.id,
          promotedByName:
            guard.room.getDisplayNameForUser(guard.hostUserId) || undefined,
        } satisfies WebinarPromotedNotification);
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  socket.on(
    "webinar:demoteParticipant",
    (
      data: { userId?: string },
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        const guard = requireHost();
        if ("error" in guard) {
          respond(callback, guard);
          return;
        }

        const targetUserId =
          typeof data?.userId === "string" ? data.userId.trim() : "";
        const target = targetUserId
          ? guard.room.getClient(targetUserId)
          : undefined;
        if (
          !target ||
          target instanceof Admin ||
          targetUserId === guard.hostUserId
        ) {
          respond(callback, { error: "Participant not found" });
          return;
        }

        const targetUserKey = guard.room.userKeysById.get(targetUserId);

        // Demoting a current attendee just cancels a pending stage invite.
        if (target.isWebinarAttendee) {
          if (targetUserKey) {
            guard.room.revokeWebinarPromotion(targetUserKey);
          }
          respond(callback, { success: true });
          return;
        }

        // A demotion is a decision on the guest: every stage tab of the
        // guest leaves the stage, as admitting or denying covers every tab.
        const stageSeats = (
          targetUserKey
            ? guard.room.seatsOfSameGuest(targetUserKey)
            : [targetUserId]
        ).filter((userId) => {
          const seat = guard.room.getClient(userId);
          return (
            seat !== undefined &&
            !seat.isWebinarAttendee &&
            !(seat instanceof Admin) &&
            userId !== guard.hostUserId
          );
        });

        if (targetUserKey) {
          // While webinar mode is on, this guest may not slip back in as a
          // participant under any of its keys: a client that ignores the
          // demote signal below must not be able to simply rejoin the panel.
          guard.room.markWebinarDemotedUserKey(targetUserKey);
        }

        const webinarConfig = state.webinarConfigs.get(guard.room.channelId);
        for (const userId of stageSeats) {
          const seat = guard.room.getClient(userId);
          if (!seat) continue;
          seat.socket.emit("webinar:demoted", {
            roomId: guard.room.id,
            webinarLinkSlug: webinarConfig?.linkSlug ?? null,
          } satisfies WebinarDemotedNotification);

          // Server-side enforcement, not a client courtesy: tear the seat
          // down now (socket handlers, producers, transports, presence).
          // Disconnect first so a client that ignores the navigation event
          // cannot keep invoking handlers through stale
          // currentRoom/currentClient context; forceRemoveClientNow then
          // cancels the disconnect grace immediately. The demoted client
          // rejoins through the public webinar link as a viewer.
          seat.socket.disconnect(true);
          forceRemoveClientNow({ io, state, room: guard.room, userId });
        }
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};

import type { Room } from "../../../config/classes/Room.js";
import type { Client } from "../../../config/classes/Client.js";
import type {
  PollChangedNotification,
  PollExportResponse,
  PollSnapshot,
  PollView,
} from "../../../types.js";
import {
  parsePollDraft,
  type PollAudience,
  type PollDraftRejection,
  type PollVoteRejection,
} from "../../polls.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

type ErrorResponse = { error: string };
type PollResponse = { success: true; poll: PollView } | ErrorResponse;
type VoteResponse =
  | { success: true; poll: PollView }
  | { error: string; poll?: PollView };

const MAX_POLL_ID_LENGTH = 64;

const DRAFT_ERRORS: Record<PollDraftRejection | "too-many-polls", string> = {
  "invalid-question": "Add a question",
  "invalid-options": "Add 2 to 10 different options",
  "too-many-polls": "This meeting has reached its poll limit",
};

const VOTE_ERRORS: Record<PollVoteRejection, string> = {
  "not-found": "This poll is no longer available",
  ended: "This poll has ended",
  "already-voted": "You already voted",
  "invalid-choice": "Pick an option to vote",
};

const normalizePollId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= MAX_POLL_ID_LENGTH ? id : null;
};

const audienceFor = (room: Room, client: Client): PollAudience => ({
  isModerator: room.isAdminClient(client),
  voterKey: room.userKeysById.get(client.id) ?? client.id,
});

/**
 * Fan a poll change out with each viewer's visibility: hosts get tallies,
 * participants get them only once results are shared. Webinar attendees
 * never see meeting polls. A vote changes nothing a participant can see
 * until results are shared, so callers skip them then.
 */
const emitPollChanged = (
  room: Room,
  pollId: string,
  options: { includeParticipants: boolean },
): void => {
  const hostView = room.polls.view(pollId, { isModerator: true });
  if (!hostView) return;
  const participantView = options.includeParticipants
    ? room.polls.view(pollId, { isModerator: false })
    : null;

  for (const client of room.clients.values()) {
    if (client.isWebinarAttendee) continue;
    const poll = room.isAdminClient(client) ? hostView : participantView;
    if (!poll) continue;
    client.socket.emit("poll:changed", {
      roomId: room.id,
      poll,
    } satisfies PollChangedNotification);
  }
};

export const registerPollHandlers = (context: ConnectionContext): void => {
  const { socket } = context;

  const requireParticipant = ():
    | ErrorResponse
    | { room: Room; client: Client } => {
    const room = context.currentRoom;
    const client = context.currentClient;
    if (!room || !client) return { error: "Not in a room" };
    if (client.isWebinarAttendee) return { error: "Polls are not available here" };
    return { room, client };
  };

  const requireHost = (): ErrorResponse | { room: Room; client: Client } => {
    const guard = requireParticipant();
    if ("error" in guard) return guard;
    if (!guard.room.isAdminClient(guard.client)) {
      return { error: "Only hosts can run polls" };
    }
    if (!takeToken(socket, "poll:control", RATE_LIMITS.adminAction)) {
      return { error: "Too many poll changes. Try again in a moment." };
    }
    return guard;
  };

  socket.on(
    "poll:getState",
    (callback: (response: PollSnapshot | ErrorResponse) => void) => {
      const guard = requireParticipant();
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }
      if (!takeToken(socket, "poll:getState", RATE_LIMITS.pollState)) {
        respond(callback, { error: "Too many requests" });
        return;
      }
      respond(callback, {
        roomId: guard.room.id,
        polls: guard.room.polls.snapshot(audienceFor(guard.room, guard.client)),
      });
    },
  );

  socket.on(
    "poll:create",
    (data: unknown, callback: (response: PollResponse) => void) => {
      const guard = requireHost();
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }
      const parsed = parsePollDraft(data);
      if (!parsed.ok) {
        respond(callback, { error: DRAFT_ERRORS[parsed.reason] });
        return;
      }
      const { room, client } = guard;
      const created = room.polls.create(
        parsed.draft,
        room.getDisplayNameForUser(client.id) || "Host",
      );
      if (!created.ok) {
        respond(callback, { error: DRAFT_ERRORS[created.reason] });
        return;
      }
      emitPollChanged(room, created.pollId, { includeParticipants: true });
      respond(callback, {
        success: true,
        poll: room.polls.view(created.pollId, audienceFor(room, client))!,
      });
    },
  );

  socket.on(
    "poll:vote",
    (
      data: { pollId?: unknown; optionIds?: unknown } | undefined,
      callback: (response: VoteResponse) => void,
    ) => {
      const guard = requireParticipant();
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }
      const { room, client } = guard;
      if (!takeToken(socket, "poll:vote", RATE_LIMITS.pollVote)) {
        respond(callback, { error: "You are voting too quickly" });
        return;
      }
      const pollId = normalizePollId(data?.pollId);
      if (!pollId) {
        respond(callback, { error: VOTE_ERRORS["not-found"] });
        return;
      }

      const audience = audienceFor(room, client);
      const result = room.polls.vote(
        pollId,
        audience.voterKey!,
        room.getDisplayNameForUser(client.id) || "Guest",
        data?.optionIds,
      );
      const poll = room.polls.view(pollId, audience) ?? undefined;
      if (!result.ok) {
        respond(callback, { error: VOTE_ERRORS[result.reason], poll });
        return;
      }
      emitPollChanged(room, pollId, {
        includeParticipants: room.polls.isResultsShared(pollId),
      });
      respond(callback, { success: true, poll: poll! });
    },
  );

  socket.on(
    "poll:end",
    (
      data: { pollId?: unknown } | undefined,
      callback: (response: PollResponse) => void,
    ) => {
      const guard = requireHost();
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }
      const { room, client } = guard;
      const pollId = normalizePollId(data?.pollId);
      const outcome = pollId ? room.polls.end(pollId) : "not-found";
      if (!pollId || outcome === "not-found") {
        respond(callback, { error: VOTE_ERRORS["not-found"] });
        return;
      }
      if (outcome === "ended") {
        emitPollChanged(room, pollId, { includeParticipants: true });
      }
      respond(callback, {
        success: true,
        poll: room.polls.view(pollId, audienceFor(room, client))!,
      });
    },
  );

  socket.on(
    "poll:share",
    (
      data: { pollId?: unknown; shared?: unknown } | undefined,
      callback: (response: PollResponse) => void,
    ) => {
      const guard = requireHost();
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }
      const { room, client } = guard;
      const pollId = normalizePollId(data?.pollId);
      if (!pollId || typeof data?.shared !== "boolean") {
        respond(callback, { error: "Invalid poll request" });
        return;
      }
      const outcome = room.polls.setResultsShared(pollId, data.shared);
      if (outcome === "not-found") {
        respond(callback, { error: VOTE_ERRORS["not-found"] });
        return;
      }
      if (outcome === "changed") {
        emitPollChanged(room, pollId, { includeParticipants: true });
      }
      respond(callback, {
        success: true,
        poll: room.polls.view(pollId, audienceFor(room, client))!,
      });
    },
  );

  socket.on(
    "poll:export",
    (
      data: { pollId?: unknown } | undefined,
      callback: (response: PollExportResponse | ErrorResponse) => void,
    ) => {
      const guard = requireHost();
      if ("error" in guard) {
        respond(callback, guard);
        return;
      }
      const { room } = guard;
      const pollId = normalizePollId(data?.pollId);
      const poll = pollId ? room.polls.view(pollId, { isModerator: true }) : null;
      const ballots = pollId ? room.polls.exportBallots(pollId) : null;
      if (!poll || !ballots) {
        respond(callback, { error: VOTE_ERRORS["not-found"] });
        return;
      }
      respond(callback, { poll, ballots });
    },
  );
};

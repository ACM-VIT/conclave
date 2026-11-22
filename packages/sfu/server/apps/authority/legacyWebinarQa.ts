import type {
  AuthorityFailure,
  AuthorityFrame,
  Json,
} from "@conclave/apps-sdk/authority";
import {
  QA_MAX_ENTRIES,
  type QuestionCard,
} from "@conclave/apps-sdk/qa/core";
import type {
  WebinarQaChangedNotification,
  WebinarQaEntry,
  WebinarQaModerateRequest,
  WebinarQaSnapshot,
} from "../../../types.js";
import type { ConnectionContext } from "../../socket/context.js";
import type { SfuState } from "../../state.js";
import { getRoomAuthority } from "./index.js";
import type { RoomAuthority } from "./roomAuthority.js";

/**
 * The `webinar:qa:*` events over the Q&A app's book.
 *
 * Released web and native clients know only these events. In a room that
 * runs the Q&A app there is one book, so an old client and a new one see the
 * same questions. This adapter holds no questions and no visibility rule of
 * its own: it follows the app's view for each connection, exactly as that
 * connection would be sent it, and re-says it in the old shape.
 *
 * The old wire carries webinar Q&A only, so nothing is sent on it while the
 * room is a regular meeting.
 */
const QA_APP = "qa";

type Rows = Map<string, Map<string, Json>>;

type Feed = {
  rows: Rows;
  /** Parts of a replacement still arriving. */
  incoming: AuthorityFrame[];
  close(): void;
};

const feeds = new WeakMap<object, Feed>();
/** Question id to the seat that asked, per room, for hosts on the old wire. */
const askerSeats = new WeakMap<RoomAuthority, Map<string, string>>();

type HiddenQuestion = { question: QuestionCard; upvotes: number };

const seatsOf = (authority: RoomAuthority): Map<string, string> => {
  const seats = askerSeats.get(authority);
  if (seats) return seats;
  const created = new Map<string, string>();
  askerSeats.set(authority, created);
  authority.onAction((notice) => {
    if (notice.app !== QA_APP || notice.action !== "ask") return;
    const id = (notice.value as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return;
    created.set(id, notice.seatId);
    // The book holds at most the cap; keep a little slack, then drop oldest.
    while (created.size > QA_MAX_ENTRIES * 2) {
      const oldest = created.keys().next().value;
      if (oldest === undefined) break;
      created.delete(oldest);
    }
  });
  return created;
};

/** The room's authority when it runs the Q&A app, which makes it the book. */
export const qaBookOf = (context: ConnectionContext): RoomAuthority | null => {
  if (!context.currentRoom) return null;
  const authority = getRoomAuthority(context.state, context.currentRoom);
  return authority?.runs(QA_APP) ? authority : null;
};

const isWebinar = (state: SfuState, channelId: string): boolean =>
  Boolean(state.webinarConfigs.get(channelId)?.enabled);

/** One question in the old shape, from what this connection's view holds. */
const entryOf = (
  context: ConnectionContext,
  authority: RoomAuthority,
  rows: Rows,
  id: string,
): WebinarQaEntry | null => {
  const own = rows.get("myQuestions")?.get(id) as
    | { hidden: HiddenQuestion | null }
    | undefined;
  const shared = rows.get("questions")?.get(id) as QuestionCard | undefined;
  const question = shared ?? own?.hidden?.question;
  if (!question) return null;
  const votes = rows.get("votes")?.get(id) as { upvotes: number } | undefined;

  const client = context.currentClient;
  const room = context.currentRoom;
  // The old wire names the asker by seat. A viewer is told their own, and a
  // host is told everyone's, as hosts already see who is in the room. Nobody
  // else is handed another person's seat id.
  const userId = own
    ? (client?.id ?? "")
    : client && room?.isAdminClient(client)
      ? (seatsOf(authority).get(id) ?? "")
      : "";

  return {
    id: question.id,
    userId,
    displayName: question.askerName,
    question: question.text,
    status: question.status,
    askedAt: question.askedAt,
    updatedAt: question.updatedAt,
    upvotes: votes?.upvotes ?? own?.hidden?.upvotes ?? 0,
    hasUpvoted: rows.get("myUpvotes")?.has(id) ?? false,
    ...(question.answerText ? { answerText: question.answerText } : {}),
    ...(question.answeredByName
      ? { answeredByName: question.answeredByName }
      : {}),
  };
};

const questionIds = (rows: Rows): string[] => [
  ...new Set([
    ...(rows.get("questions")?.keys() ?? []),
    ...(rows.get("myQuestions")?.keys() ?? []),
  ]),
];

/**
 * Starts the old-wire feed for a connection that has just joined. Returns
 * false when the room does not run the Q&A app, and the caller then sends
 * the snapshot the old way.
 */
export const attachLegacyQaFeed = (context: ConnectionContext): boolean => {
  const authority = qaBookOf(context);
  const room = context.currentRoom;
  if (!authority || !room) return false;
  detachLegacyQaFeed(context);
  seatsOf(authority);

  const { socket, state } = context;
  const feed: Feed = { rows: new Map(), incoming: [], close: () => {} };

  const sendSnapshot = (): void => {
    if (!isWebinar(state, room.channelId)) return;
    const entries = questionIds(feed.rows)
      .map((id) => entryOf(context, authority, feed.rows, id))
      .filter((entry): entry is WebinarQaEntry => entry !== null)
      .sort((a, b) => a.askedAt - b.askedAt);
    socket.emit("webinar:qaSnapshot", {
      roomId: room.id,
      entries,
    } satisfies WebinarQaSnapshot);
  };

  const sink = (frame: AuthorityFrame): void => {
    if (frame.kind === "revoke") {
      // The seat may no longer see Q&A. An old client keeps a list until it
      // is told otherwise, so it is sent an empty one.
      feed.incoming = [];
      if (feed.rows.size === 0) return;
      feed.rows = new Map();
      socket.emit("webinar:qaSnapshot", {
        roomId: room.id,
        entries: [],
      } satisfies WebinarQaSnapshot);
      return;
    }
    if (frame.kind === "replace") {
      if (frame.part === 0) feed.incoming = [];
      feed.incoming.push(frame);
      if (!frame.last) return;
      const rows: Rows = new Map();
      for (const part of feed.incoming) {
        if (part.kind !== "replace") continue;
        for (const row of part.rows) {
          const bucket = rows.get(row.bucket) ?? new Map<string, Json>();
          bucket.set(row.key, row.value);
          rows.set(row.bucket, bucket);
        }
      }
      feed.incoming = [];
      feed.rows = rows;
      sendSnapshot();
      return;
    }
    if (frame.kind !== "patch") return;

    const touched = new Set<string>();
    for (const ref of frame.remove) {
      feed.rows.get(ref.bucket)?.delete(ref.key);
      touched.add(ref.key);
    }
    for (const row of frame.put) {
      const bucket = feed.rows.get(row.bucket) ?? new Map<string, Json>();
      bucket.set(row.key, row.value);
      feed.rows.set(row.bucket, bucket);
      touched.add(row.key);
    }
    if (!isWebinar(state, room.channelId)) return;
    for (const id of touched) {
      const entry = entryOf(context, authority, feed.rows, id);
      socket.emit(
        "webinar:qaChanged",
        (entry
          ? { roomId: room.id, entry }
          : { roomId: room.id, removedId: id }) satisfies WebinarQaChangedNotification,
      );
    }
  };

  const observer = authority.observe(context, QA_APP, sink);
  if (!observer) return true;
  feed.close = () => observer.close();
  feeds.set(socket, feed);
  return true;
};

/**
 * Ends a connection's old-wire feed. Called when the client says it speaks
 * the authority transport, so it is not told everything twice.
 */
export const detachLegacyQaFeed = (context: ConnectionContext): void => {
  const feed = feeds.get(context.socket);
  if (!feed) return;
  feed.close();
  feeds.delete(context.socket);
};

type LegacyError = { error: string };

const SUBMIT_REASONS: Record<string, string> = {
  "too-short": "Ask a longer question",
  "too-many-open": "You already have questions waiting. Give the host a moment.",
};

/** Why a webinar attendee may not ask or upvote, in the old wire's words. */
const contributorError = (
  context: ConnectionContext,
  failure: AuthorityFailure,
  fallback: string,
): LegacyError => {
  if (failure.code === "not-in-room") return { error: "Not in a room" };
  if (failure.code === "forbidden") {
    return {
      error: context.currentClient?.isWebinarAttendee
        ? "Q&A is turned off for this webinar"
        : "Only webinar attendees can do this",
    };
  }
  if (failure.code === "rejected" && failure.reason === "not-found") {
    return { error: "Question not found" };
  }
  return { error: fallback };
};

export const legacyQaSubmit = (
  authority: RoomAuthority,
  context: ConnectionContext,
  question: unknown,
): { success: boolean; id: string } | LegacyError => {
  const result = authority.actAs(context, QA_APP, "ask", { text: question });
  if (result.ok) {
    return { success: true, id: (result.value as { id: string }).id };
  }
  if (result.code === "invalid-input") return { error: "Ask a longer question" };
  if (result.code === "rate-limited") {
    return { error: "You are sending questions too quickly" };
  }
  if (result.code === "rejected" && result.reason) {
    const message = SUBMIT_REASONS[result.reason];
    if (message) return { error: message };
  }
  return contributorError(context, result, "Could not send your question.");
};

/**
 * The old upvote is a toggle. The app flips the caller's vote in one
 * transaction and answers with the count that transaction made, so the reply
 * never carries a number that was not read.
 */
export const legacyQaUpvote = (
  authority: RoomAuthority,
  context: ConnectionContext,
  id: string,
): { success: boolean; upvotes: number; hasUpvoted: boolean } | LegacyError => {
  const result = authority.actAs(context, QA_APP, "toggleUpvote", { id });
  if (!result.ok) {
    if (result.code === "rate-limited") {
      return { error: "You are voting too quickly" };
    }
    return contributorError(context, result, "Question not found");
  }
  const { upvotes, hasUpvoted } = result.value as {
    upvotes: number;
    hasUpvoted: boolean;
  };
  return { success: true, upvotes, hasUpvoted };
};

export const legacyQaModerate = (
  authority: RoomAuthority,
  context: ConnectionContext,
  request: WebinarQaModerateRequest,
): { success: boolean } | LegacyError => {
  const result = authority.actAs(context, QA_APP, "moderate", {
    id: request.id,
    action: request.action,
    ...(request.answerText !== undefined
      ? { answerText: request.answerText }
      : {}),
  });
  if (result.ok) return { success: true };
  if (result.code === "not-in-room") return { error: "Not in a room" };
  if (result.code === "forbidden") return { error: "Only hosts can do this" };
  if (result.code === "invalid-input") {
    return { error: "Invalid moderation request" };
  }
  if (result.code === "rate-limited" || result.code === "busy") {
    return { error: "Too many host actions; please retry shortly" };
  }
  return { error: "Question not found" };
};

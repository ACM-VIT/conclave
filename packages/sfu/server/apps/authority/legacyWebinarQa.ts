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
 *
 * A connection is fed for as long as it does not read Q&A itself. Once it
 * holds its own subscription to the app the feed rests, and it resumes with
 * a whole list when that subscription ends. A client that only asked what
 * the server offers is not taken to have switched: its answer may have come
 * too late for it to use, and the old events are then all it has.
 */
const QA_APP = "qa";

/**
 * How many `webinar:qaChanged` events are written to sockets in one turn of
 * the event loop. A change to 20 questions in a webinar of 5,000 old clients
 * is 100,000 of them. They go out a slice a turn, so the room keeps
 * answering between slices.
 */
export const LEGACY_QA_SENDS_PER_TURN = 2_000;

type Rows = Map<string, Map<string, Json>>;

type Feed = {
  context: ConnectionContext;
  rows: Rows;
  /** Parts of a replacement still arriving. */
  incoming: AuthorityFrame[];
  /** Questions that changed for this connection and are yet to be said. */
  pending: Set<string>;
  /**
   * Questions the client keeps as upvoted by itself. The native app up to
   * build 63 saves an upvote from a list or from its own upvote's answer,
   * and from then on shows that over what a change event says. Only a whole
   * list makes it forget one.
   */
  saved: Set<string>;
  closed: boolean;
  close(): void;
};

/** A room's feeds with something yet to say, the longest waiting first. */
type Outbox = { waiting: Set<Feed>; scheduled: boolean };

const feeds = new WeakMap<object, Feed>();
const outboxes = new WeakMap<RoomAuthority, Outbox>();
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

const isHost = (context: ConnectionContext): boolean => {
  const client = context.currentClient;
  return Boolean(client && context.currentRoom?.isAdminClient(client));
};

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

  // The old wire names the asker by seat. A viewer is told their own, and a
  // host is told everyone's, as hosts already see who is in the room. Nobody
  // else is handed another person's seat id.
  const userId = own
    ? (context.currentClient?.id ?? "")
    : isHost(context)
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

/** A number for each row a view holds, to tell two readings of one apart. */
const rowNumbers = new WeakMap<object, number>();
let lastRowNumber = 0;
const numberOf = (row: Json | undefined): number => {
  if (row === undefined || row === null || typeof row !== "object") return 0;
  let number = rowNumbers.get(row);
  if (number === undefined) {
    lastRowNumber += 1;
    number = lastRowNumber;
    rowNumbers.set(row, number);
  }
  return number;
};

/**
 * What a question's change event depends on for a connection that did not
 * ask it: the rows its role holds, whether it is a host, and whether it
 * upvoted. Connections with the same answer are sent the same bytes. The
 * rows of a role are one object for everyone in it, so comparing them is
 * comparing two numbers.
 */
const readingOf = (feed: Feed, id: string): string =>
  [
    id,
    numberOf(feed.rows.get("questions")?.get(id)),
    numberOf(feed.rows.get("votes")?.get(id)),
    isHost(feed.context) ? "h" : "",
    feed.rows.get("myUpvotes")?.has(id) ? "u" : "",
  ].join("|");

/**
 * Says the waiting changes of a room, one slice of sockets a turn.
 *
 * A changed question reads the same for nearly everyone, so its event is
 * built and encoded once for each distinct reading and written to all the
 * sockets that share it. Only the asker's copy, which names them, is their
 * own. A question that changes again while a connection waits its turn is
 * said once, as it stands by then.
 */
const say = (authority: RoomAuthority, outbox: Outbox): void => {
  outbox.scheduled = false;
  let sends = 0;
  const shared = new Map<string, { from: Feed; id: string; sockets: string[] }>();
  for (const feed of outbox.waiting) {
    if (sends >= LEGACY_QA_SENDS_PER_TURN) break;
    outbox.waiting.delete(feed);
    const { context } = feed;
    const room = context.currentRoom;
    const ids = [...feed.pending];
    feed.pending.clear();
    if (feed.closed || !room || !isWebinar(context.state, room.channelId)) {
      continue;
    }
    for (const id of ids) {
      sends += 1;
      if (feed.rows.get("myQuestions")?.has(id)) {
        const entry = entryOf(context, authority, feed.rows, id);
        context.socket.emit(
          "webinar:qaChanged",
          (entry
            ? { roomId: room.id, entry }
            : { roomId: room.id, removedId: id }) satisfies WebinarQaChangedNotification,
        );
        continue;
      }
      const reading = readingOf(feed, id);
      const group = shared.get(reading);
      if (group) group.sockets.push(context.socket.id);
      else shared.set(reading, { from: feed, id, sockets: [context.socket.id] });
    }
  }
  for (const { from, id, sockets } of shared.values()) {
    const room = from.context.currentRoom;
    if (!room) continue;
    const entry = entryOf(from.context, authority, from.rows, id);
    // Local: the sockets are all on this server, where the room is.
    from.context.io.local.to(sockets).emit(
      "webinar:qaChanged",
      (entry
        ? { roomId: room.id, entry }
        : { roomId: room.id, removedId: id }) satisfies WebinarQaChangedNotification,
    );
  }
  if (outbox.waiting.size === 0) return;
  outbox.scheduled = true;
  setImmediate(() => say(authority, outbox));
};

/** Queues a connection's changed questions to be said after this flush. */
const queue = (authority: RoomAuthority, feed: Feed, ids: Iterable<string>): void => {
  for (const id of ids) feed.pending.add(id);
  if (feed.pending.size === 0) return;
  let outbox = outboxes.get(authority);
  if (!outbox) {
    outbox = { waiting: new Set(), scheduled: false };
    outboxes.set(authority, outbox);
  }
  outbox.waiting.add(feed);
  if (outbox.scheduled) return;
  outbox.scheduled = true;
  const waiting = outbox;
  // After the flush that is running now has reached every connection.
  queueMicrotask(() => say(authority, waiting));
};

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
  const feed: Feed = {
    context,
    rows: new Map(),
    incoming: [],
    pending: new Set(),
    saved: new Set(),
    closed: false,
    close: () => {},
  };

  /** A whole list. It replaces whatever was still waiting to be said. */
  const sendSnapshot = (): void => {
    feed.pending.clear();
    if (!isWebinar(state, room.channelId)) return;
    const entries = questionIds(feed.rows)
      .map((id) => entryOf(context, authority, feed.rows, id))
      .filter((entry): entry is WebinarQaEntry => entry !== null)
      .sort((a, b) => a.askedAt - b.askedAt);
    feed.saved = new Set(
      entries.filter((entry) => entry.hasUpvoted).map((entry) => entry.id),
    );
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
      feed.pending.clear();
      if (feed.rows.size === 0) return;
      feed.rows = new Map();
      feed.saved = new Set();
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
    let unsaved = false;
    for (const ref of frame.remove) {
      feed.rows.get(ref.bucket)?.delete(ref.key);
      touched.add(ref.key);
      // An upvote the client saved was taken back somewhere else.
      if (ref.bucket === "myUpvotes" && feed.saved.has(ref.key)) unsaved = true;
    }
    for (const row of frame.put) {
      const bucket = feed.rows.get(row.bucket) ?? new Map<string, Json>();
      bucket.set(row.key, row.value);
      feed.rows.set(row.bucket, bucket);
      touched.add(row.key);
    }
    // A change event cannot make such a client forget a saved upvote. A
    // whole list can, and carries everything else this patch changed.
    if (unsaved) sendSnapshot();
    else queue(authority, feed, touched);
  };

  const observer = authority.observe(context, QA_APP, sink);
  if (!observer) return true;
  feed.close = () => {
    feed.closed = true;
    observer.close();
  };
  feeds.set(socket, feed);
  return true;
};

/** Ends a connection's old-wire feed, before a new one takes its place. */
const detachLegacyQaFeed = (context: ConnectionContext): void => {
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
  // The client saves its vote from this answer.
  const saved = feeds.get(context.socket)?.saved;
  if (hasUpvoted) saved?.add(id);
  else saved?.delete(id);
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

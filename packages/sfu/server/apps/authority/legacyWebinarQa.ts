import type {
  AuthorityFailure,
  AuthorityFrame,
  Json,
} from "@conclave/apps-sdk/authority";
import type { Subject } from "@conclave/apps-sdk/authority/server";
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
import type { Observer, RoomAuthority } from "./roomAuthority.js";
import type { CommittedView } from "./views.js";

/**
 * The `webinar:qa:*` events over the Q&A app's book.
 *
 * Released web and native clients know only these events. In a room that
 * runs the Q&A app there is one book, so an old client and a new one see the
 * same questions. This adapter holds no questions and no visibility rule of
 * its own. It follows the app's view for each connection, exactly as that
 * connection would be sent it, and re-says it in the old shape.
 *
 * It keeps no copy of the view either. A frame only tells it which questions
 * changed for a connection. What it then says is read from the connection's
 * view as committed at the moment of saying, which can be a few turns of the
 * event loop later. So a question hidden in between is never said as it
 * was, and nothing said is out of date.
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

/**
 * How many sockets are written a whole `webinar:qaSnapshot` in one turn. A
 * list is the whole book as one connection sees it, so far fewer of them fit
 * in a turn than of single changes.
 */
export const LEGACY_QA_LISTS_PER_TURN = 250;

/**
 * How long after a person's upvote changes their other clients' saved
 * upvotes are checked. The check can end in a whole list for a client whose
 * own tap was answered a moment before, and that answer is what makes the
 * client save the vote. The wait keeps the list well behind the answer on
 * the wire, so the client cannot take them in the wrong order.
 */
export const LEGACY_QA_SAVED_CHECK_MS = 50;

type Feed = {
  context: ConnectionContext;
  roomId: string;
  observer: Observer | null;
  /** Who the feed is indexed under, to find a person's other connections. */
  subject: Subject | null;
  /** Questions that changed for this connection and are yet to be said. */
  pending: Set<string>;
  /** A whole list is to be said. It replaces whatever was waiting. */
  listDue: boolean;
  /** An empty list is to be said, to a seat that may no longer see Q&A. */
  emptyDue: boolean;
  /** Its client's saved upvotes are to be checked against the book. */
  checkSaved: boolean;
  /**
   * The questions the client lists, each with the reading of it the client
   * was last sent. A question is said again only when its reading differs,
   * and said to be gone only if it is here.
   */
  said: Map<string, string>;
  /**
   * Questions the client keeps as upvoted by itself. The native app up to
   * build 63 saves an upvote from a list or from its own upvote's answer,
   * and from then on shows that over what a change event says. Only a whole
   * list makes it forget one, which matters while it still lists the
   * question. A saved upvote on a question that is gone shows nowhere.
   */
  saved: Set<string>;
};

/** What the adapter keeps for one room. */
type RoomFeeds = {
  io: ConnectionContext["io"];
  /** Feeds with something yet to say, the longest waiting first. */
  waiting: Set<Feed>;
  scheduled: boolean;
  /** Each person's feeds, to check them when that person upvotes anywhere. */
  bySubject: Map<Subject, Set<Feed>>;
  /** Feeds whose saved upvotes are to be checked when the wait is over. */
  toCheck: Set<Feed>;
  checkTimer: NodeJS.Timeout | null;
  all: Set<Feed>;
  /** Question id to the seat that asked, for hosts on the old wire. */
  askers: Map<string, string>;
};

const feeds = new WeakMap<object, Feed>();
const rooms = new WeakMap<RoomAuthority, RoomFeeds>();

type HiddenQuestion = { question: QuestionCard; upvotes: number };

const isWebinar = (state: SfuState, channelId: string): boolean =>
  Boolean(state.webinarConfigs.get(channelId)?.enabled);

/** Puts a feed in line to be said, after the frame or request at hand. */
const queue = (authority: RoomAuthority, room: RoomFeeds, feed: Feed): void => {
  room.waiting.add(feed);
  if (room.scheduled) return;
  room.scheduled = true;
  // After the flush that is running now has reached every connection.
  queueMicrotask(() => say(authority, room));
};

const roomOf = (
  authority: RoomAuthority,
  io: ConnectionContext["io"],
): RoomFeeds => {
  const known = rooms.get(authority);
  if (known) return known;
  const room: RoomFeeds = {
    io,
    waiting: new Set(),
    scheduled: false,
    bySubject: new Map(),
    toCheck: new Set(),
    checkTimer: null,
    all: new Set(),
    askers: new Map(),
  };
  rooms.set(authority, room);
  authority.onAction((notice) => {
    if (notice.app !== QA_APP) return;
    if (notice.action === "ask") {
      const id = (notice.value as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return;
      room.askers.set(id, notice.seatId);
      // The book holds at most the cap; keep a little slack, then drop oldest.
      while (room.askers.size > QA_MAX_ENTRIES * 2) {
        const oldest = room.askers.keys().next().value;
        if (oldest === undefined) break;
        room.askers.delete(oldest);
      }
      return;
    }
    if (notice.action !== "upvote" && notice.action !== "toggleUpvote") return;
    // Someone changed an upvote of theirs, on this connection or another.
    // Two taps close together can leave the book as it was, with no change
    // to flush, so the flush cannot be what tells their other clients. Each
    // of their feeds checks what its client saved against the book.
    for (const feed of room.bySubject.get(notice.subject) ?? []) {
      if (feed.saved.size > 0) room.toCheck.add(feed);
    }
    if (room.toCheck.size === 0 || room.checkTimer) return;
    room.checkTimer = setTimeout(() => {
      room.checkTimer = null;
      for (const feed of room.toCheck) {
        feed.checkSaved = true;
        queue(authority, room, feed);
      }
      room.toCheck.clear();
    }, LEGACY_QA_SAVED_CHECK_MS);
    room.checkTimer.unref?.();
  });
  authority.onPolicy((policy, previous) => {
    // A room that has just become a webinar starts on the old events. Its
    // hosts' views may not differ at all, so no frame would say so.
    if (policy.mode !== "webinar" || previous.mode === "webinar") return;
    for (const feed of room.all) {
      feed.listDue = true;
      queue(authority, room, feed);
    }
  });
  return room;
};

/** The room's authority when it runs the Q&A app, which makes it the book. */
export const qaBookOf = (context: ConnectionContext): RoomAuthority | null => {
  if (!context.currentRoom) return null;
  const authority = getRoomAuthority(context.state, context.currentRoom);
  return authority?.runs(QA_APP) ? authority : null;
};

const isHost = (context: ConnectionContext): boolean => {
  const client = context.currentClient;
  return Boolean(client && context.currentRoom?.isAdminClient(client));
};

const ownOf = (view: CommittedView, id: string) =>
  view.get("myQuestions", id) as { hidden: HiddenQuestion | null } | undefined;

/** Whether a connection's view has a question at all, as a card to show. */
const sees = (view: CommittedView, id: string): boolean =>
  view.get("questions", id) !== undefined || Boolean(ownOf(view, id)?.hidden);

/** One question in the old shape, from a connection's view. */
const entryOf = (
  feed: Feed,
  room: RoomFeeds,
  view: CommittedView,
  id: string,
): WebinarQaEntry | null => {
  const own = ownOf(view, id);
  const shared = view.get("questions", id) as QuestionCard | undefined;
  const question = shared ?? own?.hidden?.question;
  if (!question) return null;
  const votes = view.get("votes", id) as { upvotes: number } | undefined;

  // The old wire names the asker by seat. A viewer is told their own, and a
  // host is told everyone's, as hosts already see who is in the room. Nobody
  // else is handed another person's seat id.
  const userId = own
    ? (feed.context.currentClient?.id ?? "")
    : isHost(feed.context)
      ? (room.askers.get(id) ?? "")
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
    hasUpvoted: view.get("myUpvotes", id) !== undefined,
    ...(question.answerText ? { answerText: question.answerText } : {}),
    ...(question.answeredByName
      ? { answeredByName: question.answeredByName }
      : {}),
  };
};

const questionIds = (view: CommittedView): string[] => [
  ...new Set([...view.keys("questions"), ...view.keys("myQuestions")]),
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
 * Everything a question's old-shape entry depends on for one connection: the
 * rows its role holds, its own row of the question if it asked it, whether
 * it is a host, and whether it upvoted. Two connections with the same
 * reading are sent the same bytes, unless one of them asked the question,
 * and a connection is sent a question again only when its reading changes.
 * The rows of a role are one object for everyone in it, so comparing rows is
 * comparing numbers.
 */
const readingOf = (feed: Feed, view: CommittedView, id: string): string =>
  [
    id,
    numberOf(view.get("questions", id)),
    numberOf(view.get("votes", id)),
    numberOf(view.get("myQuestions", id)),
    isHost(feed.context) ? "h" : "",
    view.get("myUpvotes", id) !== undefined ? "u" : "",
  ].join("|");

type SharedList = { entries: WebinarQaEntry[]; roomId: string; sockets: string[] };
type SharedChange = { payload: WebinarQaChangedNotification; sockets: string[] };

/**
 * Says what is waiting in a room, one slice of sockets a turn.
 *
 * Everything said is read from the connection's view as committed now, and
 * the seat is checked against the room as it is now. A seat removed since
 * the change was noted is sent nothing, and a question hidden since is not
 * said as it was.
 *
 * A changed question reads the same for nearly everyone, so its event is
 * built and encoded once for each distinct reading and written to all the
 * sockets that share it. A whole list is shared the same way by everyone who
 * asked nothing. Only what names its recipient is their own copy.
 *
 * A question is said to a connection only when its reading differs from the
 * one that connection was last sent, so one that changes again while it
 * waits is said once, as it stands. A question that is gone is said to be
 * gone once to each connection that lists it, however many of its rows went
 * with it.
 */
const say = (authority: RoomAuthority, room: RoomFeeds): void => {
  room.scheduled = false;
  let events = 0;
  let lists = 0;
  const changes = new Map<string, SharedChange>();
  const sharedLists = new Map<string, SharedList>();
  const emptied = new Map<string, string[]>();

  for (const feed of room.waiting) {
    if (events >= LEGACY_QA_SENDS_PER_TURN || lists >= LEGACY_QA_LISTS_PER_TURN) {
      break;
    }
    room.waiting.delete(feed);
    const { context, observer } = feed;
    const { socket } = context;

    if (feed.emptyDue) {
      // The seat may no longer see Q&A. An old client keeps a list until it
      // is told otherwise. An empty one carries nothing, so it is safe for
      // any socket that held a list.
      feed.emptyDue = false;
      if (!feed.listDue) {
        feed.pending.clear();
        feed.checkSaved = false;
        feed.said.clear();
        feed.saved.clear();
        if (socket.connected) {
          lists += 1;
          const sockets = emptied.get(feed.roomId);
          if (sockets) sockets.push(socket.id);
          else emptied.set(feed.roomId, [socket.id]);
        }
        continue;
      }
    }

    const live = Boolean(observer?.isLive());
    const channel = context.currentRoom;
    if (!observer || !live || !channel || !isWebinar(context.state, channel.channelId)) {
      // Asking may itself have brought a frame that put the feed back in
      // line, with a list or an empty one due. That stands. Anything else
      // that was waiting is dropped.
      if (!room.waiting.has(feed)) {
        feed.pending.clear();
        feed.listDue = false;
        feed.checkSaved = false;
      }
      continue;
    }
    const view = observer.view();

    if (feed.checkSaved) {
      feed.checkSaved = false;
      for (const id of feed.saved) {
        if (view.get("myUpvotes", id) !== undefined) continue;
        // The book no longer has an upvote this client saved, and not by
        // its own tap. If it still lists the question, a change event
        // cannot make it forget: a whole list can. If the question went
        // too, the saved vote shows nowhere.
        if (feed.said.has(id) && sees(view, id)) feed.listDue = true;
        else feed.saved.delete(id);
      }
    }

    if (feed.listDue) {
      feed.listDue = false;
      feed.pending.clear();
      lists += 1;
      const ids = questionIds(view).filter((id) => sees(view, id));
      const readings = ids.map((id) => readingOf(feed, view, id));
      feed.said = new Map(ids.map((id, index) => [id, readings[index]]));
      feed.saved = new Set(ids.filter((id) => view.get("myUpvotes", id) !== undefined));
      const build = (): WebinarQaEntry[] =>
        ids
          .map((id) => entryOf(feed, room, view, id))
          .filter((entry): entry is WebinarQaEntry => entry !== null)
          .sort((a, b) => a.askedAt - b.askedAt);
      if (view.size("myQuestions") > 0) {
        // It names them as the asker of their own questions.
        socket.emit("webinar:qaSnapshot", {
          roomId: feed.roomId,
          entries: build(),
        } satisfies WebinarQaSnapshot);
        continue;
      }
      const reading = readings.join(";");
      const group = sharedLists.get(reading);
      if (group) group.sockets.push(socket.id);
      else {
        sharedLists.set(reading, {
          entries: build(),
          roomId: feed.roomId,
          sockets: [socket.id],
        });
      }
      continue;
    }

    for (const id of feed.pending) {
      if (!sees(view, id)) {
        if (!feed.said.delete(id)) continue;
        events += 1;
        const gone = changes.get(`gone|${id}`);
        if (gone) gone.sockets.push(socket.id);
        else {
          changes.set(`gone|${id}`, {
            payload: { roomId: feed.roomId, removedId: id },
            sockets: [socket.id],
          });
        }
        continue;
      }
      const reading = readingOf(feed, view, id);
      if (feed.said.get(id) === reading) continue;
      feed.said.set(id, reading);
      events += 1;
      const entry = entryOf(feed, room, view, id);
      if (!entry) continue;
      if (view.get("myQuestions", id) !== undefined) {
        socket.emit("webinar:qaChanged", {
          roomId: feed.roomId,
          entry,
        } satisfies WebinarQaChangedNotification);
        continue;
      }
      const group = changes.get(reading);
      if (group) group.sockets.push(socket.id);
      else {
        changes.set(reading, {
          payload: { roomId: feed.roomId, entry },
          sockets: [socket.id],
        });
      }
    }
    feed.pending.clear();
  }

  // Local: the sockets are all on this server, where the room is.
  const local = room.io.local;
  for (const [roomId, sockets] of emptied) {
    local.to(sockets).emit("webinar:qaSnapshot", {
      roomId,
      entries: [],
    } satisfies WebinarQaSnapshot);
  }
  for (const { entries, roomId, sockets } of sharedLists.values()) {
    local.to(sockets).emit("webinar:qaSnapshot", {
      roomId,
      entries,
    } satisfies WebinarQaSnapshot);
  }
  for (const { payload, sockets } of changes.values()) {
    local.to(sockets).emit("webinar:qaChanged", payload);
  }

  if (room.waiting.size === 0) return;
  room.scheduled = true;
  setImmediate(() => say(authority, room));
};

/** Files a feed under the person its connection is to the app right now. */
const index = (room: RoomFeeds, feed: Feed): void => {
  const subject = feed.observer?.subject() ?? null;
  if (subject === feed.subject) return;
  if (feed.subject !== null) {
    const others = room.bySubject.get(feed.subject);
    others?.delete(feed);
    if (others?.size === 0) room.bySubject.delete(feed.subject);
  }
  feed.subject = subject;
  if (subject === null) return;
  const same = room.bySubject.get(subject);
  if (same) same.add(feed);
  else room.bySubject.set(subject, new Set([feed]));
};

/**
 * Starts the old-wire feed for a connection that has just joined. Returns
 * false when the room does not run the Q&A app, and the caller then sends
 * the snapshot the old way.
 */
export const attachLegacyQaFeed = (context: ConnectionContext): boolean => {
  const authority = qaBookOf(context);
  const channel = context.currentRoom;
  if (!authority || !channel) return false;
  detachLegacyQaFeed(context);
  const room = roomOf(authority, context.io);

  const feed: Feed = {
    context,
    roomId: channel.id,
    observer: null,
    subject: null,
    pending: new Set(),
    listDue: false,
    emptyDue: false,
    checkSaved: false,
    said: new Map(),
    saved: new Set(),
  };

  const sink = (frame: AuthorityFrame): void => {
    if (frame.kind === "revoke") {
      feed.pending.clear();
      feed.listDue = false;
      // A client that lists nothing has nothing to be told to forget.
      if (feed.said.size === 0) return;
      feed.emptyDue = true;
      queue(authority, room, feed);
      return;
    }
    if (frame.kind === "replace") {
      // A whole view. What it holds is read when the list is said.
      if (!frame.last) return;
      index(room, feed);
      feed.listDue = true;
      queue(authority, room, feed);
      return;
    }
    if (frame.kind !== "patch") return;

    for (const ref of [...frame.remove, ...frame.put]) {
      feed.pending.add(ref.key);
      if (ref.bucket === "myUpvotes" && feed.saved.size > 0) feed.checkSaved = true;
    }
    if (feed.pending.size > 0) queue(authority, room, feed);
  };

  // The runtime ends the observer when the seat leaves or the room closes.
  // The room then lets go of the feed. An empty list still waiting for a
  // seat that lost Q&A goes out all the same.
  const forget = (): void => {
    room.all.delete(feed);
    room.toCheck.delete(feed);
    if (!feed.emptyDue) room.waiting.delete(feed);
    if (feed.subject !== null) {
      const others = room.bySubject.get(feed.subject);
      others?.delete(feed);
      if (others?.size === 0) room.bySubject.delete(feed.subject);
      feed.subject = null;
    }
    feed.observer = null;
    if (feeds.get(context.socket) === feed) feeds.delete(context.socket);
  };

  const observer = authority.observe(context, QA_APP, sink, forget);
  if (!observer) return true;
  feed.observer = observer;
  index(room, feed);
  room.all.add(feed);
  feeds.set(context.socket, feed);
  return true;
};

/** Ends a connection's old-wire feed, before a new one takes its place. */
const detachLegacyQaFeed = (context: ConnectionContext): void => {
  feeds.get(context.socket)?.observer?.close();
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

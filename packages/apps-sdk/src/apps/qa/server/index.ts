import { boundedJsonBytes } from "@conclave/apps-sdk/authority";
import {
  QA_MAX_BOOK_BYTES,
  QA_MAX_ENTRIES,
  QA_MAX_OPEN_PER_PERSON,
  QA_MIN_QUESTION_LENGTH,
  isQaStatusPublic,
  qaContract,
  type QaMode,
  type QaStatus,
  type QuestionCard,
} from "@conclave/apps-sdk/qa/core";
import {
  defineAuthority,
  key,
  reject,
  table,
  type AuthorityTransaction,
  type GateContext,
  type IdentityRequirement,
  type RoomPolicy,
  type Subject,
  type TableKey,
  type TableSpec,
} from "@conclave/apps-sdk/authority/server";

/**
 * The Q&A rules. One book serves meetings and webinars, and stays the same
 * book when a host turns webinar mode on or off: only who may see and ask
 * changes.
 */
type QuestionRow = QuestionCard & {
  author: Subject;
  upvotes: number;
  askedIn: QaMode;
};

type Upvote = { questionId: string; voter: Subject };

type QaTables = {
  questions: TableSpec<QuestionRow>;
  upvotes: TableSpec<Upvote>;
};

/** Upvotes a room can hold across all its questions. */
const MAX_UPVOTES = 200_000;

const card = (row: QuestionRow): QuestionCard => ({
  id: row.id,
  askerName: row.askerName,
  text: row.text,
  status: row.status,
  askedAt: row.askedAt,
  updatedAt: row.updatedAt,
  answerText: row.answerText,
  answeredByName: row.answeredByName,
});

const isPublic = (row: QuestionRow, room: RoomPolicy): boolean =>
  isQaStatusPublic(row.status, row.askedIn) && isQaStatusPublic(row.status, room.mode);

/**
 * Hosts see every question, askers their own, everyone the public ones. A
 * question a host has hidden is the exception: only hosts see it, and its
 * asker loses it like everyone else.
 */
const isVisibleTo = (row: QuestionRow, ctx: GateContext): boolean =>
  ctx.role === "moderator" ||
  (row.status !== "dismissed" &&
    (row.author === ctx.subject || isPublic(row, ctx.room)));

/**
 * Who may ask and upvote: attendees of a webinar while the host has Q&A on,
 * or everyone in a regular meeting.
 */
const mayContribute = (ctx: GateContext): boolean =>
  ctx.room.mode === "webinar"
    ? ctx.role === "attendee" && ctx.room.qaEnabled
    : ctx.role === "member" || ctx.role === "moderator";

/**
 * Webinar Q&A has always counted a guest per session, and released webinar
 * clients depend on that. Meeting Q&A is new and counts one verified person.
 */
const contributorIdentity = (ctx: GateContext): IdentityRequirement =>
  ctx.room.mode === "webinar" ? "any" : "verified";

type QaTransaction = AuthorityTransaction<QaTables, Record<never, never>>;

/**
 * The question a caller may vote on. People may only vote on questions they
 * can see, and a hidden question answers exactly like one that does not
 * exist.
 */
const votable = (
  ctx: GateContext,
  tx: QaTransaction,
  id: string,
): QuestionRow | null => {
  const question = tx.get("questions", key(id));
  return question && question.status !== "dismissed" && isVisibleTo(question, ctx)
    ? question
    : null;
};

/**
 * Sets whether the caller upvotes a question, and returns the question's
 * count afterwards. One upvote per person per question: the key is both, so
 * setting the same state twice changes nothing.
 */
const setUpvote = (
  ctx: GateContext,
  tx: QaTransaction,
  question: QuestionRow,
  value: boolean,
): number => {
  const voteKey = key(question.id, ctx.subject);
  const changed = value
    ? tx.insertIfAbsent("upvotes", voteKey, {
        questionId: question.id,
        voter: ctx.subject,
      }) === "inserted"
    : tx.delete("upvotes", voteKey);
  if (!changed) return question.upvotes;
  const upvotes = question.upvotes + (value ? 1 : -1);
  tx.put("questions", key(question.id), { ...question, upvotes });
  return upvotes;
};

/**
 * Trims the book to its caps on count and on size: hidden questions first,
 * then answered, then waiting, then whatever is oldest. `keep` is the
 * question being written, which is the last to go. A dropped question takes
 * its upvotes with it, and leaves every list on the next flush.
 *
 * The size cap is what keeps the book openable. Without it 300 long
 * questions with long answers outgrow the largest view the runtime sends,
 * and a host who joins late is refused the whole book.
 */
const trimBook = (tx: QaTransaction, keep: string): void => {
  const rows = tx.scan("questions");
  const sizes = new Map<TableKey, number>();
  let bytes = 0;
  for (const [rowKey, row] of rows) {
    const size = boundedJsonBytes(card(row), QA_MAX_BOOK_BYTES);
    sizes.set(rowKey, size);
    bytes += size;
  }
  const fits = (): boolean =>
    sizes.size <= QA_MAX_ENTRIES && bytes <= QA_MAX_BOOK_BYTES;

  const order: (QaStatus | null)[] = ["dismissed", "answered", "pending", null];
  for (const wanted of order) {
    for (const [rowKey, row] of rows) {
      if (fits()) return;
      if (row.id === keep || !sizes.has(rowKey)) continue;
      if (wanted !== null && row.status !== wanted) continue;
      // One step, whatever the number of upvotes. Read and deleted one at
      // a time, the upvotes of a few questions a large webinar upvoted
      // would use up the transaction and fail the write that needed room.
      tx.clear("upvotes", key(row.id));
      tx.delete("questions", rowKey);
      bytes -= sizes.get(rowKey) ?? 0;
      sizes.delete(rowKey);
    }
  }
};

export const qaAuthority = defineAuthority({
  contract: qaContract,
  tables: {
    // One over the cap, so a new question lands before an old one is dropped.
    questions: table<QuestionRow>({ maxRows: QA_MAX_ENTRIES + 1 }),
    upvotes: table<Upvote>({ maxRows: MAX_UPVOTES }),
  },
  timers: {},
  canView: ({ role }, room) =>
    role === "moderator" ||
    role === "member" ||
    (role === "attendee" && room.mode === "webinar"),
  actions: {
    ask: {
      roles: ["moderator", "member", "attendee"],
      when: mayContribute,
      identity: contributorIdentity,
      // A short burst, then one question every ten seconds.
      rate: { burst: 3, perSecond: 0.1 },
      run(ctx, tx, input) {
        if (input.text.length < QA_MIN_QUESTION_LENGTH) reject("too-short");
        const open = tx
          .scan("questions")
          .filter(
            ([, row]) =>
              row.author === ctx.subject &&
              (row.status === "pending" || row.status === "answering"),
          ).length;
        if (open >= QA_MAX_OPEN_PER_PERSON) reject("too-many-open");
        const id = ctx.nextId("q");
        tx.insertIfAbsent("questions", key(id), {
          id,
          author: ctx.subject,
          askerName: ctx.displayName,
          text: input.text,
          status: "pending",
          askedAt: ctx.now,
          updatedAt: ctx.now,
          upvotes: 0,
          answerText: null,
          answeredByName: null,
          askedIn: ctx.room.mode,
        });
        trimBook(tx, id);
        return { id };
      },
    },
    upvote: {
      roles: ["moderator", "member", "attendee"],
      when: mayContribute,
      identity: contributorIdentity,
      rate: { burst: 10, perSecond: 2 },
      run(ctx, tx, input) {
        const question = votable(ctx, tx, input.id);
        if (!question) return reject("not-found");
        setUpvote(ctx, tx, question, input.value);
        return null;
      },
    },
    toggleUpvote: {
      roles: ["moderator", "member", "attendee"],
      when: mayContribute,
      identity: contributorIdentity,
      rate: { burst: 10, perSecond: 2 },
      run(ctx, tx, input) {
        const question = votable(ctx, tx, input.id);
        if (!question) return reject("not-found");
        const hasUpvoted =
          tx.get("upvotes", key(input.id, ctx.subject)) === undefined;
        return {
          upvotes: setUpvote(ctx, tx, question, hasUpvoted),
          hasUpvoted,
        };
      },
    },
    moderate: {
      roles: ["moderator"],
      identity: "any",
      rate: { burst: 40, perSecond: 8 },
      run(ctx, tx, input) {
        const question = tx.get("questions", key(input.id));
        if (!question) return reject("not-found");
        const next: QuestionRow = { ...question, updatedAt: ctx.now };
        switch (input.action) {
          case "answering":
            next.status = "answering";
            next.answeredByName = ctx.displayName;
            break;
          case "answered":
            next.status = "answered";
            next.answeredByName = ctx.displayName;
            if (input.answerText !== undefined) {
              next.answerText = input.answerText || null;
            }
            break;
          case "dismissed":
            next.status = "dismissed";
            break;
          case "reopen":
            next.status = "pending";
            break;
        }
        tx.put("questions", key(question.id), next);
        // An answer can be twice the length of its question.
        trimBook(tx, question.id);
        return null;
      },
    },
  },
  queries: {},
  onTimer: {},
  views: {
    questions: {
      kind: "shared",
      source: "questions",
      project: (row, role, room) =>
        role === "moderator" || isPublic(row, room)
          ? { key: row.id, value: card(row) }
          : null,
    },
    // The same row projected again with only its count. An upvote changes
    // this small row and not the card.
    votes: {
      kind: "shared",
      source: "questions",
      project: (row, role, room) =>
        role === "moderator" || isPublic(row, room)
          ? { key: row.id, value: { upvotes: row.upvotes } }
          : null,
    },
    myQuestions: {
      kind: "personal",
      source: "questions",
      owner: (row) => row.author,
      // A question a host has hidden is in no participant's view, its
      // asker's included: it is gone for them, with nothing to say why.
      // Hosts keep it in the shared list, where they can bring it back.
      project: (row, room) =>
        row.status === "dismissed"
          ? null
          : {
              key: row.id,
              value: {
                hidden: isPublic(row, room)
                  ? null
                  : { question: card(row), upvotes: row.upvotes },
              },
            },
    },
    myUpvotes: {
      kind: "personal",
      source: "upvotes",
      owner: (row) => row.voter,
      project: (row) => ({ key: row.questionId, value: {} }),
    },
  },
});

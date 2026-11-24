/**
 * Q&A on the authority runtime, as a test fixture: one book, two audience
 * rules. In a webinar, attendees ask and a question becomes public when a
 * host takes it. In a meeting, everyone asks and a question is public until
 * a host dismisses it.
 */
import { defineContract, s, type Infer } from "@conclave/apps-sdk/authority";
import {
  defineAuthority,
  key,
  reject,
  table,
  type AuthorityTransaction,
  type GateContext,
  type RoomPolicy,
  type Subject,
  type TableSpec,
} from "@conclave/apps-sdk/authority/server";
import { actionOrderTable, nextActionOrder } from "./action-order.js";

const QA_MAX_ENTRIES = 300;
const QA_MAX_OPEN_PER_PERSON = 3;

const questionId = s.string({ min: 1, max: 64 });
const status = s.oneOf(["pending", "answering", "answered", "dismissed"]);
const questionCard = s.object({
  id: questionId,
  askerName: s.string({ max: 200 }),
  text: s.string({ max: 500 }),
  status,
  askedAt: s.number(),
  updatedAt: s.number(),
  upvotes: s.int({ min: 0 }),
  answerText: s.nullable(s.string({ max: 1000 })),
  answeredByName: s.nullable(s.string({ max: 200 })),
});

export const qaContract = defineContract({
  id: "qa",
  major: 1,
  surface: "panel",
  actions: {
    ask: {
      input: s.object({
        text: s.string({ max: 500, collapse: true, truncate: true }),
      }),
      receipt: s.object({ id: questionId }),
    },
    upvote: {
      // The wanted state, not a toggle, so a repeated send changes nothing.
      input: s.object({ id: questionId, value: s.boolean() }),
      receipt: s.null(),
    },
    moderate: {
      input: s.object({
        id: questionId,
        action: s.oneOf(["answering", "answered", "dismissed", "reopen"]),
        answerText: s.optional(
          s.string({ max: 1000, collapse: true, truncate: true }),
        ),
      }),
      receipt: s.null(),
    },
  },
  queries: {},
  views: {
    /** Every question for hosts; the public ones for everyone else. */
    questions: questionCard,
    /** Marks a question as mine, and carries it when my list would not. */
    myQuestions: s.object({ hidden: s.nullable(questionCard) }),
    myUpvotes: s.object({}),
  },
});

type QuestionCard = Infer<typeof questionCard>;
type QaStatus = QuestionCard["status"];
type QuestionRow = QuestionCard & {
  author: Subject;
  order: number;
  openTimes: { order: number; open: boolean }[];
};
type Upvote = { questionId: string; voter: Subject };
type QaTables = {
  questions: TableSpec<QuestionRow>;
  questionsByAuthor: TableSpec<{ id: string }>;
  upvotes: TableSpec<Upvote>;
  upvotesByVoter: TableSpec<{ questionId: string }>;
  order: TableSpec<{ last: number }>;
};

const isOpenStatus = (status: QaStatus): boolean => status === "pending" || status === "answering";

const openAt = (row: QuestionRow, order: number): boolean => {
  let open = false;
  for (const change of row.openTimes) {
    if (change.order >= order) break;
    open = change.open;
  }
  return open;
};

const PUBLIC_STATUSES: Record<RoomPolicy["mode"], readonly QaStatus[]> = {
  webinar: ["answering", "answered"],
  meeting: ["pending", "answering", "answered"],
};

const isPublic = (row: QuestionRow, room: RoomPolicy): boolean =>
  PUBLIC_STATUSES[room.mode].includes(row.status);

const card = (row: QuestionRow): QuestionCard => ({
  id: row.id,
  askerName: row.askerName,
  text: row.text,
  status: row.status,
  askedAt: row.askedAt,
  updatedAt: row.updatedAt,
  upvotes: row.upvotes,
  answerText: row.answerText,
  answeredByName: row.answeredByName,
});

/** Who may ask and upvote: attendees of a webinar with Q&A on, or meeting members. */
const mayContribute = (ctx: GateContext): boolean =>
  ctx.room.mode === "webinar"
    ? ctx.role === "attendee" && ctx.room.qaEnabled
    : ctx.role === "member" || ctx.role === "moderator";

/**
 * Webinar Q&A has always been per session for guests, and old webinar
 * clients depend on that. Meeting Q&A is new and needs a verified person.
 */
const contributorIdentity = (ctx: GateContext) =>
  ctx.room.mode === "webinar" ? "any" : "verified";

/** Over the cap, drop dismissed first, then answered, then pending, then oldest. */
const evictOverflow = (tx: AuthorityTransaction<QaTables, Record<never, never>>): void => {
  const order: (QaStatus | null)[] = ["dismissed", "answered", "pending", null];
  for (const wanted of order) {
    for (const [rowKey, row] of tx.scan("questions")) {
      if (tx.count("questions") <= QA_MAX_ENTRIES) return;
      if (wanted !== null && row.status !== wanted) continue;
      // One step, whatever the number of upvotes: a question a whole
      // webinar upvoted must not use up the asker's transaction.
      tx.clear("upvotes", key(row.id));
      tx.delete("questions", rowKey);
      tx.delete("questionsByAuthor", key(row.author, row.id));
    }
  }
};

export const qaAuthority = defineAuthority({
  contract: qaContract,
  tables: {
    questions: table<QuestionRow>({ maxRows: QA_MAX_ENTRIES + 1 }),
    questionsByAuthor: table<{ id: string }>({ maxRows: QA_MAX_ENTRIES + 1 }),
    upvotes: table<Upvote>({ maxRows: 200_000 }),
    upvotesByVoter: table<{ questionId: string }>({ maxRows: 200_000 }),
    order: actionOrderTable(),
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
        if (input.text.length < 2) reject("too-short");
        const open = tx
          .scan("questions")
          .filter(
            ([, row]) =>
              row.author === ctx.subject &&
              (row.status === "pending" || row.status === "answering"),
          ).length;
        if (open >= QA_MAX_OPEN_PER_PERSON) reject("too-many-open");
        const id = ctx.nextId("q");
        const order = nextActionOrder(tx);
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
          order,
          openTimes: [{ order, open: true }],
        });
        tx.put("questionsByAuthor", key(ctx.subject, id), { id });
        evictOverflow(tx);
        return { id };
      },
    },
    upvote: {
      roles: ["moderator", "member", "attendee"],
      when: mayContribute,
      identity: contributorIdentity,
      rate: { burst: 10, perSecond: 2 },
      run(ctx, tx, input) {
        const question = tx.get("questions", key(input.id));
        // People may only vote on questions they can see.
        const visible =
          question &&
          question.status !== "dismissed" &&
          (ctx.role === "moderator" ||
            question.author === ctx.subject ||
            isPublic(question, ctx.room));
        if (!question || !visible) return reject("not-found");

        const voteKey = key(input.id, ctx.subject);
        if (input.value) {
          const inserted = tx.insertIfAbsent("upvotes", voteKey, {
            questionId: input.id,
            voter: ctx.subject,
          });
          if (inserted === "exists") return null;
          tx.put("upvotesByVoter", key(ctx.subject, input.id), { questionId: input.id });
        } else if (!tx.delete("upvotes", voteKey)) {
          return null;
        } else {
          tx.delete("upvotesByVoter", key(ctx.subject, input.id));
        }
        tx.put("questions", key(question.id), {
          ...question,
          upvotes: question.upvotes + (input.value ? 1 : -1),
          updatedAt: ctx.now,
        });
        return null;
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
        if (isOpenStatus(question.status) !== isOpenStatus(next.status)) {
          next.openTimes = [...question.openTimes, { order: nextActionOrder(tx), open: isOpenStatus(next.status) }];
        }
        tx.put("questions", key(question.id), next);
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
    myQuestions: {
      kind: "personal",
      source: "questions",
      owner: (row) => row.author,
      project: (row, room) => ({
        key: row.id,
        value: { hidden: isPublic(row, room) ? null : card(row) },
      }),
    },
    myUpvotes: {
      kind: "personal",
      source: "upvotes",
      owner: (row) => row.voter,
      project: (row) => ({ key: row.questionId, value: {} }),
    },
  },
  mergeSubjects(_ctx, tx, { from, into }) {
    const fromIds = tx.scan("questionsByAuthor", key(from)).map(([, row]) => row.id);
    const intoIds = tx.scan("questionsByAuthor", key(into)).map(([, row]) => row.id);
    for (const id of fromIds) tx.delete("questionsByAuthor", key(from, id));
    const asked = [...intoIds, ...fromIds]
      .map((id) => tx.get("questions", key(id)))
      .filter((row): row is QuestionRow => row !== undefined)
      .sort((a, b) => a.order - b.order);
    const kept: QuestionRow[] = [];
    for (const question of asked) {
      const open = kept.filter((other) => openAt(other, question.order)).length;
      if (open >= QA_MAX_OPEN_PER_PERSON) {
        tx.delete("questions", key(question.id));
        tx.clear("upvotes", key(question.id));
        tx.delete("questionsByAuthor", key(into, question.id));
        continue;
      }
      kept.push(question);
      if (question.author === from) {
        tx.put("questions", key(question.id), { ...question, author: into });
        tx.put("questionsByAuthor", key(into, question.id), { id: question.id });
      }
    }
    for (const [, { questionId }] of tx.scan("upvotesByVoter", key(from))) {
      tx.delete("upvotesByVoter", key(from, questionId));
      const upvote = tx.get("upvotes", key(questionId, from));
      if (!upvote) continue;
      tx.delete("upvotes", key(questionId, from));
      tx.put("upvotesByVoter", key(into, questionId), { questionId });
      if (tx.insertIfAbsent("upvotes", key(questionId, into), { ...upvote, voter: into }) === "inserted") {
        continue;
      }
      const question = tx.get("questions", key(questionId));
      if (question) {
        tx.put("questions", key(question.id), { ...question, upvotes: Math.max(0, question.upvotes - 1) });
      }
    }
    return undefined;
  },
});

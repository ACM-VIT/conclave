import { defineContract, s, type Infer } from "@conclave/apps-sdk/authority";

export const QA_MIN_QUESTION_LENGTH = 2;
export const QA_MAX_QUESTION_LENGTH = 500;
export const QA_MAX_ANSWER_LENGTH = 1000;
export const QA_MAX_ENTRIES = 300;
/**
 * The most the book's questions may weigh together, as JSON. The runtime
 * sends a view of at most 1 MiB, and a viewer can be sent a question twice:
 * in the shared list, and as their own while it waits in a webinar. So
 * the book stays under half of that, with room for the small rows beside it.
 */
export const QA_MAX_BOOK_BYTES = 400 * 1024;
export const QA_MAX_OPEN_PER_PERSON = 3;

const questionId = s.string({ min: 1, max: 64 });
const name = s.string({ max: 200 });

const questionCard = s.object({
  id: questionId,
  askerName: name,
  text: s.string({ max: QA_MAX_QUESTION_LENGTH }),
  status: s.oneOf(["pending", "answering", "answered", "dismissed"]),
  askedAt: s.number(),
  /** When the question or its status last changed. Upvotes do not move it. */
  updatedAt: s.number(),
  answerText: s.nullable(s.string({ max: QA_MAX_ANSWER_LENGTH })),
  answeredByName: s.nullable(name),
});

const questionVotes = s.object({ upvotes: s.int({ min: 0 }) });

/**
 * Q&A: one book of questions per room, under two audience rules. In a
 * webinar, attendees ask and a question becomes public when a host takes it.
 * In a meeting, everyone asks and a question is public until a host hides it.
 */
export const qaContract = defineContract({
  id: "qa",
  major: 1,
  surface: "panel",
  actions: {
    ask: {
      input: s.object({
        text: s.string({
          max: QA_MAX_QUESTION_LENGTH,
          collapse: true,
          truncate: true,
        }),
      }),
      receipt: s.object({ id: questionId }),
    },
    upvote: {
      // The wanted state, not a toggle, so sending it twice changes nothing.
      input: s.object({ id: questionId, value: s.boolean() }),
      receipt: s.null(),
    },
    /**
     * Flips the caller's upvote, for the released clients whose upvote is a
     * toggle. The receipt is the count and the caller's vote as this action
     * left them. New code sends `upvote` with the state it wants.
     */
    toggleUpvote: {
      input: s.object({ id: questionId }),
      receipt: s.object({ upvotes: s.int({ min: 0 }), hasUpvoted: s.boolean() }),
    },
    moderate: {
      input: s.object({
        id: questionId,
        action: s.oneOf(["answering", "answered", "dismissed", "reopen"]),
        answerText: s.optional(
          s.string({ max: QA_MAX_ANSWER_LENGTH, collapse: true, truncate: true }),
        ),
      }),
      receipt: s.null(),
    },
  },
  queries: {},
  views: {
    /** Every question for hosts; the public ones for everyone else. */
    questions: questionCard,
    /** Upvote counts, keyed by question, for the questions a viewer sees. */
    votes: questionVotes,
    /**
     * The viewer's own questions. `hidden` carries one the shared list leaves
     * out for them, which is one still waiting for a host in a webinar. A
     * question a host has hidden is not here at all.
     */
    myQuestions: s.object({
      hidden: s.nullable(
        s.object({ question: questionCard, upvotes: s.int({ min: 0 }) }),
      ),
    }),
    /** Present for each question the viewer upvoted. */
    myUpvotes: s.object({}),
  },
});

export type QuestionCard = Infer<typeof questionCard>;
export type QaStatus = QuestionCard["status"];
export type QaModerateAction = "answering" | "answered" | "dismissed" | "reopen";
export type QaMode = "meeting" | "webinar";

const PUBLIC_STATUSES: Record<QaMode, readonly QaStatus[]> = {
  webinar: ["answering", "answered"],
  meeting: ["pending", "answering", "answered"],
};

/** Public questions reach the whole room; the rest only hosts and the asker. */
export const isQaStatusPublic = (status: QaStatus, mode: QaMode): boolean =>
  PUBLIC_STATUSES[mode].includes(status);

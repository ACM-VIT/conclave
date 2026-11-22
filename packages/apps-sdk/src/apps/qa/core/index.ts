import { defineContract, s, type Infer } from "@conclave/apps-sdk/authority";

export const QA_MIN_QUESTION_LENGTH = 2;
export const QA_MAX_QUESTION_LENGTH = 500;
export const QA_MAX_ANSWER_LENGTH = 1000;
export const QA_MAX_ENTRIES = 300;
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
  queries: {
    /** A visible question's count and whether the caller upvoted it. */
    upvoteState: {
      input: s.object({ id: questionId }),
      output: s.object({ upvotes: s.int({ min: 0 }), hasUpvoted: s.boolean() }),
    },
  },
  views: {
    /** Every question for hosts; the public ones for everyone else. */
    questions: questionCard,
    /** Upvote counts, keyed by question, for the questions a viewer sees. */
    votes: questionVotes,
    /**
     * The viewer's own questions. `hidden` carries one the shared list leaves
     * out for them: still waiting in a webinar, or hidden by a host.
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

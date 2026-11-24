/**
 * A quiz with timed rounds and hidden answers, as a test fixture. It shows
 * what polls and Q&A do not need: a server timer, and a secret no view
 * carries until the rules reveal it.
 */
import { defineContract, s, type Infer } from "@conclave/apps-sdk/authority";
import {
  actionOrderTable,
  defineAuthority,
  key,
  nextActionOrder,
  reject,
  table,
  type Subject,
} from "@conclave/apps-sdk/authority/server";

const REVEAL_MS = 5_000;
const BASE_POINTS = 500;
const SPEED_POINTS = 500;
const STATE = key("state");

const publicQuiz = s.object({
  phase: s.oneOf(["lobby", "question", "reveal", "results"]),
  index: s.int({ min: 0 }),
  total: s.int({ min: 0 }),
  deadline: s.number(),
  question: s.nullable(
    s.object({
      prompt: s.string({ max: 300 }),
      choices: s.array(s.string({ max: 120 }), { max: 6 }),
      /** Null until the round is revealed. */
      correct: s.nullable(s.int({ min: 0 })),
    }),
  ),
  answered: s.int({ min: 0 }),
  leaderboard: s.nullable(
    s.array(s.object({ name: s.string({ max: 200 }), score: s.int() }), {
      max: 10,
    }),
  ),
});

const questionInput = s.object({
  prompt: s.string({ min: 1, max: 300, collapse: true }),
  choices: s.array(s.string({ min: 1, max: 120, collapse: true }), {
    min: 2,
    max: 6,
  }),
  answer: s.int({ min: 0, max: 5 }),
});

export const quizContract = defineContract({
  id: "quiz",
  major: 1,
  surface: "panel",
  actions: {
    load: {
      input: s.object({
        secondsPerQuestion: s.int({ min: 5, max: 120 }),
        questions: s.array(questionInput, { min: 1, max: 30 }),
      }),
      receipt: s.null(),
    },
    begin: { input: s.null(), receipt: s.null() },
    answer: { input: s.object({ choice: s.int({ min: 0, max: 5 }) }), receipt: s.null() },
    endRound: { input: s.null(), receipt: s.null() },
  },
  queries: {},
  views: {
    quiz: publicQuiz,
    myAnswer: s.object({ choice: s.int({ min: 0 }) }),
    myScore: s.object({ score: s.int() }),
  },
});

type QuizQuestion = Infer<typeof questionInput>;
type QuizState = {
  phase: "lobby" | "question" | "reveal" | "results";
  /** The answer key lives here and nowhere else. */
  questions: QuizQuestion[];
  index: number;
  secondsPerQuestion: number;
  deadline: number;
  answered: number;
  leaderboard: Leaderboard | null;
};
type Answer = { round: number; subject: Subject; choice: number; at: number; order: number; points: number };
type Standing = { subject: Subject; name: string; score: number };
type Leaderboard = { standings: Standing[]; complete: boolean };

const LEADERBOARD_SHOWN = 10;
const LEADERBOARD_KEPT = 20;

const byStanding = (a: Standing, b: Standing): number =>
  b.score - a.score || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0);
type Score = { subject: Subject; name: string; score: number };

const initial: QuizState = {
  phase: "lobby",
  questions: [],
  index: 0,
  secondsPerQuestion: 20,
  deadline: 0,
  answered: 0,
  leaderboard: null,
};

const leaderboardOf = (tx: { scan(table: "scores"): readonly (readonly [unknown, Score])[] }): Leaderboard => {
  const standings = tx
    .scan("scores")
    .map(([, row]) => ({ subject: row.subject, name: row.name, score: row.score }))
    .sort(byStanding);
  return { standings: standings.slice(0, LEADERBOARD_KEPT), complete: standings.length <= LEADERBOARD_KEPT };
};

const mergedLeaderboard = (
  tx: { scan(table: "scores"): readonly (readonly [unknown, Score])[] },
  board: Leaderboard,
  gone: readonly Subject[],
  merged: Score | null,
): Leaderboard => {
  const lowest = board.standings[board.standings.length - 1];
  const standings = board.standings.filter((entry) => !gone.includes(entry.subject));
  if (merged) {
    const entry = { subject: merged.subject, name: merged.name, score: merged.score };
    if (board.complete || !lowest || byStanding(entry, lowest) <= 0) standings.push(entry);
  }
  if (!board.complete && standings.length < LEADERBOARD_SHOWN) return leaderboardOf(tx);
  return { standings: standings.sort(byStanding), complete: board.complete };
};

export const quizAuthority = defineAuthority({
  contract: quizContract,
  tables: {
    quiz: table<QuizState>({ maxRows: 1, maxRowBytes: 64 * 1024 }),
    answers: table<Answer>({ maxRows: 30 * 1_000 }),
    answersBySubject: table<{ round: number }>({ maxRows: 30 * 1_000 }),
    scores: table<Score>({ maxRows: 1_000 }),
    order: actionOrderTable(),
  },
  timers: { advance: s.object({ round: s.int({ min: 0 }), phase: s.string({ max: 16 }) }) },
  canView: ({ role }) => role === "moderator" || role === "member",
  actions: {
    load: {
      roles: ["moderator"],
      identity: "any",
      rate: { burst: 5, perSecond: 1 },
      run(_ctx, tx, input) {
        const state = tx.get("quiz", STATE) ?? initial;
        if (state.phase !== "lobby") reject("already-started");
        if (input.questions.some((q) => q.answer >= q.choices.length)) {
          reject("invalid-answer-key");
        }
        tx.put("quiz", STATE, {
          ...state,
          questions: input.questions,
          secondsPerQuestion: input.secondsPerQuestion,
        });
        return null;
      },
    },
    begin: {
      roles: ["moderator"],
      identity: "any",
      rate: { burst: 5, perSecond: 1 },
      run(ctx, tx) {
        const state = tx.get("quiz", STATE) ?? initial;
        if (state.phase !== "lobby" || state.questions.length === 0) {
          reject("not-ready");
        }
        const deadline = ctx.now + state.secondsPerQuestion * 1000;
        tx.put("quiz", STATE, {
          ...state,
          phase: "question",
          index: 0,
          answered: 0,
          deadline,
        });
        tx.schedule("advance", STATE, deadline, { round: 0, phase: "question" });
        return null;
      },
    },
    answer: {
      roles: ["moderator", "member"],
      rate: { burst: 10, perSecond: 2 },
      run(ctx, tx, input) {
        const state = tx.get("quiz", STATE);
        const question = state?.questions[state.index];
        // The server's clock decides, not the client's.
        if (!state || !question || state.phase !== "question" || ctx.now >= state.deadline) {
          return reject("not-open");
        }
        if (input.choice >= question.choices.length) reject("invalid-choice");
        // One answer per person per round: the key is the round and the person.
        const inserted = tx.insertIfAbsent(
          "answers",
          key(String(state.index), ctx.subject),
          { round: state.index, subject: ctx.subject, choice: input.choice, at: ctx.now, order: nextActionOrder(tx), points: 0 },
        );
        if (inserted === "exists") reject("already-answered");
        tx.put("answersBySubject", key(ctx.subject, String(state.index)), { round: state.index });
        tx.insertIfAbsent("scores", key(ctx.subject), {
          subject: ctx.subject,
          name: ctx.displayName,
          score: 0,
        });
        tx.put("quiz", STATE, { ...state, answered: state.answered + 1 });
        return null;
      },
    },
    endRound: {
      roles: ["moderator"],
      identity: "any",
      rate: { burst: 5, perSecond: 1 },
      run(ctx, tx) {
        const state = tx.get("quiz", STATE);
        if (!state || state.phase !== "question") return reject("not-open");
        // Bring the deadline forward. The timer does the rest, as always.
        tx.put("quiz", STATE, { ...state, deadline: ctx.now });
        tx.schedule("advance", STATE, ctx.now, { round: state.index, phase: "question" });
        return null;
      },
    },
  },
  queries: {},
  onTimer: {
    advance(ctx, tx, payload) {
      const state = tx.get("quiz", STATE);
      // A timer for a round or phase that has moved on does nothing.
      if (!state || state.index !== payload.round || state.phase !== payload.phase) {
        return;
      }
      if (ctx.now < state.deadline) {
        tx.schedule("advance", STATE, state.deadline, payload);
        return;
      }
      if (state.phase === "question") {
        const question = state.questions[state.index];
        const roundMs = state.secondsPerQuestion * 1000;
        for (const [, given] of tx.scan("answers", key(String(state.index)))) {
          if (given.choice !== question.answer) continue;
          const left = Math.max(0, state.deadline - given.at);
          const score = tx.get("scores", key(given.subject));
          if (!score) continue;
          const points = BASE_POINTS + Math.round((SPEED_POINTS * Math.min(left, roundMs)) / roundMs);
          tx.put("answers", key(String(given.round), given.subject), { ...given, points });
          tx.put("scores", key(given.subject), { ...score, score: score.score + points });
        }
        const leaderboard = leaderboardOf(tx);
        const deadline = ctx.now + REVEAL_MS;
        tx.put("quiz", STATE, { ...state, phase: "reveal", deadline, leaderboard });
        tx.schedule("advance", STATE, deadline, { round: state.index, phase: "reveal" });
        return;
      }
      if (state.phase !== "reveal") return;
      if (state.index + 1 >= state.questions.length) {
        tx.put("quiz", STATE, { ...state, phase: "results", deadline: 0 });
        return;
      }
      const deadline = ctx.now + state.secondsPerQuestion * 1000;
      tx.put("quiz", STATE, {
        ...state,
        phase: "question",
        index: state.index + 1,
        answered: 0,
        deadline,
        leaderboard: null,
      });
      tx.schedule("advance", STATE, deadline, { round: state.index + 1, phase: "question" });
    },
  },
  views: {
    quiz: {
      kind: "shared",
      source: "quiz",
      project(state) {
        const question = state.questions[state.index];
        const revealed = state.phase === "reveal" || state.phase === "results";
        return {
          key: "state",
          value: {
            phase: state.phase,
            index: state.index,
            total: state.questions.length,
            deadline: state.deadline,
            // The answer key reaches a view only through this line.
            question:
              question && state.phase !== "lobby"
                ? {
                    prompt: question.prompt,
                    choices: [...question.choices],
                    correct: revealed ? question.answer : null,
                  }
                : null,
            answered: state.answered,
            leaderboard:
              revealed && state.leaderboard
                ? state.leaderboard.standings
                    .slice(0, LEADERBOARD_SHOWN)
                    .map(({ name, score }) => ({ name, score }))
                : null,
          },
        };
      },
    },
    myAnswer: {
      kind: "personal",
      source: "answers",
      owner: (row) => row.subject,
      project: (row) => ({ key: String(row.round), value: { choice: row.choice } }),
    },
    myScore: {
      kind: "personal",
      source: "scores",
      owner: (row) => row.subject,
      project: (row) => ({ key: "score", value: { score: row.score } }),
    },
  },
  mergeSubjects(_ctx, tx, { from, into }) {
    const state = tx.get("quiz", STATE);
    let answeredDropped = 0;
    for (const [, { round }] of tx.scan("answersBySubject", key(from))) {
      tx.delete("answersBySubject", key(from, String(round)));
      const mine = tx.get("answers", key(String(round), from));
      if (!mine) continue;
      tx.delete("answers", key(String(round), from));
      tx.put("answersBySubject", key(into, String(round)), { round });
      const kept = tx.get("answers", key(String(round), into));
      if (kept && state && round === state.index) answeredDropped += 1;
      if (kept && kept.order < mine.order) continue;
      tx.put("answers", key(String(round), into), { ...mine, subject: into });
    }
    const fromScore = tx.get("scores", key(from));
    const intoScore = tx.get("scores", key(into));
    let merged: Score | null = null;
    if (fromScore || intoScore) {
      tx.delete("scores", key(from));
      const points = tx
        .scan("answersBySubject", key(into))
        .reduce((sum, [, { round }]) => sum + (tx.get("answers", key(String(round), into))?.points ?? 0), 0);
      merged = { ...(intoScore ?? fromScore!), subject: into, score: points };
      tx.put("scores", key(into), merged);
    }
    if (state && (answeredDropped > 0 || state.leaderboard)) {
      tx.put("quiz", STATE, {
        ...state,
        answered: state.answered - answeredDropped,
        leaderboard: state.leaderboard
          ? mergedLeaderboard(tx, state.leaderboard, [from, into], merged)
          : null,
      });
    }
    return undefined;
  },
});

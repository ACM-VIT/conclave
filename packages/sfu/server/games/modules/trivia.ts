import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { payloadField, requireInt } from "../validation.js";
import { numberOption, selectOption } from "../config.js";
import { allActivePlayersActed } from "../roundLoop.js";
import {
  GAME_CONTENT_TOPIC_OPTION,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
  normalizeGeneratedKey,
} from "../aiContent.js";

/**
 * Trivia: a Kahoot/Deezer-style scored quiz.
 *
 * Flow: lobby -> (question -> reveal) x N -> results. The server holds the
 * correct answer and only discloses it during the reveal phase. Points reward
 * both correctness and speed. Timers are driven by `onTick` against a deadline.
 */

const QUESTION_MS = 20_000;
const REVEAL_MS = 6_000;
const QUESTIONS_PER_GAME = 7;
const BASE_POINTS = 500;
const SPEED_POINTS = 500;

type Phase = "lobby" | "question" | "reveal" | "results";

type LoadedQuestion = {
  category: string;
  prompt: string;
  options: string[];
  correctIndex: number;
};

type Answer = { choice: number; at: number };

type TriviaState = {
  phase: Phase;
  questionIndex: number;
  questions: LoadedQuestion[];
  questionStart: number;
  questionMs: number;
  deadline: number;
  answers: Record<string, Answer>;
  scores: Record<string, number>;
  lastRound: Record<string, number>;
};

const PACE_MS: Record<string, number> = { relaxed: 30_000, normal: 20_000, fast: 12_000 };

type RawQuestion = {
  category: string;
  prompt: string;
  options: string[];
  answer: string;
};

const QUESTION_BANK: RawQuestion[] = [
  { category: "Geography", prompt: "Which country has the most natural lakes?", options: ["Canada", "Russia", "Finland", "Brazil"], answer: "Canada" },
  { category: "Science", prompt: "What planet has the most moons?", options: ["Jupiter", "Saturn", "Neptune", "Uranus"], answer: "Saturn" },
  { category: "Film", prompt: "Which film won the first ever Best Picture Oscar?", options: ["Wings", "Sunrise", "Metropolis", "The Jazz Singer"], answer: "Wings" },
  { category: "Music", prompt: "Which instrument has 88 keys?", options: ["Piano", "Organ", "Harpsichord", "Accordion"], answer: "Piano" },
  { category: "History", prompt: "In which year did the Berlin Wall fall?", options: ["1989", "1991", "1987", "1985"], answer: "1989" },
  { category: "Food", prompt: "Which spice is derived from a crocus flower?", options: ["Saffron", "Turmeric", "Paprika", "Cumin"], answer: "Saffron" },
  { category: "Tech", prompt: "What does 'HTTP' stand for?", options: ["HyperText Transfer Protocol", "High Transfer Text Protocol", "HyperText Transport Process", "Hyperlink Text Transfer Path"], answer: "HyperText Transfer Protocol" },
  { category: "Sport", prompt: "How many players are on a standard soccer team on the pitch?", options: ["11", "10", "9", "12"], answer: "11" },
  { category: "Nature", prompt: "What is the largest living structure on Earth?", options: ["Great Barrier Reef", "Amazon Rainforest", "Sahara Desert", "Mount Everest"], answer: "Great Barrier Reef" },
  { category: "Space", prompt: "What is the closest star to Earth?", options: ["The Sun", "Proxima Centauri", "Sirius", "Alpha Centauri"], answer: "The Sun" },
  { category: "Art", prompt: "Who painted 'The Starry Night'?", options: ["Vincent van Gogh", "Claude Monet", "Pablo Picasso", "Edvard Munch"], answer: "Vincent van Gogh" },
  { category: "Language", prompt: "Which language has the most native speakers?", options: ["Mandarin Chinese", "English", "Spanish", "Hindi"], answer: "Mandarin Chinese" },
  { category: "Biology", prompt: "How many chambers does a human heart have?", options: ["4", "2", "3", "5"], answer: "4" },
  { category: "Geography", prompt: "What is the smallest country in the world?", options: ["Vatican City", "Monaco", "Nauru", "San Marino"], answer: "Vatican City" },
  { category: "Chemistry", prompt: "What is the chemical symbol for gold?", options: ["Au", "Ag", "Gd", "Go"], answer: "Au" },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseGeneratedQuestions = (
  payload: unknown,
  minItems = 1,
): RawQuestion[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.questions)) return null;
  const questions: RawQuestion[] = [];
  const seenPrompts = new Set<string>();

  for (const item of payload.questions) {
    if (!isRecord(item)) continue;
    const category = cleanGeneratedText(item.category, 32) ?? "Custom";
    const prompt = cleanGeneratedText(item.prompt, 180);
    const options = Array.isArray(item.options)
      ? item.options
          .map((option) => cleanGeneratedText(option, 80))
          .filter((option): option is string => Boolean(option))
      : [];
    const answer = cleanGeneratedText(item.answer, 80);
    if (!prompt || !answer || options.length !== 4) continue;

    const uniqueOptions: string[] = [];
    const seenOptions = new Set<string>();
    for (const option of options) {
      const key = normalizeGeneratedKey(option);
      if (!key || seenOptions.has(key)) continue;
      seenOptions.add(key);
      uniqueOptions.push(option);
    }
    if (uniqueOptions.length !== 4) continue;

    const normalizedAnswer = normalizeGeneratedKey(answer);
    const matchedAnswer = uniqueOptions.find(
      (option) => normalizeGeneratedKey(option) === normalizedAnswer,
    );
    const promptKey = normalizeGeneratedKey(prompt);
    if (!matchedAnswer || seenPrompts.has(promptKey)) continue;
    seenPrompts.add(promptKey);
    questions.push({
      category,
      prompt,
      options: uniqueOptions,
      answer: matchedAnswer,
    });
    if (questions.length >= 15) break;
  }

  return questions.length >= minItems ? questions : null;
};

const generatedQuestionsFromContent = (content: unknown): RawQuestion[] =>
  Array.isArray(content) ? (content as RawQuestion[]) : [];

const scoreRound = (state: TriviaState): void => {
  const question = state.questions[state.questionIndex];
  const lastRound: Record<string, number> = {};
  for (const [playerId, answer] of Object.entries(state.answers)) {
    let gained = 0;
    if (answer.choice === question.correctIndex) {
      const used = Math.max(0, answer.at - state.questionStart);
      const ratio = Math.max(0, Math.min(1, 1 - used / state.questionMs));
      gained = BASE_POINTS + Math.round(SPEED_POINTS * ratio);
    }
    lastRound[playerId] = gained;
    state.scores[playerId] = (state.scores[playerId] ?? 0) + gained;
  }
  state.lastRound = lastRound;
};

const scoreboard = (state: TriviaState, ctx: GameContext) =>
  ctx.players
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: state.scores[player.id] ?? 0,
    }))
    .sort((a, b) => b.score - a.score);

/**
 * Typed move contract. Decoded from the untrusted `GameMove` at the top of
 * `onMove`, so the switch below works on validated, correctly-typed fields
 * instead of `payload as` casts.
 */
export type TriviaMove =
  | { type: "start" }
  | { type: "answer"; choice: number }
  | { type: "skip" }
  | { type: "next" };

const decodeTriviaMove = (move: GameMove): TriviaMove => {
  switch (move.type) {
    case "start":
    case "skip":
    case "next":
      return { type: move.type };
    case "answer": {
      // Validate the shape here; the against-the-board range check stays in the
      // case (it needs the current question). Both throw "Invalid answer".
      const choice = requireInt(payloadField(move.payload, "choice"), "Invalid answer");
      if (choice < 0) throw new GameMoveError("Invalid answer");
      return { type: "answer", choice };
    }
    default:
      throw new GameMoveError(`Unknown move: ${move.type}`);
  }
};

export const triviaModule: GameModule<TriviaState> = {
  id: "trivia",
  name: "Trivia",
  description: "Quick-fire quiz",
  minPlayers: 1,
  maxPlayers: 24,
  tickMs: 500,
  hasLeaderboard: true,
  options: [
    GAME_CONTENT_TOPIC_OPTION,
    { id: "questions", type: "number", label: "Questions", min: 3, max: 15, default: 7, presets: [5, 7, 10] },
    {
      id: "pace",
      type: "select",
      label: "Pace",
      default: "normal",
      choices: [
        { value: "relaxed", label: "Relaxed" },
        { value: "normal", label: "Normal" },
        { value: "fast", label: "Fast" },
      ],
    },
  ],

  generateContent(ctx) {
    const topic = gameContentTopic(ctx.config) || "fresh general knowledge trivia";
    const questionCount = numberOption(ctx.config, "questions", QUESTIONS_PER_GAME);
    return generateStructuredGameContent({
      gameName: "Trivia",
      topic,
      instructions: [
        `Create ${questionCount} unique multiple-choice trivia questions.`,
        "Every question, option set, and answer must clearly depend on the topic.",
        "Do not return generic geography, science, film, food, sport, or history facts unless the topic asks for them.",
        "Use concrete topic-specific nouns, people, events, products, places, or scenarios when they fit.",
        "Each question needs exactly four plausible options.",
        "The answer must exactly match one option.",
        "Avoid repeated facts and avoid questions that require private knowledge.",
      ].join(" "),
      schemaName: "trivia_questions",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          questions: {
            type: "array",
            minItems: questionCount,
            maxItems: questionCount,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                category: { type: "string", maxLength: 32 },
                prompt: { type: "string", maxLength: 180 },
                options: {
                  type: "array",
                  minItems: 4,
                  maxItems: 4,
                  items: { type: "string", maxLength: 80 },
                },
                answer: { type: "string", maxLength: 80 },
              },
              required: ["category", "prompt", "options", "answer"],
            },
          },
        },
        required: ["questions"],
      },
      maxOutputTokens: 400 + questionCount * 150,
      parse: (payload) => parseGeneratedQuestions(payload, questionCount),
    });
  },

  setup(ctx: GameContext): TriviaState {
    const questionCount = numberOption(ctx.config, "questions", QUESTIONS_PER_GAME);
    const questionMs = PACE_MS[selectOption(ctx.config, "pace", "normal")] ?? QUESTION_MS;
    const questionBank = generatedQuestionsFromContent(ctx.content);
    const source = ctx.rng.shuffle(
      questionBank.length > 0 ? questionBank : QUESTION_BANK,
    );
    const picked = ctx.rng
      .shuffle(source.slice(0, Math.min(questionCount, source.length)))
      .slice(0, questionCount)
      .map((raw): LoadedQuestion => {
        const options = ctx.rng.shuffle(raw.options);
        const correctIndex = Math.max(0, options.indexOf(raw.answer));
        return {
          category: raw.category,
          prompt: raw.prompt,
          options,
          correctIndex,
        };
      });
    const scores: Record<string, number> = {};
    for (const player of ctx.players) scores[player.id] = 0;
    return {
      phase: "lobby",
      questionIndex: 0,
      questions: picked,
      questionStart: 0,
      questionMs,
      deadline: 0,
      answers: {},
      scores,
      lastRound: {},
    };
  },

  onMove(state, move: GameMove, ctx): TriviaState {
    const m = decodeTriviaMove(move);
    switch (m.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can start the quiz");
        }
        if (state.phase !== "lobby") {
          throw new GameMoveError("The quiz is already running");
        }
        return {
          ...state,
          phase: "question",
          questionIndex: 0,
          questionStart: ctx.now,
          deadline: ctx.now + state.questionMs,
          answers: {},
          lastRound: {},
        };
      }
      case "answer": {
        if (state.phase !== "question") {
          throw new GameMoveError("Not accepting answers right now");
        }
        const question = state.questions[state.questionIndex];
        if (m.choice >= question.options.length) {
          throw new GameMoveError("Invalid answer");
        }
        if (state.answers[move.playerId]) {
          throw new GameMoveError("You already answered");
        }
        const answers = {
          ...state.answers,
          [move.playerId]: { choice: m.choice, at: ctx.now },
        };
        const next = { ...state, answers };
        const deadline = allActivePlayersActed(ctx, (playerId) =>
          Boolean(next.answers[playerId]),
        )
          ? ctx.now
          : state.deadline;
        return { ...state, answers, deadline };
      }
      case "skip": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can skip");
        }
        if (state.phase !== "question") {
          throw new GameMoveError("Nothing to skip");
        }
        return { ...state, deadline: ctx.now };
      }
      case "next": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can advance");
        }
        if (state.phase !== "reveal") {
          throw new GameMoveError("Wait for the reveal");
        }
        return { ...state, deadline: ctx.now };
      }
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): TriviaState {
    if (state.phase === "question" && ctx.now >= state.deadline) {
      const next: TriviaState = {
        ...state,
        answers: { ...state.answers },
        scores: { ...state.scores },
      };
      scoreRound(next);
      next.phase = "reveal";
      next.deadline = ctx.now + REVEAL_MS;
      return next;
    }
    if (state.phase === "reveal" && ctx.now >= state.deadline) {
      const isLast = state.questionIndex + 1 >= state.questions.length;
      if (isLast) {
        return { ...state, phase: "results" };
      }
      return {
        ...state,
        phase: "question",
        questionIndex: state.questionIndex + 1,
        questionStart: ctx.now,
        deadline: ctx.now + state.questionMs,
        answers: {},
        lastRound: {},
      };
    }
    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const question = state.questions[state.questionIndex];
    const showQuestion = state.phase === "question" || state.phase === "reveal";
    const reveal = state.phase === "reveal";
    const optionCounts = question
      ? question.options.map(
          (_, index) =>
            Object.values(state.answers).filter((a) => a.choice === index)
              .length,
        )
      : [];
    // Per-player tile status for the video-tile overlay. Non-secret: during the
    // question phase it only says WHO has answered (never their choice); at
    // reveal it says whether each answerer was right (the correct answer is
    // already public at reveal) plus the points they gained.
    const tiles: Record<
      string,
      { acted?: boolean; outcome?: "correct" | "wrong"; note?: string }
    > = {};
    if (state.phase === "question") {
      for (const playerId of Object.keys(state.answers)) {
        tiles[playerId] = { acted: true };
      }
    } else if (reveal && question) {
      for (const [playerId, answer] of Object.entries(state.answers)) {
        const isCorrect = answer.choice === question.correctIndex;
        const gained = state.lastRound[playerId] ?? 0;
        const entry: { outcome: "correct" | "wrong"; note?: string } = {
          outcome: isCorrect ? "correct" : "wrong",
        };
        if (isCorrect && gained > 0) entry.note = `+${gained}`;
        tiles[playerId] = entry;
      }
    }
    return {
      phase: state.phase,
      questionIndex: state.questionIndex,
      totalQuestions: state.questions.length,
      serverNow: ctx.now,
      deadline: state.phase === "question" || reveal ? state.deadline : null,
      questionDurationMs: state.questionMs,
      category: showQuestion ? question?.category ?? null : null,
      prompt: showQuestion ? question?.prompt ?? null : null,
      options: showQuestion ? question?.options ?? [] : [],
      correctIndex: reveal ? question?.correctIndex ?? null : null,
      optionCounts: reveal ? optionCounts : [],
      answeredCount: Object.keys(state.answers).length,
      totalPlayers: ctx.activePlayers.length,
      scoreboard: scoreboard(state, ctx),
      tiles,
    };
  },

  playerView(state, playerId, ctx) {
    const question = state.questions[state.questionIndex];
    const mine = state.answers[playerId];
    const ordered = scoreboard(state, ctx);
    const rank = ordered.findIndex((entry) => entry.id === playerId);
    return {
      answered: Boolean(mine),
      choice: mine?.choice ?? null,
      score: state.scores[playerId] ?? 0,
      rank: rank >= 0 ? rank + 1 : null,
      lastRoundPoints: state.lastRound[playerId] ?? 0,
      correct:
        state.phase === "reveal" && question
          ? mine?.choice === question.correctIndex
          : null,
    };
  },

  isFinished: (state) => state.phase === "results",
};

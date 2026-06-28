import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { numberOption } from "../config.js";
import {
  GAME_CONTENT_TOPIC_OPTION,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
  normalizeGeneratedKey,
} from "../aiContent.js";

/**
 * Bluff: a Fibbage-style game. Players see a prompt with a blank, secretly
 * write a fake answer, then everyone (looking at all the fakes plus the one real
 * answer) tries to pick the truth. You score for finding the truth and for
 * fooling others into picking your lie. This showcases a different VIEW again:
 * a free-text input phase followed by a dynamic pick-one list.
 */

const WRITE_MS = 40_000;
const CHOOSE_MS = 30_000;
const REVEAL_MS = 9_000;
const TOTAL_ROUNDS = 4;
const MAX_ANSWER_LEN = 60;
const FOUND_TRUTH_POINTS = 1_000;
const FOOLED_POINTS = 500;

type Phase = "lobby" | "write" | "choose" | "reveal" | "results";

type Prompt = { question: string; answer: string };

type Option = { id: string; text: string; kind: "real" | "fake"; ownerId: string | null };

type BluffState = {
  phase: Phase;
  round: number;
  totalRounds: number;
  prompts: Prompt[];
  deadline: number;
  fakes: Record<string, string>;
  options: Option[];
  picks: Record<string, string>;
  scores: Record<string, number>;
  roundPoints: Record<string, number>;
};

const PROMPT_BANK: Prompt[] = [
  { question: "The unusual collective noun for a group of owls is a ___.", answer: "parliament" },
  { question: "Nintendo was originally founded in 1889 to make ___.", answer: "playing cards" },
  { question: "The dot over a lowercase i or j is called a ___.", answer: "tittle" },
  { question: "A group of flamingos is called a ___.", answer: "flamboyance" },
  { question: "The fear of long words is ironically called ___.", answer: "hippopotomonstrosesquippedaliophobia" },
  { question: "Honey found in ancient Egyptian tombs was still ___.", answer: "edible" },
  { question: "The world's largest desert by area is actually ___.", answer: "Antarctica" },
  { question: "A jiffy is an actual unit of time equal to ___.", answer: "one hundredth of a second" },
  { question: "The longest place name in the world is in ___.", answer: "New Zealand" },
  { question: "Bananas are botanically classified as ___.", answer: "berries" },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseGeneratedPrompts = (payload: unknown): Prompt[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.prompts)) return null;
  const prompts: Prompt[] = [];
  const seen = new Set<string>();
  for (const item of payload.prompts) {
    if (!isRecord(item)) continue;
    const question = cleanGeneratedText(item.question, 160);
    const answer = cleanGeneratedText(item.answer, MAX_ANSWER_LEN);
    if (!question || !answer || (question.match(/___/g)?.length ?? 0) !== 1) continue;
    const key = normalizeGeneratedKey(question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    prompts.push({ question, answer });
    if (prompts.length >= 6) break;
  }
  return prompts.length > 0 ? prompts : null;
};

const generatedPromptsFromContent = (content: unknown): Prompt[] =>
  Array.isArray(content) ? (content as Prompt[]) : [];

const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

const buildOptions = (state: BluffState, ctx: GameContext): Option[] => {
  const prompt = state.prompts[state.round];
  const realKey = normalize(prompt.answer);
  const seen = new Set<string>([realKey]);
  const options: Option[] = [];
  for (const player of ctx.players) {
    const raw = state.fakes[player.id];
    if (!raw) continue;
    const text = raw.trim().slice(0, MAX_ANSWER_LEN);
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({ id: `opt-${options.length}`, text, kind: "fake", ownerId: player.id });
  }
  options.push({ id: `opt-${options.length}`, text: prompt.answer, kind: "real", ownerId: null });
  return ctx.rng.shuffle(options).map((opt, index) => ({ ...opt, id: `opt-${index}` }));
};

const scoreRound = (state: BluffState): void => {
  const roundPoints: Record<string, number> = {};
  const realOption = state.options.find((o) => o.kind === "real");
  for (const [playerId, optionId] of Object.entries(state.picks)) {
    if (realOption && optionId === realOption.id) {
      roundPoints[playerId] = (roundPoints[playerId] ?? 0) + FOUND_TRUTH_POINTS;
    }
  }
  for (const option of state.options) {
    if (option.kind !== "fake" || !option.ownerId) continue;
    const fooled = Object.values(state.picks).filter((id) => id === option.id).length;
    if (fooled > 0) {
      roundPoints[option.ownerId] =
        (roundPoints[option.ownerId] ?? 0) + fooled * FOOLED_POINTS;
    }
  }
  for (const [playerId, points] of Object.entries(roundPoints)) {
    state.scores[playerId] = (state.scores[playerId] ?? 0) + points;
  }
  state.roundPoints = roundPoints;
};

const scoreboard = (state: BluffState, ctx: GameContext) =>
  ctx.players
    .map((p) => ({ id: p.id, name: p.name, score: state.scores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);

export const bluffModule: GameModule<BluffState> = {
  id: "bluff",
  name: "Bluff",
  description: "Fool the room, find the truth",
  minPlayers: 2,
  maxPlayers: 16,
  tickMs: 500,
  hasLeaderboard: true,
  options: [
    GAME_CONTENT_TOPIC_OPTION,
    { id: "rounds", type: "number", label: "Rounds", min: 2, max: 6, default: 4, presets: [3, 4, 5] },
  ],

  generateContent(ctx) {
    const topic = gameContentTopic(ctx.config) || "fresh obscure facts";
    const rounds = numberOption(ctx.config, "rounds", TOTAL_ROUNDS);
    return generateStructuredGameContent({
      gameName: "Bluff",
      topic,
      instructions: [
        `Create ${rounds} obscure but fair fact prompts.`,
        'Each question must contain "___" exactly where the answer belongs.',
        "Answers should be short enough that players can write believable fake answers.",
      ].join(" "),
      schemaName: "bluff_prompts",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompts: {
            type: "array",
            minItems: rounds,
            maxItems: rounds,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                question: { type: "string", maxLength: 160 },
                answer: { type: "string", maxLength: MAX_ANSWER_LEN },
              },
              required: ["question", "answer"],
            },
          },
        },
        required: ["prompts"],
      },
      maxOutputTokens: 320 + rounds * 90,
      parse: parseGeneratedPrompts,
    });
  },

  setup(ctx: GameContext): BluffState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p.id] = 0;
    const generatedPrompts = generatedPromptsFromContent(ctx.content);
    const promptBank = ctx.rng.shuffle(
      generatedPrompts.length > 0 ? generatedPrompts : PROMPT_BANK,
    );
    const roundCount = Math.min(
      numberOption(ctx.config, "rounds", TOTAL_ROUNDS),
      promptBank.length,
    );
    return {
      phase: "lobby",
      round: 0,
      totalRounds: roundCount,
      prompts: ctx.rng.shuffle(promptBank.slice(0, roundCount)),
      deadline: 0,
      fakes: {},
      options: [],
      picks: {},
      scores,
      roundPoints: {},
    };
  },

  onMove(state, move: GameMove, ctx): BluffState {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        if (ctx.players.length < 2) throw new GameMoveError("Need at least 2 players");
        return { ...state, phase: "write", round: 0, deadline: ctx.now + WRITE_MS, fakes: {} };
      }
      case "submit": {
        if (state.phase !== "write") throw new GameMoveError("Not accepting answers");
        const text = (move.payload as { text?: unknown })?.text;
        if (typeof text !== "string" || !text.trim()) throw new GameMoveError("Write something");
        const trimmed = text.trim().slice(0, MAX_ANSWER_LEN);
        const real = state.prompts[state.round]?.answer ?? "";
        if (normalize(trimmed) === normalize(real)) {
          throw new GameMoveError("That is the real answer. Write a bluff.");
        }
        const fakes = { ...state.fakes, [move.playerId]: trimmed };
        const everyone =
          ctx.players.length > 0 && ctx.players.every((p) => fakes[p.id]);
        return { ...state, fakes, deadline: everyone ? ctx.now : state.deadline };
      }
      case "choose": {
        if (state.phase !== "choose") throw new GameMoveError("Voting is closed");
        const optionId = (move.payload as { optionId?: unknown })?.optionId;
        const option = state.options.find((o) => o.id === optionId);
        if (!option) throw new GameMoveError("Invalid choice");
        if (option.ownerId === move.playerId) throw new GameMoveError("You cannot pick your own bluff");
        const picks = { ...state.picks, [move.playerId]: option.id };
        const everyone =
          ctx.players.length > 0 && ctx.players.every((p) => picks[p.id]);
        return { ...state, picks, deadline: everyone ? ctx.now : state.deadline };
      }
      case "next": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can advance");
        if (state.phase !== "reveal") throw new GameMoveError("Wait for the reveal");
        return { ...state, deadline: ctx.now };
      }
      case "skip": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can skip");
        if (state.phase !== "write" && state.phase !== "choose") throw new GameMoveError("Nothing to skip");
        return { ...state, deadline: ctx.now };
      }
      default:
        throw new GameMoveError(`Unknown move: ${move.type}`);
    }
  },

  onTick(state, ctx): BluffState {
    if (state.phase === "write" && ctx.now >= state.deadline) {
      const options = buildOptions(state, ctx);
      return { ...state, phase: "choose", options, picks: {}, deadline: ctx.now + CHOOSE_MS };
    }
    if (state.phase === "choose" && ctx.now >= state.deadline) {
      const next: BluffState = {
        ...state,
        options: state.options.map((o) => ({ ...o })),
        picks: { ...state.picks },
        scores: { ...state.scores },
      };
      scoreRound(next);
      next.phase = "reveal";
      next.deadline = ctx.now + REVEAL_MS;
      return next;
    }
    if (state.phase === "reveal" && ctx.now >= state.deadline) {
      const isLast = state.round + 1 >= state.totalRounds;
      if (isLast) return { ...state, phase: "results" };
      return {
        ...state,
        phase: "write",
        round: state.round + 1,
        deadline: ctx.now + WRITE_MS,
        fakes: {},
        options: [],
        picks: {},
        roundPoints: {},
      };
    }
    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const prompt = state.prompts[state.round];
    const reveal = state.phase === "reveal";
    const nameOf = (id: string | null) =>
      id ? ctx.players.find((p) => p.id === id)?.name ?? null : null;
    return {
      phase: state.phase,
      round: state.round,
      totalRounds: state.totalRounds,
      serverNow: ctx.now,
      deadline:
        state.phase === "write" || state.phase === "choose" ? state.deadline : null,
      question: state.phase === "lobby" ? null : prompt?.question ?? null,
      submittedCount: Object.keys(state.fakes).length,
      chosenCount: Object.keys(state.picks).length,
      totalPlayers: ctx.players.length,
      // During choose, hand out text only - never the kind or author.
      options:
        state.phase === "choose"
          ? state.options.map((o) => ({ id: o.id, text: o.text }))
          : reveal
            ? state.options.map((o) => ({
                id: o.id,
                text: o.text,
                kind: o.kind,
                ownerName: nameOf(o.ownerId),
                votes: Object.values(state.picks).filter((p) => p === o.id).length,
              }))
            : [],
      roundPoints: reveal
        ? ctx.players
            .map((p) => ({ id: p.id, name: p.name, points: state.roundPoints[p.id] ?? 0 }))
            .filter((entry) => entry.points > 0)
            .sort((a, b) => b.points - a.points)
        : [],
      scoreboard: scoreboard(state, ctx),
    };
  },

  playerView(state, playerId) {
    const ownOption = state.options.find((o) => o.ownerId === playerId);
    return {
      yourFake: state.fakes[playerId] ?? null,
      submitted: Boolean(state.fakes[playerId]),
      yourPick: state.picks[playerId] ?? null,
      ownOptionId: ownOption?.id ?? null,
      score: state.scores[playerId] ?? 0,
    };
  },

  isFinished: (state) => state.phase === "results",
};

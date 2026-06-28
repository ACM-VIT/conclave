import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { requirePlayerTarget } from "../validation.js";
import { selectOption } from "../config.js";
import {
  GAME_CONTENT_TOPIC_OPTION,
  cleanGeneratedStringArray,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
  normalizeGeneratedKey,
} from "../aiContent.js";

/**
 * Imposter: a Spyfall-style social deduction game, built for a video call.
 *
 * Everyone shares a secret word EXCEPT one imposter, who only sees the
 * category. Players take turns describing the word vaguely out loud (on camera),
 * trying to expose the imposter without naming the word outright. Then everyone
 * votes. This game exists to exercise the runtime's hidden-information path:
 * `playerView` returns a DIFFERENT projection for the imposter than for crew,
 * and the secret never appears in `publicView` until the result.
 */

const REVEAL_MS = 6_000;

type Phase = "lobby" | "reveal" | "discuss" | "vote" | "result";

type WordSet = { category: string; words: string[] };

type ImposterResult = {
  imposterId: string;
  word: string;
  votedOutId: string | null;
  crewWon: boolean;
  tie: boolean;
};

type ImposterState = {
  phase: Phase;
  category: string;
  word: string;
  imposterId: string;
  starterId: string;
  deadline: number;
  votes: Record<string, string>;
  result: ImposterResult | null;
};

const WORD_SETS: WordSet[] = [
  { category: "Places", words: ["Airport", "Beach", "Casino", "Hospital", "Library", "Submarine", "Space station", "Theme park"] },
  { category: "Food", words: ["Pizza", "Sushi", "Tacos", "Ramen", "Pancakes", "Dumplings", "Ice cream", "Curry"] },
  { category: "Animals", words: ["Penguin", "Octopus", "Elephant", "Kangaroo", "Dolphin", "Chameleon", "Sloth", "Falcon"] },
  { category: "Movies", words: ["Titanic", "Inception", "Jaws", "Frozen", "Gladiator", "Avatar", "The Matrix", "Up"] },
  { category: "Jobs", words: ["Astronaut", "Chef", "Firefighter", "Detective", "Pilot", "Surgeon", "Magician", "Architect"] },
  { category: "Sports", words: ["Tennis", "Surfing", "Boxing", "Curling", "Archery", "Skiing", "Cricket", "Fencing"] },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseGeneratedSet = (payload: unknown): WordSet | null => {
  if (!isRecord(payload) || !isRecord(payload.set)) return null;
  const category = cleanGeneratedText(payload.set.category, 40);
  const words = cleanGeneratedStringArray(payload.set.words, {
    maxItems: 12,
    maxLength: 40,
  });
  if (!category || words.length < 6) return null;
  const categoryKey = normalizeGeneratedKey(category);
  if (!categoryKey) return null;
  return { category, words };
};

const generatedSetFromContent = (content: unknown): WordSet | null =>
  isRecord(content) &&
  typeof content.category === "string" &&
  Array.isArray(content.words)
    ? (content as WordSet)
    : null;

const nameOf = (ctx: GameContext, playerId: string | null): string | null => {
  if (!playerId) return null;
  return ctx.players.find((player) => player.id === playerId)?.name ?? null;
};

const tallyVotes = (state: ImposterState): ImposterResult => {
  const counts = new Map<string, number>();
  for (const target of Object.values(state.votes)) {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  let topId: string | null = null;
  let topCount = 0;
  let tie = false;
  for (const [id, count] of counts) {
    if (count > topCount) {
      topId = id;
      topCount = count;
      tie = false;
    } else if (count === topCount) {
      tie = true;
    }
  }
  const votedOutId = tie ? null : topId;
  return {
    imposterId: state.imposterId,
    word: state.word,
    votedOutId,
    crewWon: votedOutId !== null && votedOutId === state.imposterId,
    tie,
  };
};

const everyoneVoted = (state: ImposterState, ctx: GameContext): boolean =>
  ctx.players.length > 0 &&
  ctx.players.every((player) => Boolean(state.votes[player.id]));

export const imposterModule: GameModule<ImposterState> = {
  id: "imposter",
  name: "Imposter",
  description: "Spot the faker in the room",
  minPlayers: 3,
  maxPlayers: 12,
  tickMs: 500,
  options: [
    GAME_CONTENT_TOPIC_OPTION,
    {
      id: "category",
      type: "select",
      label: "Category",
      default: "surprise",
      choices: [
        { value: "surprise", label: "Surprise me" },
        ...WORD_SETS.map((s) => ({ value: s.category, label: s.category })),
      ],
    },
  ],

  generateContent(ctx) {
    const selectedCategory = selectOption(ctx.config, "category", "surprise");
    const topic =
      gameContentTopic(ctx.config) ||
      (selectedCategory === "surprise"
        ? "fresh party-friendly secret words"
        : selectedCategory);
    const wordCount = Math.max(8, Math.min(12, ctx.players.length + 3));
    return generateStructuredGameContent({
      gameName: "Imposter",
      topic,
      instructions: [
        `Create one imposter word set with ${wordCount} related secret words.`,
        "The category should be broad enough that the imposter can bluff.",
        "Words should be familiar, distinct, and easy to describe out loud without saying the word.",
      ].join(" "),
      schemaName: "imposter_word_set",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          set: {
            type: "object",
            additionalProperties: false,
            properties: {
              category: { type: "string", maxLength: 40 },
              words: {
                type: "array",
                minItems: wordCount,
                maxItems: wordCount,
                items: { type: "string", maxLength: 40 },
              },
            },
            required: ["category", "words"],
          },
        },
        required: ["set"],
      },
      maxOutputTokens: 220 + wordCount * 30,
      parse: parseGeneratedSet,
    });
  },

  setup(ctx: GameContext): ImposterState {
    const generatedSet = generatedSetFromContent(ctx.content);
    const chosen = selectOption(ctx.config, "category", "surprise");
    const set =
      generatedSet ??
      (chosen === "surprise"
        ? ctx.rng.pick(WORD_SETS)
        : WORD_SETS.find((s) => s.category === chosen) ?? ctx.rng.pick(WORD_SETS));
    const word = ctx.rng.pick(set.words);
    const imposter = ctx.players.length > 0 ? ctx.rng.pick(ctx.players) : null;
    const starter = ctx.players.length > 0 ? ctx.rng.pick(ctx.players) : null;
    return {
      phase: "lobby",
      category: set.category,
      word,
      imposterId: imposter?.id ?? "",
      starterId: starter?.id ?? "",
      deadline: 0,
      votes: {},
      result: null,
    };
  },

  onMove(state, move: GameMove, ctx): ImposterState {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can start the round");
        }
        if (state.phase !== "lobby") {
          throw new GameMoveError("The round already started");
        }
        if (ctx.players.length < 3) {
          throw new GameMoveError("Need at least 3 players");
        }
        return { ...state, phase: "reveal", deadline: ctx.now + REVEAL_MS };
      }
      case "callVote": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can call a vote");
        }
        if (state.phase !== "discuss") {
          throw new GameMoveError("Can only call a vote during discussion");
        }
        return { ...state, phase: "vote", votes: {} };
      }
      case "vote": {
        if (state.phase !== "vote") {
          throw new GameMoveError("Voting is not open");
        }
        const target = requirePlayerTarget(
          ctx,
          move.playerId,
          (move.payload as { target?: unknown })?.target,
          {
            allowSelf: false,
            invalidMessage: "Invalid vote target",
            selfMessage: "You cannot vote for yourself",
          },
        );
        const votes = { ...state.votes, [move.playerId]: target };
        const next = { ...state, votes };
        if (everyoneVoted(next, ctx)) {
          return { ...next, phase: "result", result: tallyVotes(next) };
        }
        return next;
      }
      case "tally": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can end the vote");
        }
        if (state.phase !== "vote") {
          throw new GameMoveError("No vote in progress");
        }
        return { ...state, phase: "result", result: tallyVotes(state) };
      }
      default:
        throw new GameMoveError(`Unknown move: ${move.type}`);
    }
  },

  onTick(state, ctx): ImposterState {
    if (state.phase === "reveal" && ctx.now >= state.deadline) {
      return { ...state, phase: "discuss" };
    }
    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const voteCounts: Record<string, number> = {};
    if (state.phase === "vote" || state.phase === "result") {
      for (const target of Object.values(state.votes)) {
        voteCounts[target] = (voteCounts[target] ?? 0) + 1;
      }
    }
    return {
      phase: state.phase,
      category: state.category,
      serverNow: ctx.now,
      deadline: state.phase === "reveal" ? state.deadline : null,
      starterName: nameOf(ctx, state.starterId),
      players: ctx.players.map((player) => ({ id: player.id, name: player.name })),
      votedPlayerIds:
        state.phase === "vote" || state.phase === "result"
          ? Object.keys(state.votes)
          : [],
      voteCounts,
      totalPlayers: ctx.players.length,
      result:
        state.phase === "result" && state.result
          ? {
              imposterId: state.result.imposterId,
              imposterName: nameOf(ctx, state.result.imposterId),
              word: state.result.word,
              votedOutId: state.result.votedOutId,
              votedOutName: nameOf(ctx, state.result.votedOutId),
              crewWon: state.result.crewWon,
              tie: state.result.tie,
            }
          : null,
    };
  },

  playerView(state, playerId, ctx) {
    const isImposter = playerId === state.imposterId;
    const revealed = state.phase !== "lobby";
    return {
      role: isImposter ? "imposter" : "crew",
      category: state.category,
      word: isImposter || !revealed ? null : state.word,
      hint: isImposter
        ? "You don't know the word. Blend in and avoid getting caught."
        : null,
      yourVote: state.votes[playerId] ?? null,
    };
  },

  isFinished: (state) => state.phase === "result",
};

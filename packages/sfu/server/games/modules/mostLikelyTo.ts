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
import { requirePlayerTarget } from "../validation.js";

/**
 * Most Likely To: point the finger. Each round poses "who is most likely
 * to..." and everyone secretly votes a player. The reveal shows the tally and
 * crowns whoever the room picked. Built for groups, and it plays off real faces
 * on camera, so it scales to large rooms.
 */

const VOTE_MS = 15_000;
const ROUNDS_PER_GAME = 6;

type Phase = "lobby" | "vote" | "reveal" | "results";

type MltState = {
  phase: Phase;
  index: number;
  prompts: string[];
  deadline: number;
  votes: Record<string, string>;
};

const PROMPT_BANK: string[] = [
  "to become famous",
  "to survive a zombie apocalypse",
  "to forget their own birthday",
  "to start a successful company",
  "to laugh at the wrong moment",
  "to move to another country on a whim",
  "to win a reality TV show",
  "to text back three days later",
  "to adopt ten pets",
  "to become a world leader",
  "to get lost in their own neighborhood",
  "to break into spontaneous dance",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizePromptText = (value: unknown): string | null => {
  const text = cleanGeneratedText(value, 90)
    ?.replace(/^who\s+is\s+most\s+likely\s+/i, "")
    .replace(/\?+$/g, "")
    .trim();
  if (!text) return null;
  return text.match(/^to\s+/i) ? text : `to ${text}`;
};

const parseGeneratedPrompts = (payload: unknown): string[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.prompts)) return null;
  const prompts: string[] = [];
  const seen = new Set<string>();
  for (const item of payload.prompts) {
    const prompt = normalizePromptText(item);
    if (!prompt) continue;
    const key = normalizeGeneratedKey(prompt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    prompts.push(prompt);
    if (prompts.length >= 10) break;
  }
  return prompts.length > 0 ? prompts : null;
};

const generatedPromptsFromContent = (content: unknown): string[] =>
  Array.isArray(content) ? (content as string[]) : [];

const tally = (state: MltState): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const target of Object.values(state.votes)) {
    counts[target] = (counts[target] ?? 0) + 1;
  }
  return counts;
};

export const mostLikelyToModule: GameModule<MltState> = {
  id: "most-likely-to",
  name: "Most Likely To",
  description: "Vote who the room picks",
  minPlayers: 3,
  maxPlayers: 50,
  tickMs: 500,
  options: [
    GAME_CONTENT_TOPIC_OPTION,
    { id: "rounds", type: "number", label: "Rounds", min: 3, max: 10, default: 6, presets: [4, 6, 8] },
  ],

  generateContent(ctx) {
    const topic = gameContentTopic(ctx.config) || "fresh friendly group prompts";
    const rounds = numberOption(ctx.config, "rounds", ROUNDS_PER_GAME);
    return generateStructuredGameContent({
      gameName: "Most Likely To",
      topic,
      instructions: [
        `Create ${rounds} light, funny prompts that complete this sentence: "Who is most likely ...?"`,
        'Return each prompt as the suffix only, usually starting with "to".',
        "Avoid insults, sensitive traits, and anything that would embarrass one person too hard.",
      ].join(" "),
      schemaName: "most_likely_to_prompts",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompts: {
            type: "array",
            minItems: rounds,
            maxItems: rounds,
            items: { type: "string", maxLength: 90 },
          },
        },
        required: ["prompts"],
      },
      maxOutputTokens: 220 + rounds * 60,
      parse: parseGeneratedPrompts,
    });
  },

  setup(ctx: GameContext): MltState {
    const generatedPrompts = generatedPromptsFromContent(ctx.content);
    const promptBank = ctx.rng.shuffle(
      generatedPrompts.length > 0 ? generatedPrompts : PROMPT_BANK,
    );
    return {
      phase: "lobby",
      index: 0,
      prompts: ctx.rng
        .shuffle(promptBank.slice(0, numberOption(ctx.config, "rounds", ROUNDS_PER_GAME))),
      deadline: 0,
      votes: {},
    };
  },

  onMove(state, move: GameMove, ctx): MltState {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        if (ctx.players.length < 3) throw new GameMoveError("Need at least 3 players");
        return { ...state, phase: "vote", index: 0, deadline: ctx.now + VOTE_MS, votes: {} };
      }
      case "vote": {
        if (state.phase !== "vote") throw new GameMoveError("Voting is closed");
        const target = requirePlayerTarget(
          ctx,
          move.playerId,
          (move.payload as { target?: unknown })?.target,
          { invalidMessage: "Invalid vote" },
        );
        const votes = { ...state.votes, [move.playerId]: target };
        const everyone = ctx.players.length > 0 && Object.keys(votes).length >= ctx.players.length;
        return { ...state, votes, deadline: everyone ? ctx.now : state.deadline };
      }
      case "next": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can advance");
        if (state.phase !== "reveal") throw new GameMoveError("Wait for the reveal");
        return { ...state, deadline: ctx.now };
      }
      case "skip": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can skip");
        if (state.phase !== "vote") throw new GameMoveError("Nothing to skip");
        return { ...state, deadline: ctx.now };
      }
      default:
        throw new GameMoveError(`Unknown move: ${move.type}`);
    }
  },

  onTick(state, ctx): MltState {
    if (state.phase === "vote" && ctx.now >= state.deadline) {
      return { ...state, phase: "reveal", deadline: 0 };
    }
    if (state.phase === "reveal" && ctx.now >= state.deadline && state.deadline > 0) {
      const isLast = state.index + 1 >= state.prompts.length;
      if (isLast) return { ...state, phase: "results" };
      return { ...state, phase: "vote", index: state.index + 1, deadline: ctx.now + VOTE_MS, votes: {} };
    }
    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const reveal = state.phase === "reveal";
    const counts = reveal ? tally(state) : {};
    let winnerId: string | null = null;
    let winnerCount = 0;
    for (const [id, count] of Object.entries(counts)) {
      if (count > winnerCount) {
        winnerId = id;
        winnerCount = count;
      }
    }
    return {
      phase: state.phase,
      index: state.index,
      total: state.prompts.length,
      serverNow: ctx.now,
      deadline: state.phase === "vote" ? state.deadline : null,
      voteDurationMs: VOTE_MS,
      prompt: state.phase === "lobby" ? null : (state.prompts[state.index] ?? null),
      players: ctx.players.map((player) => ({ id: player.id, name: player.name })),
      counts,
      answeredCount: Object.keys(state.votes).length,
      totalPlayers: ctx.players.length,
      winnerId: reveal ? winnerId : null,
      winnerName: reveal && winnerId ? ctx.players.find((p) => p.id === winnerId)?.name ?? null : null,
    };
  },

  playerView(state, playerId) {
    return { yourVote: state.votes[playerId] ?? null };
  },

  isFinished: (state) => state.phase === "results",
};

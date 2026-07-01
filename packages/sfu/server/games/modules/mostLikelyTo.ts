import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { numberOption } from "../config.js";
import { createRoundLoop } from "../roundLoop.js";
import {
  GAME_CONTENT_TOPIC_OPTION,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
  normalizeGeneratedKey,
} from "../aiContent.js";
import { payloadField, requirePlayerTarget } from "../validation.js";

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

const promptValue = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return value.prompt ?? value.text ?? value.suffix;
};

const uniquePrompts = (prompts: unknown[], maxItems: number): string[] => {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const prompt of prompts) {
    const normalized = normalizePromptText(prompt);
    if (!normalized) continue;
    const key = normalizeGeneratedKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
    if (unique.length >= maxItems) break;
  }
  return unique;
};

const parseGeneratedPrompts = (
  payload: unknown,
  minItems = 1,
): string[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.prompts)) return null;
  const prompts = uniquePrompts(payload.prompts.map(promptValue), 10);
  return prompts.length >= minItems ? prompts : null;
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

const enterVote = (state: MltState, ctx: GameContext, index: number): MltState => ({
  ...state,
  phase: "vote",
  index,
  deadline: ctx.now + VOTE_MS,
  votes: {},
});

const loop = createRoundLoop<MltState>({
  getPhase: (state) => state.phase,
  getDeadline: (state) => state.deadline,
  withDeadline: (state, deadline) => ({ ...state, deadline }),
  collectPhases: [
    {
      name: "vote",
      hasActed: (state, playerId) => state.votes[playerId] !== undefined,
      onEnter: (state, ctx) => enterVote(state, ctx, state.index),
    },
  ],
  reveal: {
    name: "reveal",
    onEnter: (state) => ({ ...state, phase: "reveal", deadline: 0 }),
  },
  isLastRound: (state) => state.index + 1 >= state.prompts.length,
  startNextRound: (state, ctx) => enterVote(state, ctx, state.index + 1),
  toResults: (state) => ({ ...state, phase: "results" }),
});

/**
 * Typed move contract. Decoded from the untrusted `GameMove` at the top of
 * `onMove`. The vote target stays `unknown` on the decoded move because it is
 * validated against the live roster by `requirePlayerTarget` (which needs ctx)
 * inside the case, preserving the "Invalid vote" message.
 */
export type MltMove =
  | { type: "start" }
  | { type: "vote"; target: unknown }
  | { type: "next" }
  | { type: "skip" };

const decodeMltMove = (move: GameMove): MltMove => {
  switch (move.type) {
    case "start":
    case "next":
    case "skip":
      return { type: move.type };
    case "vote":
      return { type: "vote", target: payloadField(move.payload, "target") };
    default:
      throw new GameMoveError(`Unknown move: ${move.type}`);
  }
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
        "Every prompt must clearly depend on the topic.",
        "Do not return generic personality or party prompts unless the topic asks for them.",
        "Use concrete topic-specific nouns, people, events, products, places, or scenarios when they fit.",
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
      parse: (payload) => parseGeneratedPrompts(payload, rounds),
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
    const m = decodeMltMove(move);
    switch (m.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        if (ctx.players.length < 3) throw new GameMoveError("Need at least 3 players");
        return enterVote(state, ctx, 0);
      }
      case "vote": {
        if (state.phase !== "vote") throw new GameMoveError("Voting is closed");
        const target = requirePlayerTarget(ctx, move.playerId, m.target, {
          invalidMessage: "Invalid vote",
        });
        const votes = { ...state.votes, [move.playerId]: target };
        return loop.recordAction({ ...state, votes }, ctx);
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
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): MltState {
    return loop.tick(state, ctx);
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
      totalPlayers: ctx.activePlayers.length,
      winnerId: reveal ? winnerId : null,
      winnerName: reveal && winnerId ? ctx.players.find((p) => p.id === winnerId)?.name ?? null : null,
    };
  },

  playerView(state, playerId) {
    return { yourVote: state.votes[playerId] ?? null };
  },

  isFinished: (state) => state.phase === "results",
};

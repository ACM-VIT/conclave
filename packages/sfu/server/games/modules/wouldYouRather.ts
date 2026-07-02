import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { payloadField, requireOneOf } from "../validation.js";
import { numberOption } from "../config.js";
import { createRoundLoop } from "../roundLoop.js";
import {
  GAME_CONTENT_TOPIC_OPTION,
  cleanGeneratedText,
  generateStructuredGameContent,
  gameContentTopic,
  normalizeGeneratedKey,
} from "../aiContent.js";

/**
 * Would You Rather: a "split the room" party game for groups of any size.
 *
 * Each round shows two options. Everyone picks one, then the room split is
 * revealed (counts plus who landed where). No right answer, no losing - it is
 * about seeing where your friends land and arguing about it on camera.
 */

const CHOOSE_MS = 15_000;
const ROUNDS_PER_GAME = 6;

type Phase = "lobby" | "choose" | "reveal" | "results";

type Prompt = { a: string; b: string };

type WyrState = {
  phase: Phase;
  index: number;
  prompts: Prompt[];
  deadline: number;
  choices: Record<string, 0 | 1>;
};

const PROMPT_BANK: Prompt[] = [
  { a: "Be able to fly", b: "Be invisible" },
  { a: "Never have to sleep", b: "Never have to eat" },
  { a: "Always be 10 minutes late", b: "Always be 20 minutes early" },
  { a: "Live without music", b: "Live without movies" },
  { a: "Have a rewind button", b: "Have a pause button" },
  { a: "Fight one horse-sized duck", b: "Fight 100 duck-sized horses" },
  { a: "Only whisper", b: "Only shout" },
  { a: "Know when you will die", b: "Know how you will die" },
  { a: "Be a famous actor", b: "Be a famous musician" },
  { a: "Have unlimited tacos", b: "Have unlimited pizza" },
  { a: "Read minds", b: "See the future" },
  { a: "Never use a touchscreen again", b: "Never use a keyboard again" },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const generatedChoiceFromKeys = (
  item: Record<string, unknown>,
  keys: string[],
  side: "a" | "b",
): string | null => {
  for (const key of keys) {
    const raw = cleanGeneratedText(item[key], 140);
    if (!raw) continue;
    const text = normalizeGeneratedChoice(raw, side);
    if (text) return text;
  }
  return null;
};

const normalizeGeneratedChoice = (value: string, side: "a" | "b"): string | null => {
  const withoutQuestion = value
    .replace(/^would\s+you\s+rather\s+/i, "")
    .replace(/\?+$/g, "")
    .trim();
  const parts = withoutQuestion
    .split(/\s+\bor\b\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const choice = parts.length > 1 ? (side === "a" ? parts[0] : parts.at(-1)) : withoutQuestion;
  return cleanGeneratedText(choice, 90);
};

const uniquePrompts = (prompts: Prompt[], maxItems: number): Prompt[] => {
  const unique: Prompt[] = [];
  const seen = new Set<string>();
  for (const prompt of prompts) {
    const aKey = normalizeGeneratedKey(prompt.a);
    const bKey = normalizeGeneratedKey(prompt.b);
    if (!aKey || !bKey || aKey === bKey) continue;
    const pairKey = [aKey, bKey]
      .sort()
      .join("|");
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    unique.push(prompt);
    if (unique.length >= maxItems) break;
  }
  return unique;
};

const parseGeneratedPrompts = (
  payload: unknown,
  minItems = 1,
): Prompt[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.prompts)) return null;
  const prompts: Prompt[] = [];
  for (const item of payload.prompts) {
    if (!isRecord(item)) continue;
    const a = generatedChoiceFromKeys(item, ["a", "optionA", "choiceA", "left"], "a");
    const b = generatedChoiceFromKeys(item, ["b", "optionB", "choiceB", "right"], "b");
    if (!a || !b) continue;
    prompts.push({ a, b });
    if (prompts.length >= 10) break;
  }
  const unique = uniquePrompts(prompts, 10);
  return unique.length >= minItems ? unique : null;
};

const generatedPromptsFromContent = (content: unknown): Prompt[] =>
  Array.isArray(content) ? (content as Prompt[]) : [];

const splitCounts = (state: WyrState): [number, number] => {
  let a = 0;
  let b = 0;
  for (const choice of Object.values(state.choices)) {
    if (choice === 0) a += 1;
    else b += 1;
  }
  return [a, b];
};

const namesFor = (state: WyrState, ctx: GameContext, option: 0 | 1): string[] =>
  ctx.players
    .filter((player) => state.choices[player.id] === option)
    .map((player) => player.name);

const enterChoose = (state: WyrState, ctx: GameContext, index: number): WyrState => ({
  ...state,
  phase: "choose",
  index,
  deadline: ctx.now + CHOOSE_MS,
  choices: {},
});

const loop = createRoundLoop<WyrState>({
  getPhase: (state) => state.phase,
  getDeadline: (state) => state.deadline,
  withDeadline: (state, deadline) => ({ ...state, deadline }),
  collectPhases: [
    {
      name: "choose",
      hasActed: (state, playerId) => state.choices[playerId] !== undefined,
      onEnter: (state, ctx) => enterChoose(state, ctx, state.index),
    },
  ],
  reveal: {
    name: "reveal",
    onEnter: (state) => ({ ...state, phase: "reveal", deadline: 0 }),
  },
  isLastRound: (state) => state.index + 1 >= state.prompts.length,
  startNextRound: (state, ctx) => enterChoose(state, ctx, state.index + 1),
  toResults: (state) => ({ ...state, phase: "results" }),
});

/**
 * Typed move contract. Decoded from the untrusted `GameMove` at the top of
 * `onMove`. The side pick is validated here to 0 or 1 (throwing "Invalid pick"),
 * replacing the inline payload cast.
 */
export type WouldYouRatherMove =
  | { type: "start" }
  | { type: "choose"; option: 0 | 1 }
  | { type: "next" }
  | { type: "skip" };

const decodeWouldYouRatherMove = (move: GameMove): WouldYouRatherMove => {
  switch (move.type) {
    case "start":
    case "next":
    case "skip":
      return { type: move.type };
    case "choose":
      return {
        type: "choose",
        option: requireOneOf(payloadField(move.payload, "option"), [0, 1] as const, "Invalid pick"),
      };
    default:
      throw new GameMoveError(`Unknown move: ${move.type}`);
  }
};

export const wouldYouRatherModule: GameModule<WyrState> = {
  id: "would-you-rather",
  name: "Would You Rather",
  description: "Pick a side, no wrong answers",
  minPlayers: 1,
  maxPlayers: 50,
  lateJoinPhases: ["choose"],
  tickMs: 500,
  options: [
    GAME_CONTENT_TOPIC_OPTION,
    { id: "rounds", type: "number", label: "Rounds", min: 3, max: 10, default: 6, presets: [4, 6, 8] },
  ],

  generateContent(ctx) {
    const topic = gameContentTopic(ctx.config) || "fresh party conversation";
    const rounds = numberOption(ctx.config, "rounds", ROUNDS_PER_GAME);
    return generateStructuredGameContent({
      gameName: "Would You Rather",
      topic,
      instructions: [
        `Create ${rounds} balanced would-you-rather prompts.`,
        "Every choice must clearly depend on the topic. Do not return generic superpower, food, travel, or lifestyle choices unless the topic itself asks for them.",
        "Use concrete topic-specific nouns, people, events, products, places, or scenarios when they fit.",
        "Each prompt needs two distinct choices that are quick to read aloud.",
        "Avoid choices that are offensive, sexual, or personally invasive.",
      ].join(" "),
      schemaName: "would_you_rather_prompts",
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
                a: { type: "string", maxLength: 90 },
                b: { type: "string", maxLength: 90 },
              },
              required: ["a", "b"],
            },
          },
        },
        required: ["prompts"],
      },
      maxOutputTokens: 280 + rounds * 80,
      parse: (payload) => parseGeneratedPrompts(payload, rounds),
    });
  },

  setup(ctx: GameContext): WyrState {
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
      choices: {},
    };
  },

  onMove(state, move: GameMove, ctx): WyrState {
    const m = decodeWouldYouRatherMove(move);
    switch (m.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        return enterChoose(state, ctx, 0);
      }
      case "choose": {
        if (state.phase !== "choose") throw new GameMoveError("Not accepting picks");
        const choices: Record<string, 0 | 1> = { ...state.choices, [move.playerId]: m.option };
        return loop.recordAction({ ...state, choices }, ctx);
      }
      case "next": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can advance");
        if (state.phase !== "reveal") throw new GameMoveError("Wait for the reveal");
        return { ...state, deadline: ctx.now };
      }
      case "skip": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can skip");
        if (state.phase !== "choose") throw new GameMoveError("Nothing to skip");
        return { ...state, deadline: ctx.now };
      }
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): WyrState {
    return loop.tick(state, ctx);
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const prompt = state.prompts[state.index];
    const reveal = state.phase === "reveal";
    const [a, b] = splitCounts(state);
    return {
      phase: state.phase,
      index: state.index,
      total: state.prompts.length,
      serverNow: ctx.now,
      deadline: state.phase === "choose" ? state.deadline : null,
      chooseDurationMs: CHOOSE_MS,
      optionA: prompt?.a ?? null,
      optionB: prompt?.b ?? null,
      counts: state.phase === "lobby" ? [0, 0] : [a, b],
      answeredCount: Object.keys(state.choices).length,
      totalPlayers: ctx.activePlayers.length,
      namesA: reveal ? namesFor(state, ctx, 0) : [],
      namesB: reveal ? namesFor(state, ctx, 1) : [],
    };
  },

  playerView(state, playerId) {
    const choice = state.choices[playerId];
    return { choice: choice === undefined ? null : choice };
  },

  isFinished: (state) => state.phase === "results",
};

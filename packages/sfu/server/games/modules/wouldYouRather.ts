import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { numberOption } from "../config.js";

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

export const wouldYouRatherModule: GameModule<WyrState> = {
  id: "would-you-rather",
  name: "Would You Rather",
  description: "Pick a side, no wrong answers",
  minPlayers: 1,
  maxPlayers: 50,
  tickMs: 500,
  options: [
    { id: "rounds", type: "number", label: "Rounds", min: 3, max: 10, default: 6, presets: [4, 6, 8] },
  ],

  setup(ctx: GameContext): WyrState {
    return {
      phase: "lobby",
      index: 0,
      prompts: ctx.rng.shuffle(PROMPT_BANK).slice(0, numberOption(ctx.config, "rounds", ROUNDS_PER_GAME)),
      deadline: 0,
      choices: {},
    };
  },

  onMove(state, move: GameMove, ctx): WyrState {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        return { ...state, phase: "choose", index: 0, deadline: ctx.now + CHOOSE_MS, choices: {} };
      }
      case "choose": {
        if (state.phase !== "choose") throw new GameMoveError("Not accepting picks");
        const option = (move.payload as { option?: unknown })?.option;
        if (option !== 0 && option !== 1) throw new GameMoveError("Invalid pick");
        const pick: 0 | 1 = option;
        const choices: Record<string, 0 | 1> = { ...state.choices, [move.playerId]: pick };
        const everyone = ctx.players.length > 0 && Object.keys(choices).length >= ctx.players.length;
        return { ...state, choices, deadline: everyone ? ctx.now : state.deadline };
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
      default:
        throw new GameMoveError(`Unknown move: ${move.type}`);
    }
  },

  onTick(state, ctx): WyrState {
    if (state.phase === "choose" && ctx.now >= state.deadline) {
      return { ...state, phase: "reveal", deadline: 0 };
    }
    if (state.phase === "reveal" && ctx.now >= state.deadline && state.deadline > 0) {
      const isLast = state.index + 1 >= state.prompts.length;
      if (isLast) return { ...state, phase: "results" };
      return { ...state, phase: "choose", index: state.index + 1, deadline: ctx.now + CHOOSE_MS, choices: {} };
    }
    return state;
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
      totalPlayers: ctx.players.length,
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

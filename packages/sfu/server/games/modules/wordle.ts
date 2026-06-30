import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { numberOption } from "../config.js";

type WordleTile = "green" | "yellow" | "gray";

type PlayerOutcome = "win" | "lose" | "timeout";

type GuessResult = {
  word: string;
  feedback: WordleTile[];
  at: number;
};

type PlayerRoundState = {
  guesses: GuessResult[];
  outcome: PlayerOutcome | null;
  solvedAt: number | null;
};

type WordleState = {
  phase: "lobby" | "set-word" | "playing" | "results";
  setterId: string | null;
  targetWord: string | null;
  players: Record<string, PlayerRoundState>;
  maxTries: number;
  timeLimitMs: number;
  deadline: number;
  winnerId: string | null;
};

const WORD_LENGTH = 5;
const MAX_TRIES = 6;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const wordsPath = resolve(moduleDir, "wordleWords.json");
const WORD_SET = new Set<string>(
  (JSON.parse(readFileSync(wordsPath, "utf8")) as string[])
    .map((word) => word.trim().toUpperCase())
    .filter((word) => /^[A-Z]{5}$/.test(word)),
);

const setterName = (ctx: GameContext, setterId: string | null): string | null => {
  if (!setterId) return null;
  return ctx.players.find((player) => player.id === setterId)?.name ?? null;
};

const winnerName = (ctx: GameContext, winnerId: string | null): string | null => {
  if (!winnerId) return null;
  return ctx.players.find((player) => player.id === winnerId)?.name ?? null;
};

const normalizeWord = (
  value: unknown,
  options?: { role?: "guess" | "secret" },
): string => {
  const label = options?.role === "secret" ? "Word" : "Guess";
  if (typeof value !== "string") {
    throw new GameMoveError(`${label} must be exactly 5 letters`);
  }
  const trimmed = value.trim();
  if (trimmed.length !== WORD_LENGTH) {
    throw new GameMoveError(`${label} must be exactly 5 letters`);
  }
  if (!/^[a-zA-Z]+$/.test(trimmed)) {
    throw new GameMoveError(`${label} must contain letters only`);
  }
  const normalized = trimmed.toUpperCase();
  if (!WORD_SET.has(normalized)) {
    throw new GameMoveError("Not in word list");
  }
  return normalized;
};

const evaluateGuess = (target: string, guess: string): WordleTile[] => {
  const feedback: WordleTile[] = ["gray", "gray", "gray", "gray", "gray"];
  const pool = target.split("");

  for (let i = 0; i < WORD_LENGTH; i += 1) {
    if (guess[i] === target[i]) {
      feedback[i] = "green";
      pool[i] = "";
    }
  }

  for (let i = 0; i < WORD_LENGTH; i += 1) {
    if (feedback[i] === "green") continue;
    const letter = guess[i];
    const poolIndex = pool.findIndex((candidate) => candidate === letter);
    if (poolIndex >= 0) {
      feedback[i] = "yellow";
      pool[poolIndex] = "";
    }
  }

  return feedback;
};

const isSolved = (feedback: WordleTile[]): boolean =>
  feedback.length === WORD_LENGTH && feedback.every((tile) => tile === "green");

const contestantIds = (state: WordleState, ctx: GameContext): string[] =>
  ctx.players
    .map((player) => player.id)
    .filter((playerId) => playerId !== state.setterId);

const allContestantsFinished = (state: WordleState, ctx: GameContext): boolean => {
  const ids = contestantIds(state, ctx);
  return ids.length > 0 && ids.every((id) => Boolean(state.players[id]?.outcome));
};

const computeWinnerId = (state: WordleState, ctx: GameContext): string | null => {
  const winners = contestantIds(state, ctx)
    .map((id) => ({ id, progress: state.players[id] }))
    .filter(
      (
        entry,
      ): entry is {
        id: string;
        progress: PlayerRoundState;
      } =>
        Boolean(entry.progress) &&
        entry.progress.outcome === "win" &&
        entry.progress.solvedAt != null,
    )
    .sort((a, b) => {
      const tries = a.progress.guesses.length - b.progress.guesses.length;
      if (tries !== 0) return tries;
      return (a.progress.solvedAt ?? Number.MAX_SAFE_INTEGER) -
        (b.progress.solvedAt ?? Number.MAX_SAFE_INTEGER);
    });

  return winners[0]?.id ?? null;
};

const withResultsIfComplete = (state: WordleState, ctx: GameContext): WordleState => {
  if (!allContestantsFinished(state, ctx)) return state;
  return {
    ...state,
    phase: "results",
    winnerId: computeWinnerId(state, ctx),
  };
};

export const wordleModule: GameModule<WordleState> = {
  id: "wordle",
  name: "Wordle",
  description: "Guess a hidden five-letter word in six tries",
  minPlayers: 2,
  maxPlayers: 32,
  tickMs: 500,
  options: [
    {
      id: "timeLimitMinutes",
      type: "number",
      label: "Time limit",
      min: 1,
      max: 10,
      default: 3,
      presets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      suffix: "min",
    },
  ],

  setup(ctx: GameContext): WordleState {
    return {
      phase: "lobby",
      setterId: null,
      targetWord: null,
      players: {},
      maxTries: MAX_TRIES,
      timeLimitMs: numberOption(ctx.config, "timeLimitMinutes", 3) * 60_000,
      deadline: 0,
      winnerId: null,
    };
  },

  onMove(state, move: GameMove, ctx): WordleState {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can start Wordle");
        }
        if (state.phase !== "lobby") {
          throw new GameMoveError("Wordle has already started");
        }
        if (ctx.players.length < 2) {
          throw new GameMoveError("Need at least 2 players");
        }
        const setter = ctx.rng.pick(ctx.players);
        return {
          ...state,
          phase: "set-word",
          setterId: setter.id,
          targetWord: null,
          players: {},
          deadline: 0,
          winnerId: null,
        };
      }
      case "setWord": {
        if (state.phase !== "set-word") {
          throw new GameMoveError("Word is already set");
        }
        if (!state.setterId || move.playerId !== state.setterId) {
          throw new GameMoveError("Only the selected player can set the word");
        }
        const word = normalizeWord((move.payload as { word?: unknown })?.word, {
          role: "secret",
        });

        const players: Record<string, PlayerRoundState> = {};
        for (const playerId of contestantIds(state, ctx)) {
          players[playerId] = {
            guesses: [],
            outcome: null,
            solvedAt: null,
          };
        }

        return {
          ...state,
          phase: "playing",
          targetWord: word,
          players,
          deadline: ctx.now + state.timeLimitMs,
          winnerId: null,
        };
      }
      case "guess": {
        if (state.phase !== "playing") {
          throw new GameMoveError("Wordle is not accepting guesses right now");
        }
        if (!state.targetWord) {
          throw new GameMoveError("Word is not set yet");
        }
        if (state.setterId && move.playerId === state.setterId) {
          throw new GameMoveError("The selected player cannot submit guesses");
        }

        const progress = state.players[move.playerId];
        if (!progress) {
          throw new GameMoveError("You are not an active player in this round");
        }
        if (progress.outcome) {
          throw new GameMoveError("You already finished your board");
        }

        const guess = normalizeWord((move.payload as { word?: unknown })?.word, {
          role: "guess",
        });
        const feedback = evaluateGuess(state.targetWord, guess);
        const guesses = [
          ...progress.guesses,
          {
            word: guess,
            feedback,
            at: ctx.now,
          },
        ];

        const nextProgress: PlayerRoundState = {
          guesses,
          outcome: progress.outcome,
          solvedAt: progress.solvedAt,
        };

        if (isSolved(feedback)) {
          nextProgress.outcome = "win";
          nextProgress.solvedAt = ctx.now;
        } else if (guesses.length >= state.maxTries) {
          nextProgress.outcome = "lose";
          nextProgress.solvedAt = null;
        }

        const nextState: WordleState = {
          ...state,
          players: {
            ...state.players,
            [move.playerId]: nextProgress,
          },
        };

        return withResultsIfComplete(nextState, ctx);
      }
      default:
        throw new GameMoveError(`Unknown move: ${move.type}`);
    }
  },

  onTick(state, ctx): WordleState {
    if (state.phase !== "playing") return state;

    if (allContestantsFinished(state, ctx)) {
      return {
        ...state,
        phase: "results",
        winnerId: computeWinnerId(state, ctx),
      };
    }

    if (state.deadline > 0 && ctx.now >= state.deadline) {
      const players: Record<string, PlayerRoundState> = { ...state.players };
      for (const playerId of contestantIds(state, ctx)) {
        const progress = players[playerId];
        if (!progress || progress.outcome) continue;
        players[playerId] = {
          ...progress,
          outcome: "timeout",
          solvedAt: null,
        };
      }
      const timedOutState: WordleState = {
        ...state,
        players,
      };
      return {
        ...timedOutState,
        phase: "results",
        winnerId: computeWinnerId(timedOutState, ctx),
      };
    }

    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const standings = contestantIds(state, ctx)
      .map((playerId) => {
        const progress = state.players[playerId] ?? {
          guesses: [],
          outcome: null,
          solvedAt: null,
        };
        const playerName =
          ctx.players.find((player) => player.id === playerId)?.name ?? "Unknown";
        return {
          playerId,
          playerName,
          triesUsed: progress.guesses.length,
          outcome: progress.outcome,
          solvedAt: progress.solvedAt,
        };
      })
      .sort((a, b) => {
        const aSolved = a.outcome === "win";
        const bSolved = b.outcome === "win";
        if (aSolved !== bSolved) return aSolved ? -1 : 1;
        if (aSolved && bSolved) {
          const tries = a.triesUsed - b.triesUsed;
          if (tries !== 0) return tries;
          return (a.solvedAt ?? Number.MAX_SAFE_INTEGER) -
            (b.solvedAt ?? Number.MAX_SAFE_INTEGER);
        }
        return a.playerName.localeCompare(b.playerName);
      });

    return {
      phase: state.phase,
      setterId: state.setterId,
      setterName: setterName(ctx, state.setterId),
      serverNow: ctx.now,
      deadline: state.phase === "playing" ? state.deadline : null,
      timeLimitMs: state.timeLimitMs,
      wordLength: WORD_LENGTH,
      maxTries: state.maxTries,
      standings,
      finishedCount: standings.filter((entry) => Boolean(entry.outcome)).length,
      totalContestants: standings.length,
      result:
        state.phase === "results"
          ? {
              targetWord: state.targetWord,
              winnerId: state.winnerId,
              winnerName: winnerName(ctx, state.winnerId),
            }
          : null,
    };
  },

  playerView(state, playerId) {
    const isSetter = state.setterId === playerId;
    const progress = state.players[playerId] ?? null;

    return {
      isSetter,
      canSetWord: state.phase === "set-word" && isSetter,
      canGuess: state.phase === "playing" && !isSetter && progress?.outcome == null,
      secretWord: isSetter || state.phase === "results" ? state.targetWord : null,
      myGuesses: progress?.guesses ?? [],
      myOutcome: progress?.outcome ?? null,
      mySolvedAt: progress?.solvedAt ?? null,
    };
  },

  isFinished: (state) => state.phase === "results",
};

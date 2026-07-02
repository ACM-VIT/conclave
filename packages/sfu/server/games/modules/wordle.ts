import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { payloadField } from "../validation.js";
import { numberOption, selectOption } from "../config.js";
import { WORDLE_WORDS } from "../wordleWordList.js";

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

type WordSource = "setter" | "random";

type WordleState = {
  phase: "lobby" | "set-word" | "playing" | "results";
  wordSource: WordSource;
  setterId: string | null;
  targetWord: string | null;
  players: Record<string, PlayerRoundState>;
  maxTries: number;
  timeLimitMs: number;
  deadline: number;
  winnerId: string | null;
  totalRounds: number;
  currentRound: number;
  scores: Record<string, number>;
  usedWords: string[];
};

const WORD_LENGTH = 5;
const MAX_TRIES = 6;

const ALL_WORDS: readonly string[] = WORDLE_WORDS;
const WORD_SET = new Set<string>(ALL_WORDS);

const setterName = (ctx: GameContext, setterId: string | null): string | null => {
  if (!setterId) return null;
  return ctx.players.find((player) => player.id === setterId)?.name ?? null;
};

const hasActivePlayer = (
  ctx: GameContext,
  playerId: string | null,
): playerId is string =>
  Boolean(playerId && ctx.activePlayers.some((player) => player.id === playerId));

const replacementSetterId = (ctx: GameContext): string | null =>
  ctx.activePlayers.length > 0 ? ctx.rng.pick(ctx.activePlayers).id : null;

const recoverMissingSetter = (state: WordleState, ctx: GameContext): WordleState => {
  if (state.phase !== "set-word" || hasActivePlayer(ctx, state.setterId)) {
    return state;
  }
  const nextSetterId = replacementSetterId(ctx);
  if (!nextSetterId) return state;
  return {
    ...state,
    setterId: nextSetterId,
  };
};

const recoverMissingSetterForMove = (
  state: WordleState,
  move: GameMove,
  ctx: GameContext,
): WordleState => {
  if (state.phase !== "set-word" || hasActivePlayer(ctx, state.setterId)) {
    return state;
  }
  if (!hasActivePlayer(ctx, move.playerId)) return recoverMissingSetter(state, ctx);
  return {
    ...state,
    setterId: move.playerId,
  };
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
  (state.phase === "playing" || state.phase === "results"
    ? Object.keys(state.players)
    : ctx.activePlayers.map((player) => player.id))
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

const roundScore = (progress: PlayerRoundState, maxTries: number): number => {
  if (progress.outcome !== "win") return 0;
  return maxTries - progress.guesses.length + 1;
};

const accumulateScores = (state: WordleState, ctx: GameContext): Record<string, number> => {
  const scores = { ...state.scores };
  for (const playerId of contestantIds(state, ctx)) {
    const progress = state.players[playerId];
    if (!progress) continue;
    scores[playerId] = (scores[playerId] ?? 0) + roundScore(progress, state.maxTries);
  }
  return scores;
};

const withResultsIfComplete = (state: WordleState, ctx: GameContext): WordleState => {
  if (!allContestantsFinished(state, ctx)) return state;
  return {
    ...state,
    phase: "results",
    winnerId: computeWinnerId(state, ctx),
    scores: accumulateScores(state, ctx),
    usedWords: state.targetWord
      ? [...state.usedWords, state.targetWord]
      : state.usedWords,
  };
};

/**
 * Typed move contract. Decoded from the untrusted `GameMove` at the top of
 * `onMove`. The `word` field stays `unknown` on the decoded move: it is
 * validated by `normalizeWord` inside each case, because that validation needs
 * the role ("Word" vs "Guess") for its messages and must run after the phase and
 * setter/guesser checks so the original error precedence is preserved.
 */
export type WordleMove =
  | { type: "start" }
  | { type: "setWord"; word: unknown }
  | { type: "guess"; word: unknown }
  | { type: "nextRound" };

const decodeWordleMove = (move: GameMove): WordleMove => {
  switch (move.type) {
    case "start":
    case "nextRound":
      return { type: move.type };
    case "setWord":
      return { type: "setWord", word: payloadField(move.payload, "word") };
    case "guess":
      return { type: "guess", word: payloadField(move.payload, "word") };
    default:
      throw new GameMoveError(`Unknown move: ${move.type}`);
  }
};

export const wordleModule: GameModule<WordleState> = {
  id: "wordle",
  name: "Wordle",
  description: "Guess a hidden five-letter word",
  minPlayers: 1,
  maxPlayers: 32,
  lateJoinPhases: (state) =>
    state.wordSource === "setter" ? ["set-word"] : [],
  tickMs: 500,
  options: [
    {
      id: "wordSource",
      type: "select",
      label: "Word source",
      default: "random",
      choices: [
        { value: "random", label: "Random" },
        { value: "setter", label: "Player sets" },
      ],
    },
    {
      id: "rounds",
      type: "number",
      label: "Rounds",
      min: 1,
      max: 10,
      default: 1,
      presets: [1, 3, 5, 10],
      suffix: "",
    },
    {
      id: "timeLimitMinutes",
      type: "number",
      label: "Time limit",
      min: 1,
      max: 10,
      default: 3,
      presets: [1, 2, 3, 5, 10],
      suffix: "min",
    },
  ],

  setup(ctx: GameContext): WordleState {
    return {
      phase: "lobby",
      wordSource: selectOption(ctx.config, "wordSource", "random") as WordSource,
      setterId: null,
      targetWord: null,
      players: {},
      maxTries: MAX_TRIES,
      timeLimitMs: numberOption(ctx.config, "timeLimitMinutes", 3) * 60_000,
      deadline: 0,
      winnerId: null,
      totalRounds: numberOption(ctx.config, "rounds", 1),
      currentRound: 0,
      scores: {},
      usedWords: [],
    };
  },

  onMove(state, move: GameMove, ctx): WordleState {
    const m = decodeWordleMove(move);
    switch (m.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can start Wordle");
        }
        if (state.phase !== "lobby") {
          throw new GameMoveError("Wordle has already started");
        }
        const minPlayers = state.wordSource === "setter" ? 2 : 1;
        if (ctx.activePlayers.length < minPlayers) {
          throw new GameMoveError(
            state.wordSource === "setter"
              ? "Need at least 2 players"
              : "Need at least 1 player",
          );
        }

        if (state.wordSource === "random") {
          const word = ctx.rng.pick(ALL_WORDS);
          const players: Record<string, PlayerRoundState> = {};
          for (const player of ctx.activePlayers) {
            players[player.id] = { guesses: [], outcome: null, solvedAt: null };
          }
          return {
            ...state,
            phase: "playing",
            setterId: null,
            targetWord: word,
            players,
            deadline: ctx.now + state.timeLimitMs,
            winnerId: null,
            currentRound: 1,
            scores: {},
            usedWords: [],
          };
        }

        const setter = ctx.rng.pick(ctx.activePlayers);
        return {
          ...state,
          phase: "set-word",
          setterId: setter.id,
          targetWord: null,
          players: {},
          deadline: 0,
          winnerId: null,
          currentRound: 1,
          scores: {},
          usedWords: [],
        };
      }
      case "setWord": {
        const currentState = recoverMissingSetterForMove(state, move, ctx);
        if (currentState.phase !== "set-word") {
          throw new GameMoveError("Word is already set");
        }
        if (!currentState.setterId || move.playerId !== currentState.setterId) {
          throw new GameMoveError("Only the selected player can set the word");
        }
        const word = normalizeWord(m.word, { role: "secret" });

        const players: Record<string, PlayerRoundState> = {};
        for (const playerId of contestantIds(currentState, ctx)) {
          players[playerId] = {
            guesses: [],
            outcome: null,
            solvedAt: null,
          };
        }

        return {
          ...currentState,
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

        const guess = normalizeWord(m.word, { role: "guess" });
        if (progress.guesses.some((entry) => entry.word === guess)) {
          throw new GameMoveError("You already guessed that word");
        }
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
      case "nextRound": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can advance rounds");
        }
        if (state.phase !== "results") {
          throw new GameMoveError("Round is not finished yet");
        }
        if (state.currentRound >= state.totalRounds) {
          throw new GameMoveError("All rounds are complete");
        }
        const nextRound = state.currentRound + 1;

        if (state.wordSource === "random") {
          const candidates = ALL_WORDS.filter((w) => !state.usedWords.includes(w));
          const word = ctx.rng.pick(candidates.length > 0 ? candidates : ALL_WORDS);
          const players: Record<string, PlayerRoundState> = {};
          for (const player of ctx.activePlayers) {
            players[player.id] = { guesses: [], outcome: null, solvedAt: null };
          }
          return {
            ...state,
            phase: "playing" as const,
            setterId: null,
            targetWord: word,
            players,
            deadline: ctx.now + state.timeLimitMs,
            winnerId: null,
            currentRound: nextRound,
          };
        }

        const setter = ctx.rng.pick(ctx.activePlayers);
        return {
          ...state,
          phase: "set-word" as const,
          setterId: setter.id,
          targetWord: null,
          players: {},
          deadline: 0,
          winnerId: null,
          currentRound: nextRound,
        };
      }
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): WordleState {
    if (state.phase === "set-word") return recoverMissingSetter(state, ctx);

    if (state.phase !== "playing") return state;

    if (allContestantsFinished(state, ctx)) {
      return {
        ...state,
        phase: "results",
        winnerId: computeWinnerId(state, ctx),
        scores: accumulateScores(state, ctx),
        usedWords: state.targetWord
          ? [...state.usedWords, state.targetWord]
          : state.usedWords,
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
        scores: accumulateScores(timedOutState, ctx),
        usedWords: state.targetWord
          ? [...state.usedWords, state.targetWord]
          : state.usedWords,
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

    const scoreEntries = Object.entries(state.scores)
      .map(([playerId, score]) => ({
        playerId,
        playerName:
          ctx.players.find((p) => p.id === playerId)?.name ?? "Unknown",
        score,
      }))
      .sort((a, b) => b.score - a.score);

    return {
      phase: state.phase,
      wordSource: state.wordSource,
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
      currentRound: state.currentRound,
      totalRounds: state.totalRounds,
      isFinalRound: state.currentRound >= state.totalRounds,
      scores: scoreEntries,
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

  isFinished: (state) =>
    state.phase === "results" && state.currentRound >= state.totalRounds,
};

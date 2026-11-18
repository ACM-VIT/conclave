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

/**
 * - `solo`: everyone races on a private board (the original game).
 * - `relay`: one shared team board; contestants take turns guessing in a fixed
 *   rotation, each turn on its own timer.
 * - `huddle`: one shared team board; any contestant may guess at any time.
 */
type WordleMode = "solo" | "relay" | "huddle";

type TeamGuess = GuessResult & { by: string };

type TeamRoundState = {
  guesses: TeamGuess[];
  outcome: PlayerOutcome | null;
  solvedAt: number | null;
  solvedBy: string | null;
  /** Contestants seated for this round, in turn order. */
  turnOrder: string[];
  /** Relay only: index into `turnOrder` of whoever guesses next. */
  turnIndex: number;
  /** Relay only: when the current turn passes on (0 outside relay). */
  turnDeadline: number;
  /** Relay only: when the current guesser was first seen disconnected. */
  absentSince: number | null;
};

type WordleState = {
  phase: "lobby" | "set-word" | "playing" | "results";
  mode: WordleMode;
  wordSource: WordSource;
  turnTimeMs: number;
  /** Shared board for team modes; null in solo. */
  team: TeamRoundState | null;
  /** Relay: who opens the next round, so turns keep rotating across rounds. */
  nextStarterId: string | null;
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
/** How long a relay guesser may be disconnected before their turn moves on. */
const TURN_GRACE_MS = 5_000;

const WORD_SET = new Set<string>(WORDLE_WORDS);

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

const isTeamMode = (mode: WordleMode): boolean => mode !== "solo";

const contestantIds = (state: WordleState, ctx: GameContext): string[] => {
  const inRound = state.phase === "playing" || state.phase === "results";
  if (inRound && state.team) return state.team.turnOrder.slice();
  return (inRound
    ? Object.keys(state.players)
    : ctx.activePlayers.map((player) => player.id))
    .filter((playerId) => playerId !== state.setterId);
};

const allContestantsFinished = (state: WordleState, ctx: GameContext): boolean => {
  if (state.team) return state.team.outcome != null;
  const ids = contestantIds(state, ctx);
  return ids.length > 0 && ids.every((id) => Boolean(state.players[id]?.outcome));
};

const isActive = (ctx: GameContext, playerId: string): boolean =>
  ctx.activePlayers.some((player) => player.id === playerId);

/**
 * Index of the next connected teammate after the current guesser, or null when
 * nobody else on the team is connected. The single source of the relay's
 * "who is up next" rule, shared by turn handoff and both views.
 */
const nextActiveIndex = (team: TeamRoundState, ctx: GameContext): number | null => {
  const count = team.turnOrder.length;
  for (let step = 1; step < count; step += 1) {
    const candidate = (team.turnIndex + step) % count;
    if (isActive(ctx, team.turnOrder[candidate])) return candidate;
  }
  return null;
};

/** Give the relay turn to `turnIndex` with a fresh timer. */
const handTurn = (
  team: TeamRoundState,
  turnIndex: number,
  ctx: GameContext,
  turnTimeMs: number,
): TeamRoundState => ({
  ...team,
  turnIndex,
  turnDeadline: ctx.now + turnTimeMs,
  absentSince: null,
});

const currentTurnId = (state: WordleState): string | null => {
  const team = state.team;
  if (state.mode !== "relay" || state.phase !== "playing" || !team || team.outcome) {
    return null;
  }
  return team.turnOrder[team.turnIndex] ?? null;
};

/** Relay: the connected teammate who guesses after the current one, if any. */
const upNextId = (state: WordleState, ctx: GameContext): string | null => {
  if (!state.team || !currentTurnId(state)) return null;
  const index = nextActiveIndex(state.team, ctx);
  return index == null ? null : state.team.turnOrder[index] ?? null;
};

/** Fresh per-round board(s) for the seated contestants and the chosen word. */
const beginRound = (
  state: WordleState,
  ctx: GameContext,
  targetWord: string,
): WordleState => {
  const ids = ctx.activePlayers
    .map((player) => player.id)
    .filter((playerId) => playerId !== state.setterId);
  const base: WordleState = {
    ...state,
    phase: "playing",
    targetWord,
    deadline: ctx.now + state.timeLimitMs,
    winnerId: null,
  };

  if (!isTeamMode(state.mode)) {
    const players: Record<string, PlayerRoundState> = {};
    for (const playerId of ids) {
      players[playerId] = { guesses: [], outcome: null, solvedAt: null };
    }
    return { ...base, players, team: null };
  }

  const starter = state.nextStarterId ? ids.indexOf(state.nextStarterId) : -1;
  return {
    ...base,
    players: {},
    team: {
      guesses: [],
      outcome: null,
      solvedAt: null,
      solvedBy: null,
      turnOrder: ids,
      turnIndex: Math.max(0, starter),
      turnDeadline: state.mode === "relay" ? ctx.now + state.turnTimeMs : 0,
      absentSince: null,
    },
  };
};

const computeWinnerId = (state: WordleState, ctx: GameContext): string | null => {
  if (state.team) {
    return state.team.outcome === "win" ? state.team.solvedBy : null;
  }
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

const roundScore = (
  progress: { guesses: readonly unknown[]; outcome: PlayerOutcome | null },
  maxTries: number,
): number => {
  if (progress.outcome !== "win") return 0;
  return maxTries - progress.guesses.length + 1;
};

const accumulateScores = (state: WordleState, ctx: GameContext): Record<string, number> => {
  const scores = { ...state.scores };
  if (state.team) {
    // Team modes: every seated teammate banks the shared board's score.
    const points = roundScore(state.team, state.maxTries);
    for (const playerId of state.team.turnOrder) {
      scores[playerId] = (scores[playerId] ?? 0) + points;
    }
    return scores;
  }
  for (const playerId of contestantIds(state, ctx)) {
    const progress = state.players[playerId];
    if (!progress) continue;
    scores[playerId] = (scores[playerId] ?? 0) + roundScore(progress, state.maxTries);
  }
  return scores;
};

const finishRound = (state: WordleState, ctx: GameContext): WordleState => ({
  ...state,
  phase: "results",
  winnerId: computeWinnerId(state, ctx),
  scores: accumulateScores(state, ctx),
  usedWords: state.targetWord
    ? [...state.usedWords, state.targetWord]
    : state.usedWords,
  // `turnIndex` already points at whoever was up next, so the following round
  // opens with them and the rotation carries on.
  nextStarterId: state.team ? state.team.turnOrder[state.team.turnIndex] ?? null : null,
});

const withResultsIfComplete = (state: WordleState, ctx: GameContext): WordleState =>
  allContestantsFinished(state, ctx) ? finishRound(state, ctx) : state;

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
  | { type: "passTurn" }
  | { type: "nextRound" };

const decodeWordleMove = (move: GameMove): WordleMove => {
  switch (move.type) {
    case "start":
    case "passTurn":
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
      id: "mode",
      type: "select",
      label: "Mode",
      default: "solo",
      choices: [
        { value: "solo", label: "Solo" },
        { value: "relay", label: "Take turns" },
        { value: "huddle", label: "All together" },
      ],
    },
    {
      id: "turnSeconds",
      type: "number",
      label: "Turn timer",
      min: 10,
      max: 120,
      default: 45,
      presets: [20, 30, 45, 60],
      suffix: "s",
      showWhen: { id: "mode", equals: ["relay"] },
    },
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
      mode: selectOption(ctx.config, "mode", "solo") as WordleMode,
      wordSource: selectOption(ctx.config, "wordSource", "random") as WordSource,
      turnTimeMs: numberOption(ctx.config, "turnSeconds", 45) * 1_000,
      team: null,
      nextStarterId: null,
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
          return beginRound(
            {
              ...state,
              setterId: null,
              currentRound: 1,
              scores: {},
              usedWords: [],
              nextStarterId: null,
            },
            ctx,
            ctx.rng.pick(WORDLE_WORDS),
          );
        }

        const setter = ctx.rng.pick(ctx.activePlayers);
        return {
          ...state,
          phase: "set-word",
          setterId: setter.id,
          targetWord: null,
          players: {},
          team: null,
          nextStarterId: null,
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
        return beginRound(currentState, ctx, word);
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
        if (state.deadline > 0 && ctx.now >= state.deadline) {
          throw new GameMoveError("Time's up");
        }

        if (state.team) {
          const team = state.team;
          if (!team.turnOrder.includes(move.playerId)) {
            throw new GameMoveError("You are not on the team this round");
          }
          if (team.outcome) {
            throw new GameMoveError("Your team already finished this board");
          }
          const turnId = currentTurnId(state);
          if (turnId && turnId !== move.playerId) {
            const name = ctx.players.find((player) => player.id === turnId)?.name;
            throw new GameMoveError(name ? `It's ${name}'s turn` : "It's not your turn");
          }
          if (turnId && team.turnDeadline > 0 && ctx.now >= team.turnDeadline) {
            throw new GameMoveError("Your turn is over");
          }
          const guess = normalizeWord(m.word, { role: "guess" });
          if (team.guesses.some((entry) => entry.word === guess)) {
            throw new GameMoveError("Your team already guessed that word");
          }
          const feedback = evaluateGuess(state.targetWord, guess);
          const guesses = [
            ...team.guesses,
            { word: guess, feedback, at: ctx.now, by: move.playerId },
          ];
          let nextTeam: TeamRoundState = { ...team, guesses };
          if (isSolved(feedback)) {
            nextTeam = { ...nextTeam, outcome: "win", solvedAt: ctx.now, solvedBy: move.playerId };
          } else if (guesses.length >= state.maxTries) {
            nextTeam = { ...nextTeam, outcome: "lose" };
          }
          if (state.mode === "relay") {
            // Always rotate, even on the final guess, so `turnIndex` names
            // whoever opens the next round. With nobody else connected the
            // guesser simply goes again.
            nextTeam = handTurn(
              nextTeam,
              nextActiveIndex(nextTeam, ctx) ?? nextTeam.turnIndex,
              ctx,
              state.turnTimeMs,
            );
          }
          return withResultsIfComplete({ ...state, team: nextTeam }, ctx);
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
      case "passTurn": {
        if (state.mode !== "relay") {
          throw new GameMoveError("Passing is only for take-turns mode");
        }
        const turnId = currentTurnId(state);
        if (!state.team || !turnId) {
          throw new GameMoveError("Wordle is not accepting guesses right now");
        }
        if (turnId !== move.playerId) {
          throw new GameMoveError("You can only pass on your own turn");
        }
        if (
          (state.deadline > 0 && ctx.now >= state.deadline) ||
          (state.team.turnDeadline > 0 && ctx.now >= state.team.turnDeadline)
        ) {
          throw new GameMoveError("Your turn is over");
        }
        const nextIndex = nextActiveIndex(state.team, ctx);
        if (nextIndex == null) {
          throw new GameMoveError("No teammate is around to take the turn");
        }
        return { ...state, team: handTurn(state.team, nextIndex, ctx, state.turnTimeMs) };
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
          const candidates = WORDLE_WORDS.filter((w) => !state.usedWords.includes(w));
          const word = ctx.rng.pick(candidates.length > 0 ? candidates : WORDLE_WORDS);
          return beginRound(
            { ...state, setterId: null, currentRound: nextRound },
            ctx,
            word,
          );
        }

        const setter = ctx.rng.pick(ctx.activePlayers);
        return {
          ...state,
          phase: "set-word" as const,
          setterId: setter.id,
          targetWord: null,
          players: {},
          team: null,
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

    if (allContestantsFinished(state, ctx)) return finishRound(state, ctx);

    if (state.deadline > 0 && ctx.now >= state.deadline) {
      if (state.team) {
        return finishRound(
          { ...state, team: { ...state.team, outcome: "timeout" } },
          ctx,
        );
      }
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
      return finishRound({ ...state, players }, ctx);
    }

    // Relay: a turn passes on when its timer runs out, or once the guesser has
    // been disconnected for a short grace window (a reconnect blip keeps it).
    // Every branch that changes nothing returns `state` itself, so an idle
    // tick never triggers a broadcast.
    const turnId = currentTurnId(state);
    const team = state.team;
    if (!team || !turnId) return state;

    const nextIndex = nextActiveIndex(team, ctx);
    if (!isActive(ctx, turnId)) {
      // Nobody else to hand to: hold the turn quietly until someone is back
      // or the round deadline closes the board.
      if (nextIndex == null) return state;
      if (team.absentSince == null) {
        return { ...state, team: { ...team, absentSince: ctx.now } };
      }
      if (ctx.now - team.absentSince < TURN_GRACE_MS) return state;
      return { ...state, team: handTurn(team, nextIndex, ctx, state.turnTimeMs) };
    }

    if (ctx.now >= team.turnDeadline) {
      // Alone on the team: the same guesser gets a fresh timer.
      return {
        ...state,
        team: handTurn(team, nextIndex ?? team.turnIndex, ctx, state.turnTimeMs),
      };
    }
    if (team.absentSince != null) {
      return { ...state, team: { ...team, absentSince: null } };
    }
    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const nameOf = (playerId: string | null): string | null =>
      playerId
        ? ctx.players.find((player) => player.id === playerId)?.name ?? "Unknown"
        : null;
    const team = state.team;
    const standings = contestantIds(state, ctx)
      .map((playerId) => {
        const progress = (team
          ? { guesses: team.guesses, outcome: team.outcome, solvedAt: team.solvedAt }
          : state.players[playerId]) ?? {
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

    const turnId = currentTurnId(state);
    const nextUpId = upNextId(state, ctx);
    // Team boards are public: teammates share them, the setter already knows
    // the word, and nobody is racing anyone, so there is nothing to hide.
    const teamView = team
      ? {
          guesses: team.guesses.map((entry) => ({
            word: entry.word,
            feedback: entry.feedback,
            at: entry.at,
            byId: entry.by,
            byName: nameOf(entry.by),
          })),
          outcome: team.outcome,
          solvedById: team.solvedBy,
          solvedByName: nameOf(team.solvedBy),
          members: team.turnOrder.map((playerId) => ({
            playerId,
            playerName: nameOf(playerId) ?? "Unknown",
            active: isActive(ctx, playerId),
          })),
          currentTurnId: turnId,
          currentTurnName: nameOf(turnId),
          nextTurnId: nextUpId,
          turnDeadline: turnId ? team.turnDeadline : null,
        }
      : null;

    return {
      phase: state.phase,
      mode: state.mode,
      turnTimeMs: state.turnTimeMs,
      team: teamView,
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

  playerView(state, playerId, ctx) {
    const isSetter = state.setterId === playerId;
    const team = state.team;
    // In team modes the shared board doubles as "my board", so clients that
    // only know solo Wordle still render the team's rows and gate input on turn.
    const onTeam = Boolean(team?.turnOrder.includes(playerId));
    const progress: PlayerRoundState | null = team
      ? onTeam
        ? {
            guesses: team.guesses.map(({ word, feedback, at }) => ({ word, feedback, at })),
            outcome: team.outcome,
            solvedAt: team.solvedAt,
          }
        : null
      : state.players[playerId] ?? null;
    const turnId = currentTurnId(state);
    const isMyTurn = onTeam && (state.mode === "huddle" || turnId === playerId);
    const isUpNext = upNextId(state, ctx) === playerId;

    return {
      currentRound: state.currentRound,
      isSetter,
      isMyTurn: state.phase === "playing" && team?.outcome == null && isMyTurn,
      isUpNext,
      canSetWord: state.phase === "set-word" && isSetter,
      canGuess:
        state.phase === "playing" &&
        !isSetter &&
        progress?.outcome == null &&
        (!team || (progress != null && isMyTurn)),
      secretWord: isSetter || state.phase === "results" ? state.targetWord : null,
      myGuesses: progress?.guesses ?? [],
      myOutcome: progress?.outcome ?? null,
      mySolvedAt: progress?.solvedAt ?? null,
      // The setter already knows the word, so their private view carries every
      // contestant's live board (letters included) to spectate while waiting.
      // Contestants never receive each other's boards; letters would leak.
      boards: !isSetter
        ? null
        : team
          ? // Clients that predate team modes only show the setter `boards`, so
            // mirror the shared board as one entry, labelled with whoever is up
            // (or made the latest guess).
            [
              {
                playerId:
                  turnId ??
                  team.guesses[team.guesses.length - 1]?.by ??
                  team.turnOrder[0] ??
                  "team",
                guesses: team.guesses.map(({ word, feedback, at }) => ({ word, feedback, at })),
                outcome: team.outcome,
              },
            ]
          : Object.entries(state.players).map(([contestantId, contestant]) => ({
              playerId: contestantId,
              guesses: contestant.guesses,
              outcome: contestant.outcome,
            })),
    };
  },

  isFinished: (state) =>
    state.phase === "results" && state.currentRound >= state.totalRounds,
};

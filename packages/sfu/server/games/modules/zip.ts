import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { numberOption, selectOption } from "../config.js";
import {
  generatePuzzle,
  validateMove,
  validateCompletePath,
  solveForHint,
  getFirstAnchor,
  type CellIndex,
  type BarrierEdge,
  type AnchorMap,
  type GeneratedPuzzle,
  type SupportedGridSize,
} from "./zipSolver.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type PlayerOutcome = "win" | "timeout";

type PlayerBoard = {
  path: CellIndex[];
  outcome: PlayerOutcome | null;
  solvedAt: number | null;
  hintsUsed: number;
  hintAvailableAt: number;
  mistakes: number;
};

type ZipState = {
  phase: "lobby" | "playing" | "results";
  gridSize: SupportedGridSize;
  anchors: AnchorMap;
  barriers: BarrierEdge[];
  deadCells: CellIndex[];
  solutionPath: CellIndex[];
  players: Record<string, PlayerBoard>;
  roundStartedAt: number;
  winnerId: string | null;
  totalRounds: number;
  currentRound: number;
  scores: Record<string, number>;
};

/* ------------------------------------------------------------------ */
/*  Scoring                                                            */
/* ------------------------------------------------------------------ */

const SOLVE_BASE = 100;
const HINT_PENALTY = 15;
const HINT_COOLDOWN_MS = 3_000;
const MIN_SOLVE_SCORE = 10;
const SPEED_BONUS_MAX = 50;
const SPEED_DIVISOR = 3000; // ms per point lost

const roundScore = (board: PlayerBoard, roundStartedAt: number): number => {
  if (board.outcome !== "win" || board.solvedAt == null) return 0;

  // Base minus hint penalty.
  const base = Math.max(MIN_SOLVE_SCORE, SOLVE_BASE - board.hintsUsed * HINT_PENALTY);

  // Speed bonus: full bonus for instant solve, decreasing linearly.
  const solveTimeMs = Math.max(0, board.solvedAt - roundStartedAt);
  const speedBonus = Math.max(0, SPEED_BONUS_MAX - Math.floor(solveTimeMs / SPEED_DIVISOR));

  return base + speedBonus;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const winnerName = (ctx: GameContext, winnerId: string | null): string | null => {
  if (!winnerId) return null;
  return ctx.players.find((p) => p.id === winnerId)?.name ?? null;
};

const computeWinnerId = (state: ZipState): string | null => {
  const winners = Object.entries(state.players)
    .filter(([, board]) => board.outcome === "win" && board.solvedAt != null)
    .sort(([, a], [, b]) => {
      // Fewest hints first.
      const hints = a.hintsUsed - b.hintsUsed;
      if (hints !== 0) return hints;
      // Then fastest time.
      return (a.solvedAt ?? Infinity) - (b.solvedAt ?? Infinity);
    });
  return winners[0]?.[0] ?? null;
};

const allPlayersFinished = (state: ZipState, ctx: GameContext): boolean =>
  ctx.activePlayers.length > 0 &&
  ctx.activePlayers.every((player) => state.players[player.id]?.outcome != null);

const accumulateScores = (state: ZipState): Record<string, number> => {
  const scores = { ...state.scores };
  for (const [playerId, board] of Object.entries(state.players)) {
    scores[playerId] = (scores[playerId] ?? 0) + roundScore(board, state.roundStartedAt);
  }
  return scores;
};

const withResultsIfComplete = (state: ZipState, ctx: GameContext): ZipState => {
  if (!allPlayersFinished(state, ctx)) return state;
  return {
    ...state,
    phase: "results",
    winnerId: computeWinnerId(state),
    scores: accumulateScores(state),
  };
};

const parseGridSize = (value: string): SupportedGridSize => {
  const n = parseInt(value, 10);
  if (n === 6 || n === 7 || n === 8 || n === 9) return n;
  return 6;
};

const getAnchorCountForSize = (size: SupportedGridSize): number => {
  switch (size) {
    case 6:
      return 8;
    case 7:
      return 10;
    case 8:
      return 12;
    case 9:
      return 14;
    default:
      return 8;
  }
};

const startPlaying = (state: ZipState, ctx: GameContext, round: number): ZipState => {
  const size = parseGridSize(selectOption(ctx.config, "gridSize", "6"));
  const puzzle = generatePuzzle({
    size,
    anchorCount: getAnchorCountForSize(size),
    seed: Math.floor(ctx.rng.next() * 0x1_0000_0000) >>> 0,
  });

  const startCell = getFirstAnchor(puzzle);

  const players: Record<string, PlayerBoard> = {};
  for (const player of ctx.activePlayers) {
    players[player.id] = {
      path: [startCell],
      outcome: null,
      solvedAt: null,
      hintsUsed: 0,
      hintAvailableAt: 0,
      mistakes: 0,
    };
  }

  return {
    ...state,
    phase: "playing",
    gridSize: size,
    anchors: puzzle.anchors,
    barriers: puzzle.barriers,
    deadCells: puzzle.deadCells,
    solutionPath: puzzle.solutionPath,
    players,
    roundStartedAt: ctx.now,
    winnerId: null,
    currentRound: round,
  };
};

const buildPuzzleForValidation = (state: ZipState): GeneratedPuzzle => ({
  size: state.gridSize,
  anchors: state.anchors,
  barriers: state.barriers,
  deadCells: state.deadCells,
  solutionPath: state.solutionPath,
  seed: 0,
  anchorCount: 0,
});

/* ------------------------------------------------------------------ */
/*  Module                                                             */
/* ------------------------------------------------------------------ */

export const zipModule: GameModule<ZipState> = {
  id: "zip",
  name: "Zip",
  description: "Draw one path through every cell",
  minPlayers: 1,
  maxPlayers: 32,
  tickMs: 500,
  hasLeaderboard: true,
  options: [
    {
      id: "gridSize",
      type: "select",
      label: "Grid",
      default: "6",
      choices: [
        { value: "6", label: "6×6 Easy" },
        { value: "7", label: "7×7 Medium" },
        { value: "8", label: "8×8 Hard" },
        { value: "9", label: "9×9 Expert" },
      ],
    },
    {
      id: "rounds",
      type: "number",
      label: "Rounds",
      min: 1,
      max: 5,
      default: 1,
      presets: [1, 3, 5],
    },
  ],

  setup(ctx: GameContext): ZipState {
    return {
      phase: "lobby",
      gridSize: parseGridSize(selectOption(ctx.config, "gridSize", "6")),
      anchors: {},
      barriers: [],
      deadCells: [],
      solutionPath: [],
      players: {},
      roundStartedAt: 0,
      winnerId: null,
      totalRounds: numberOption(ctx.config, "rounds", 1),
      currentRound: 0,
      scores: {},
    };
  },

  onMove(state, move: GameMove, ctx): ZipState {
    switch (move.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) {
          throw new GameMoveError("Only the host can start");
        }
        if (state.phase !== "lobby") {
          throw new GameMoveError("Already running");
        }
        if (ctx.activePlayers.length < 1) {
          throw new GameMoveError("Need at least 1 player");
        }
        return startPlaying(state, ctx, 1);
      }

      case "move": {
        if (state.phase !== "playing") {
          throw new GameMoveError("Not accepting moves right now");
        }
        const board = state.players[move.playerId];
        if (!board) {
          throw new GameMoveError("You are not in this round");
        }
        if (board.outcome) {
          throw new GameMoveError("You already finished");
        }

        const payload = move.payload as { cells?: unknown } | undefined;
        if (!payload || !Array.isArray(payload.cells)) {
          throw new GameMoveError("Invalid move payload");
        }

        if (
          payload.cells.some(
            (cell) =>
              !Number.isInteger(cell) ||
              cell < 0 ||
              cell >= state.gridSize * state.gridSize,
          )
        ) {
          throw new GameMoveError("Path must contain valid cell IDs");
        }

        const cells = payload.cells as CellIndex[];
        if (cells.length === 0) {
          throw new GameMoveError("No cells provided");
        }
        if (cells.length > state.gridSize * state.gridSize - state.deadCells.length) {
          throw new GameMoveError("Path is longer than this puzzle allows");
        }

        // The client sends the full updated path. Validate it from scratch.
        const puzzle = buildPuzzleForValidation(state);

        // Validate the path is a valid prefix.
        const firstCell = cells[0];
        const expectedStart = getFirstAnchor(puzzle);
        if (firstCell !== expectedStart) {
          throw new GameMoveError("Path must start at anchor 1");
        }

        // Validate each step.
        for (let i = 1; i < cells.length; i++) {
          const result = validateMove(cells.slice(0, i), cells[i], puzzle);
          if (!result.valid) {
            throw new GameMoveError(result.reason);
          }
        }

        const nextBoard: PlayerBoard = {
          ...board,
          path: cells,
        };

        // Check for win.
        const totalValidCells = state.gridSize * state.gridSize - state.deadCells.length;
        if (cells.length === totalValidCells) {
          const winCheck = validateCompletePath(cells, puzzle);
          if (winCheck.valid) {
            nextBoard.outcome = "win";
            nextBoard.solvedAt = ctx.now;
          }
        }

        const nextState: ZipState = {
          ...state,
          players: {
            ...state.players,
            [move.playerId]: nextBoard,
          },
        };

        return withResultsIfComplete(nextState, ctx);
      }

      case "hint": {
        if (state.phase !== "playing") {
          throw new GameMoveError("Not accepting hints right now");
        }
        const board = state.players[move.playerId];
        if (!board) {
          throw new GameMoveError("You are not in this round");
        }
        if (board.outcome) {
          throw new GameMoveError("You already finished");
        }
        if (ctx.now < board.hintAvailableAt) {
          const remainingSeconds = Math.ceil((board.hintAvailableAt - ctx.now) / 1000);
          throw new GameMoveError(`Hint available in ${remainingSeconds}s`);
        }

        const puzzle = buildPuzzleForValidation(state);
        const hintResult = solveForHint(puzzle, board.path);
        if (!hintResult) {
          throw new GameMoveError("Unable to compute hint");
        }

        const newPath = [...hintResult.validPrefix, hintResult.nextCell];

        const nextBoard: PlayerBoard = {
          ...board,
          path: newPath,
          hintsUsed: board.hintsUsed + 1,
          hintAvailableAt: ctx.now + HINT_COOLDOWN_MS,
        };

        // Check for win after hint.
        const totalValidCells = state.gridSize * state.gridSize - state.deadCells.length;
        if (newPath.length === totalValidCells) {
          const winCheck = validateCompletePath(newPath, puzzle);
          if (winCheck.valid) {
            nextBoard.outcome = "win";
            nextBoard.solvedAt = ctx.now;
          }
        }

        const nextState: ZipState = {
          ...state,
          players: {
            ...state.players,
            [move.playerId]: nextBoard,
          },
        };
        return withResultsIfComplete(nextState, ctx);
      }

      case "reset": {
        if (state.phase !== "playing") {
          throw new GameMoveError("Not accepting resets right now");
        }
        const board = state.players[move.playerId];
        if (!board) {
          throw new GameMoveError("You are not in this round");
        }
        if (board.outcome) {
          throw new GameMoveError("You already finished");
        }

        const puzzle = buildPuzzleForValidation(state);

        return {
          ...state,
          players: {
            ...state.players,
            [move.playerId]: {
              ...board,
              path: [getFirstAnchor(puzzle)],
            },
          },
        };
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
        return startPlaying(state, ctx, state.currentRound + 1);
      }

      default:
        throw new GameMoveError(`Unknown move: ${move.type}`);
    }
  },

  onTick(state, ctx): ZipState {
    if (state.phase !== "playing") return state;

    // Early completion: all players finished.
    if (allPlayersFinished(state, ctx)) {
      return {
        ...state,
        phase: "results",
        winnerId: computeWinnerId(state),
        scores: accumulateScores(state),
      };
    }

    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const totalValidCells = state.phase === "lobby" ? 0 : state.gridSize * state.gridSize - state.deadCells.length;

    const standings = Object.entries(state.players)
      .map(([playerId, board]) => ({
        playerId,
        playerName: ctx.players.find((p) => p.id === playerId)?.name ?? "Unknown",
        cellsFilled: board.path.length,
        totalCells: totalValidCells,
        outcome: board.outcome,
        hintsUsed: board.hintsUsed,
        solvedAt: board.solvedAt,
      }))
      .sort((a, b) => {
        const aWon = a.outcome === "win";
        const bWon = b.outcome === "win";
        if (aWon !== bWon) return aWon ? -1 : 1;
        if (aWon && bWon) {
          const hints = a.hintsUsed - b.hintsUsed;
          if (hints !== 0) return hints;
          return (a.solvedAt ?? Infinity) - (b.solvedAt ?? Infinity);
        }
        // Sort by progress.
        return b.cellsFilled - a.cellsFilled;
      });

    const scoreEntries = Object.entries(state.scores)
      .map(([playerId, score]) => ({
        playerId,
        playerName: ctx.players.find((p) => p.id === playerId)?.name ?? "Unknown",
        score,
      }))
      .sort((a, b) => b.score - a.score);

    const scoreboard = ctx.players
      .map((p) => ({ id: p.id, name: p.name, score: state.scores[p.id] ?? 0 }))
      .sort((a, b) => b.score - a.score);

    return {
      phase: state.phase,
      gridSize: state.gridSize,
      anchors: state.anchors,
      barriers: state.barriers,
      deadCells: state.deadCells,
      serverNow: ctx.now,
      roundStartedAt: state.phase === "lobby" ? null : state.roundStartedAt,
      standings,
      finishedCount: standings.filter((s) => s.outcome != null).length,
      totalPlayers: standings.length,
      currentRound: state.currentRound,
      totalRounds: state.totalRounds,
      isFinalRound: state.currentRound >= state.totalRounds,
      scores: scoreEntries,
      scoreboard,
      result:
        state.phase === "results"
          ? {
              solutionPath: state.solutionPath,
              winnerId: state.winnerId,
              winnerName: winnerName(ctx, state.winnerId),
            }
          : null,
    };
  },

  playerView(state, playerId) {
    const board = state.players[playerId] ?? null;
    return {
      path: board?.path ?? [],
      outcome: board?.outcome ?? null,
      solvedAt: board?.solvedAt ?? null,
      hintsUsed: board?.hintsUsed ?? 0,
      hintAvailableAt: board?.hintAvailableAt ?? 0,
      mistakes: board?.mistakes ?? 0,
    };
  },

  isFinished: (state) =>
    state.phase === "results" && state.currentRound >= state.totalRounds,
};

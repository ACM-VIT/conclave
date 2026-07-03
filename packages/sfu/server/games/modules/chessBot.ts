import { Chess, type Move as ChessJsMove } from "chess.js";
import type { GameRng } from "../types.js";

/**
 * Small built-in chess engine for the "vs computer" mode.
 *
 * Runs synchronously inside the game tick, so every level is capped by BOTH a
 * node budget and a wall-clock deadline: the search aborts mid-iteration and
 * falls back to the best move from the last fully completed depth. Worst case
 * is a ~200ms event-loop pause once per bot move in one room, which is fine at
 * party scale.
 *
 * Strength comes from classic ingredients: material + piece-square tables
 * (Michniewski's "simplified evaluation function"), alpha-beta with MVV-LVA
 * move ordering, and a capture-only quiescence search on the hardest level.
 * Easy/medium add score noise and (for easy) occasional random moves so they
 * feel beatable rather than artificially hesitant.
 */

export type BotLevel = "easy" | "medium" | "hard";

export type BotMove = {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
};

type LevelProfile = {
  depth: number;
  maxNodes: number;
  maxMs: number;
  /** Uniform score noise (centipawns) applied per root move before picking. */
  noise: number;
  /** Probability of ignoring the search and playing a random legal move. */
  randomMoveChance: number;
  quiescence: boolean;
};

/**
 * Budgets bound the synchronous pause per bot move. Media is not affected
 * (mediasoup routes RTP in separate worker processes); only signaling shares
 * this event loop, so ~400ms worst case on hard is acceptable.
 */
const LEVELS: Record<BotLevel, LevelProfile> = {
  easy: { depth: 1, maxNodes: 1_500, maxMs: 60, noise: 90, randomMoveChance: 0.18, quiescence: false },
  medium: { depth: 2, maxNodes: 8_000, maxMs: 160, noise: 25, randomMoveChance: 0, quiescence: false },
  hard: { depth: 4, maxNodes: 30_000, maxMs: 400, noise: 0, randomMoveChance: 0, quiescence: true },
};

const MATE = 1_000_000;
const PIECE_VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20_000 };

// prettier-ignore
const PST: Record<string, number[]> = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

class SearchAbort extends Error {}

type SearchBudget = {
  nodes: number;
  maxNodes: number;
  deadline: number;
};

const checkBudget = (budget: SearchBudget): void => {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) throw new SearchAbort();
  if ((budget.nodes & 63) === 0 && Date.now() > budget.deadline) throw new SearchAbort();
};

/** Manhattan distance from the nearest of the four centre squares. */
const centreDistance = (rank: number, file: number): number => {
  const dr = rank <= 3 ? 3 - rank : rank - 4;
  const df = file <= 3 ? 3 - file : file - 4;
  return dr + df;
};

/**
 * Static evaluation from White's perspective, in centipawns.
 *
 * Material + piece-square tables, plus a "mop-up" term once one side has a
 * bare king against a winning material edge: reward pushing the losing king
 * to the edge and marching the winning king in. Without it the search has no
 * gradient in trivially won endgames (K+R vs K) and shuffles to a draw.
 */
const evaluate = (game: Chess): number => {
  let score = 0;
  let whiteMaterial = 0;
  let blackMaterial = 0;
  let wkRank = 0, wkFile = 0, bkRank = 0, bkFile = 0;
  const board = game.board();
  for (let rank = 0; rank < 8; rank += 1) {
    const row = board[rank];
    for (let file = 0; file < 8; file += 1) {
      const piece = row[file];
      if (!piece) continue;
      const table = PST[piece.type];
      if (piece.color === "w") {
        score += PIECE_VALUE[piece.type] + table[rank * 8 + file];
        if (piece.type === "k") {
          wkRank = rank;
          wkFile = file;
        } else {
          whiteMaterial += PIECE_VALUE[piece.type];
        }
      } else {
        score -= PIECE_VALUE[piece.type] + table[(7 - rank) * 8 + file];
        if (piece.type === "k") {
          bkRank = rank;
          bkFile = file;
        } else {
          blackMaterial += PIECE_VALUE[piece.type];
        }
      }
    }
  }
  const kingsApart = Math.abs(wkRank - bkRank) + Math.abs(wkFile - bkFile);
  if (blackMaterial === 0 && whiteMaterial >= 500) {
    score += 47 * centreDistance(bkRank, bkFile) + 16 * (14 - kingsApart);
  } else if (whiteMaterial === 0 && blackMaterial >= 500) {
    score -= 47 * centreDistance(wkRank, wkFile) + 16 * (14 - kingsApart);
  }
  return score;
};

/** Score for the side to move (negamax convention). */
const evaluateForTurn = (game: Chess): number =>
  game.turn() === "w" ? evaluate(game) : -evaluate(game);

const orderMoves = (moves: ChessJsMove[]): ChessJsMove[] =>
  moves
    .map((move, index) => {
      let weight = 0;
      if (move.captured) weight += 10_000 + PIECE_VALUE[move.captured] - PIECE_VALUE[move.piece] / 10;
      if (move.promotion) weight += 9_000 + PIECE_VALUE[move.promotion];
      return { move, weight, index };
    })
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.move);

const quiescence = (
  game: Chess,
  alpha: number,
  beta: number,
  depth: number,
  budget: SearchBudget,
): number => {
  checkBudget(budget);
  const standPat = evaluateForTurn(game);
  if (standPat >= beta || depth <= 0) return standPat;
  let best = standPat;
  if (best > alpha) alpha = best;
  const captures = orderMoves(game.moves({ verbose: true }).filter((move) => move.captured));
  for (const move of captures) {
    game.move(move);
    const score = -quiescence(game, -beta, -alpha, depth - 1, budget);
    game.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
};

const negamax = (
  game: Chess,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  budget: SearchBudget,
  useQuiescence: boolean,
): number => {
  checkBudget(budget);
  const moves = game.moves({ verbose: true });
  if (moves.length === 0) {
    return game.inCheck() ? -(MATE - ply) : 0;
  }
  if (game.isDraw()) return 0;
  if (depth <= 0) {
    return useQuiescence
      ? quiescence(game, alpha, beta, 6, budget)
      : evaluateForTurn(game);
  }
  let best = -Infinity;
  for (const move of orderMoves(moves)) {
    game.move(move);
    const score = -negamax(game, depth - 1, -beta, -alpha, ply + 1, budget, useQuiescence);
    game.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
};

type ScoredMove = { move: ChessJsMove; score: number };

/** Search all root moves at a fixed depth. Throws SearchAbort on budget end. */
const searchRoot = (
  game: Chess,
  depth: number,
  budget: SearchBudget,
  useQuiescence: boolean,
): ScoredMove[] => {
  const scored: ScoredMove[] = [];
  let alpha = -Infinity;
  for (const move of orderMoves(game.moves({ verbose: true }))) {
    game.move(move);
    const score = -negamax(game, depth - 1, -Infinity, -alpha, 1, budget, useQuiescence);
    game.undo();
    scored.push({ move, score });
    if (score > alpha) alpha = score;
  }
  return scored;
};

const toBotMove = (move: ChessJsMove): BotMove => ({
  from: move.from,
  to: move.to,
  promotion: move.promotion as BotMove["promotion"],
});

/** Position identity for repetition tracking: fen without the move counters. */
const positionKey = (fen: string): string => fen.split(" ").slice(0, 4).join(" ");

/**
 * Pick the bot's move for the given position. Always returns a legal move
 * (or null when the position has none, i.e. the game is already over).
 *
 * `recentFens` is the game's position history. The search itself is built
 * from a bare fen and cannot see threefold repetition, so when the bot is
 * clearly winning, root moves that revisit an earlier position are penalized
 * - otherwise it happily shuffles a won endgame into a draw.
 */
export const pickBotMove = (
  fen: string,
  level: BotLevel,
  rng: GameRng,
  recentFens: readonly string[] = [],
): BotMove | null => {
  const profile = LEVELS[level];
  const game = new Chess(fen);
  const legal = game.moves({ verbose: true });
  if (legal.length === 0) return null;
  if (legal.length === 1) return toBotMove(legal[0]);

  if (profile.randomMoveChance > 0 && rng.next() < profile.randomMoveChance) {
    return toBotMove(rng.pick(legal));
  }

  // Read before searching: an aborted search unwinds without undoing the
  // moves currently on `game`'s stack, so `game` must not be used after it.
  const winningNow = evaluateForTurn(game) >= 300;

  const budget: SearchBudget = {
    nodes: 0,
    maxNodes: profile.maxNodes,
    deadline: Date.now() + profile.maxMs,
  };

  // Low-material endgames have a tiny branching factor, and shallow search
  // cannot execute a mating plan (K+R vs K needs ~6 plies of foresight).
  // Extend the depth cap there; the node/time budget still bounds the work.
  const pieceCount = (fen.split(" ")[0].match(/[a-zA-Z]/g) ?? []).length;
  const extraDepth =
    level === "easy" ? 0 : pieceCount <= 6 ? 5 : pieceCount <= 10 ? 2 : 0;
  const depthCap = profile.depth + extraDepth;

  // Iterative deepening: keep the last fully completed depth's scores so a
  // mid-iteration abort still leaves a sensibly ranked move list.
  let completed: ScoredMove[] | null = null;
  for (let depth = 1; depth <= depthCap; depth += 1) {
    try {
      completed = searchRoot(game, depth, budget, profile.quiescence && depth >= profile.depth);
    } catch (error) {
      if (error instanceof SearchAbort) break;
      throw error;
    }
  }
  if (!completed || completed.length === 0) {
    return toBotMove(rng.pick(legal));
  }

  const seen = new Map<string, number>();
  if (winningNow && recentFens.length > 0) {
    for (const past of recentFens) {
      const key = positionKey(past);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const probe = seen.size > 0 ? new Chess(fen) : null;
  const repetitionPenalty = (move: ChessJsMove): number => {
    if (!probe) return 0;
    probe.move({ from: move.from, to: move.to, promotion: move.promotion });
    const count = seen.get(positionKey(probe.fen())) ?? 0;
    probe.undo();
    return count * 120;
  };

  const noisy = completed.map((entry) => ({
    move: entry.move,
    score:
      entry.score -
      repetitionPenalty(entry.move) +
      (profile.noise > 0 ? (rng.next() * 2 - 1) * profile.noise : 0),
  }));
  let best = noisy[0];
  const ties: ScoredMove[] = [];
  for (const entry of noisy) {
    if (entry.score > best.score) best = entry;
  }
  for (const entry of noisy) {
    if (entry.score === best.score) ties.push(entry);
  }
  return toBotMove(ties.length > 1 ? rng.pick(ties).move : best.move);
};

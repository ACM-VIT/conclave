/* Ad-hoc strength harness for the chess bot (not wired into CI). */
import { Chess, type Move } from "chess.js";
import { pickBotMove, type BotLevel } from "../server/games/modules/chessBot.js";
import type { GameRng } from "../server/games/types.js";

const mkRng = (seed: number): GameRng => {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    pick: (items) => items[Math.floor(next() * items.length)],
  };
};

type Player = BotLevel | "random";
const thinkTimes: number[] = [];

const pickMove = (game: Chess, player: Player, rng: GameRng, fens: string[] = []): Move | null => {
  const legal = game.moves({ verbose: true });
  if (legal.length === 0) return null;
  if (player === "random") return rng.pick(legal);
  const t0 = Date.now();
  const bm = pickBotMove(game.fen(), player, rng, fens);
  if (player === "hard") thinkTimes.push(Date.now() - t0);
  if (!bm) return null;
  return legal.find((m) => m.from === bm.from && m.to === bm.to && (m.promotion ?? undefined) === bm.promotion) ?? null;
};

const material = (game: Chess): number => {
  const val: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let sum = 0;
  for (const row of game.board()) for (const p of row) {
    if (p) sum += (p.color === "w" ? 1 : -1) * val[p.type];
  }
  return sum;
};

/** Returns "white" | "black" | "draw", plies played, end reason. */
const playGame = (white: Player, black: Player, rng: GameRng, maxPlies = 240) => {
  const game = new Chess();
  const fens = [game.fen()];
  let plies = 0;
  while (!game.isGameOver() && plies < maxPlies) {
    const mv = pickMove(game, game.turn() === "w" ? white : black, rng, fens);
    if (!mv) break;
    game.move(mv);
    fens.push(game.fen());
    plies += 1;
  }
  if (game.isCheckmate()) {
    return { winner: game.turn() === "w" ? "black" : "white", plies, reason: "mate" };
  }
  if (game.isGameOver()) return { winner: "draw", plies, reason: "draw" };
  const m = material(game);
  if (Math.abs(m) >= 4) return { winner: m > 0 ? "white" : "black", plies, reason: "adjudicated" };
  return { winner: "draw", plies, reason: "adjudicated-draw" };
};

const matchup = (a: Player, b: Player, games: number, rng: GameRng) => {
  let w = 0, d = 0, l = 0, totalPlies = 0;
  const reasons: Record<string, number> = {};
  const t0 = Date.now();
  for (let i = 0; i < games; i += 1) {
    const aIsWhite = i % 2 === 0;
    const res = playGame(aIsWhite ? a : b, aIsWhite ? b : a, rng);
    const aWon = res.winner === (aIsWhite ? "white" : "black");
    if (res.winner === "draw") d += 1;
    else if (aWon) w += 1;
    else l += 1;
    totalPlies += res.plies;
    reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
  }
  console.log(
    `${a} vs ${b}: +${w} =${d} -${l}  (avg ${Math.round(totalPlies / games)} plies, ${((Date.now() - t0) / 1000).toFixed(1)}s, ${JSON.stringify(reasons)})`,
  );
};

const tactic = (name: string, fen: string, good: (m: { from: string; to: string }) => boolean) => {
  const rng = mkRng(7);
  const results: string[] = [];
  for (const level of ["easy", "medium", "hard"] as const) {
    const mv = pickBotMove(fen, level, rng);
    const game = new Chess(fen);
    const san = mv ? game.move({ from: mv.from, to: mv.to, promotion: mv.promotion ?? "q" }).san : "??";
    results.push(`${level}: ${san}${mv && good(mv) ? " ✓" : " ✗"}`);
  }
  console.log(`${name}: ${results.join("  ")}`);
};

const rng = mkRng(42);

// Warm the JIT so tactic picks reflect a long-lived server process, not
// cold-start budget aborts.
for (let i = 0; i < 5; i += 1) pickBotMove(new Chess().fen(), "hard", rng);

console.log("--- tactics ---");
// Black queen on d3, capturable by the c2 or e2 pawn.
tactic("free queen", "rnb1kbnr/pppp1ppp/8/8/8/3q4/PPPPPPPP/RNBQKBNR w KQkq - 0 1", (m) => m.to === "d3");
// Undefended rook on e5; Rxe5 is the unique clearly-best move.
tactic("free rook", "k7/8/8/4r3/8/8/4R3/K7 w - - 0 1", (m) => m.from === "e2" && m.to === "e5");
tactic("mate in 1", "7k/1R6/8/8/8/8/8/R3K3 w - - 0 1", (m) => m.from === "a1" && m.to === "a8");

console.log("--- K+R vs K endgame (hard, both sides, 160 plies, real history) ---");
{
  const game = new Chess("8/8/8/4k3/8/8/4K3/4R3 w - - 0 1");
  const fens = [game.fen()];
  let plies = 0;
  while (!game.isGameOver() && plies < 160) {
    const legal = game.moves({ verbose: true });
    if (legal.length === 0) break;
    const bm = pickBotMove(game.fen(), "hard", rng, fens);
    if (!bm) break;
    game.move({ from: bm.from, to: bm.to, promotion: bm.promotion ?? "q" });
    fens.push(game.fen());
    plies += 1;
  }
  console.log(game.isCheckmate() ? `mates in ${Math.ceil(plies / 2)} moves ✓` : `NO mate after ${plies} plies (${game.isGameOver() ? "draw" : "cut off"}) ✗`);
}

console.log("--- matchups ---");
matchup("easy", "random", 10, rng);
matchup("medium", "random", 10, rng);
matchup("hard", "random", 10, rng);
matchup("medium", "easy", 8, rng);
matchup("hard", "easy", 8, rng);
matchup("hard", "medium", 8, rng);

if (thinkTimes.length > 0) {
  const avg = thinkTimes.reduce((a, b) => a + b, 0) / thinkTimes.length;
  const max = Math.max(...thinkTimes);
  console.log(`--- hard think time: avg ${avg.toFixed(0)}ms, max ${max}ms over ${thinkTimes.length} moves ---`);
}

import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
} from "../types.js";
import { numberOption } from "../config.js";
import { allActivePlayersActed } from "../roundLoop.js";

/**
 * Reaction: a reflex arena. Each round the panel waits ("do not tap"), then
 * flips to "TAP" at a random moment. Fastest valid tap wins; tapping early is a
 * fault. Reaction time is measured from the server-authoritative go moment and
 * the server receive time, with a small server-owned latency allowance so
 * clients cannot forge the clock.
 */

const TOTAL_ROUNDS = 5;
const MIN_ARM_MS = 1_500;
const MAX_ARM_MS = 5_000;
const GO_WINDOW_MS = 4_000;
const REVEAL_MS = 4_500;
const RANK_POINTS = [100, 80, 65, 55, 45];
const MIN_VALID_POINTS = 30;
const SERVER_TAP_LATENCY_ALLOWANCE_MS = 75;

type Phase = "lobby" | "arming" | "go" | "reveal" | "results";

type Tap = { reactionMs: number | null; early: boolean };

type ReactionState = {
  phase: Phase;
  round: number;
  totalRounds: number;
  goAt: number;
  deadline: number;
  taps: Record<string, Tap>;
  scores: Record<string, number>;
};

const startRound = (state: ReactionState, ctx: GameContext, round: number): ReactionState => ({
  ...state,
  phase: "arming",
  round,
  goAt: ctx.now + MIN_ARM_MS + ctx.rng.int(MAX_ARM_MS - MIN_ARM_MS),
  deadline: 0,
  taps: {},
});

const scoreRound = (state: ReactionState): void => {
  const valid = Object.entries(state.taps)
    .filter(([, tap]) => !tap.early && tap.reactionMs != null)
    .sort((a, b) => (a[1].reactionMs ?? 0) - (b[1].reactionMs ?? 0));
  valid.forEach(([playerId], rank) => {
    const points = RANK_POINTS[rank] ?? MIN_VALID_POINTS;
    state.scores[playerId] = (state.scores[playerId] ?? 0) + points;
  });
};

const scoreboard = (state: ReactionState, ctx: GameContext) =>
  ctx.players
    .map((p) => ({ id: p.id, name: p.name, score: state.scores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);

/**
 * Typed move contract. Decoded from the untrusted `GameMove` at the top of
 * `onMove`. Reaction moves carry no payload, so the decoder only narrows the
 * type and rejects unknown moves.
 */
export type ReactionMove =
  | { type: "start" }
  | { type: "tap" }
  | { type: "next" };

const decodeReactionMove = (move: GameMove): ReactionMove => {
  switch (move.type) {
    case "start":
    case "tap":
    case "next":
      return { type: move.type };
    default:
      throw new GameMoveError(`Unknown move: ${move.type}`);
  }
};

export const reactionModule: GameModule<ReactionState> = {
  id: "reaction",
  name: "Reaction",
  description: "Tap the instant it turns green",
  minPlayers: 1,
  maxPlayers: 50,
  tickMs: 120,
  hasLeaderboard: true,
  options: [
    { id: "rounds", type: "number", label: "Rounds", min: 3, max: 10, default: 5, presets: [3, 5, 7] },
  ],

  setup(ctx: GameContext): ReactionState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p.id] = 0;
    const totalRounds = numberOption(ctx.config, "rounds", TOTAL_ROUNDS);
    return { phase: "lobby", round: 0, totalRounds, goAt: 0, deadline: 0, taps: {}, scores };
  },

  onMove(state, move: GameMove, ctx): ReactionState {
    const m = decodeReactionMove(move);
    switch (m.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        return startRound(state, ctx, 0);
      }
      case "tap": {
        if (state.phase !== "arming" && state.phase !== "go") {
          throw new GameMoveError("Not now");
        }
        if (state.taps[move.playerId]) throw new GameMoveError("Already tapped");
        const tap: Tap =
          state.phase === "arming"
            ? { reactionMs: null, early: true }
            : {
                reactionMs: Math.max(
                  0,
                  ctx.now - state.goAt - SERVER_TAP_LATENCY_ALLOWANCE_MS,
                ),
                early: false,
              };
        return { ...state, taps: { ...state.taps, [move.playerId]: tap } };
      }
      case "next": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can advance");
        if (state.phase !== "reveal") throw new GameMoveError("Wait for the reveal");
        return { ...state, deadline: ctx.now };
      }
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): ReactionState {
    if (state.phase === "arming" && ctx.now >= state.goAt) {
      return { ...state, phase: "go", deadline: ctx.now + GO_WINDOW_MS };
    }
    if (state.phase === "go") {
      const everyone = allActivePlayersActed(ctx, (playerId) =>
        Boolean(state.taps[playerId]),
      );
      if (ctx.now >= state.deadline || everyone) {
        const next: ReactionState = { ...state, taps: { ...state.taps }, scores: { ...state.scores } };
        scoreRound(next);
        next.phase = "reveal";
        next.deadline = ctx.now + REVEAL_MS;
        return next;
      }
    }
    if (state.phase === "reveal" && ctx.now >= state.deadline) {
      const isLast = state.round + 1 >= state.totalRounds;
      if (isLast) return { ...state, phase: "results" };
      return startRound(state, ctx, state.round + 1);
    }
    return state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const reveal = state.phase === "reveal";
    const results = reveal
      ? Object.entries(state.taps)
          .map(([id, tap]) => ({
            id,
            name: ctx.players.find((p) => p.id === id)?.name ?? "?",
            reactionMs: tap.reactionMs,
            early: tap.early,
          }))
          .sort((a, b) => {
            if (a.early !== b.early) return a.early ? 1 : -1;
            return (a.reactionMs ?? 9_999) - (b.reactionMs ?? 9_999);
          })
      : [];
    const winner = results.find((r) => !r.early && r.reactionMs != null) ?? null;
    return {
      phase: state.phase,
      round: state.round,
      totalRounds: state.totalRounds,
      serverNow: ctx.now,
      goAt: state.phase === "go" ? state.goAt : null,
      tappedCount: Object.keys(state.taps).length,
      totalPlayers: ctx.activePlayers.length,
      results,
      winnerName: winner?.name ?? null,
      scoreboard: scoreboard(state, ctx),
    };
  },

  playerView(state, playerId) {
    const tap = state.taps[playerId];
    return {
      tapped: Boolean(tap),
      early: tap?.early ?? false,
      reactionMs: tap?.reactionMs ?? null,
      score: state.scores[playerId] ?? 0,
    };
  },

  isFinished: (state) => state.phase === "results",
};

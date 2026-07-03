import { Chess, type Move as ChessJsMove } from "chess.js";
import { selectOption } from "../config.js";
import {
  GameMoveError,
  type GameContext,
  type GameModule,
  type GameMove,
  type GamePlayer,
} from "../types.js";
import { payloadField, requireOneOf, requireString } from "../validation.js";

type ChessPhase = "lobby" | "playing" | "results";
type ChessMode = "duel" | "teams";
type ChessSide = "white" | "black";
type ChessTurn = "w" | "b";
type ChessRole = "white-captain" | "black-captain" | "white-team" | "black-team" | "spectator";
type TimeControl = "infinite" | "120" | "300" | "600";
type Promotion = "q" | "r" | "b" | "n";

type ChessTeam = {
  captainId: string | null;
  playerIds: string[];
};

type ChessMoveRecord = {
  san: string;
  from: string;
  to: string;
  color: ChessTurn;
  promotion: Promotion | null;
  byPlayerId: string;
  byName: string;
  at: number;
};

type ChessResult = {
  winner: ChessSide | "draw";
  reason: "checkmate" | "stalemate" | "threefold" | "insufficient" | "draw" | "resignation" | "timeout";
  byPlayerId?: string;
  byName?: string;
};

type DrawOffer = {
  side: ChessSide;
  byPlayerId: string;
  byName: string;
};

type ChessState = {
  phase: ChessPhase;
  mode: ChessMode;
  timeControlMs: number | null;
  clocks: Record<ChessSide, number | null>;
  fen: string;
  pgn: string;
  turn: ChessTurn;
  turnStartedAt: number | null;
  teams: {
    white: ChessTeam;
    black: ChessTeam;
  };
  moves: ChessMoveRecord[];
  drawOffer: DrawOffer | null;
  result: ChessResult | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type ChessMove =
  | { type: "start" }
  | { type: "move"; from: string; to: string; promotion?: Promotion }
  | { type: "resign" }
  | { type: "offerDraw" }
  | { type: "acceptDraw" }
  | { type: "declineDraw" };

const PROMOTIONS = ["q", "r", "b", "n"] as const;
const SQUARE_RE = /^[a-h][1-8]$/;
const TIME_CONTROLS: Record<TimeControl, number | null> = {
  infinite: null,
  "120": 120_000,
  "300": 300_000,
  "600": 600_000,
};

const decodeChessMove = (move: GameMove): ChessMove => {
  switch (move.type) {
    case "start":
    case "resign":
    case "offerDraw":
    case "acceptDraw":
    case "declineDraw":
      return { type: move.type };
    case "move": {
      const from = requireString(payloadField(move.payload, "from"), "Invalid source square").toLowerCase();
      const to = requireString(payloadField(move.payload, "to"), "Invalid target square").toLowerCase();
      if (!SQUARE_RE.test(from) || !SQUARE_RE.test(to)) {
        throw new GameMoveError("Invalid square");
      }
      const rawPromotion = payloadField(move.payload, "promotion");
      const promotion =
        rawPromotion == null || rawPromotion === ""
          ? undefined
          : requireOneOf(rawPromotion, PROMOTIONS, "Invalid promotion");
      return { type: "move", from, to, promotion };
    }
    default:
      throw new GameMoveError(`Unknown move: ${move.type}`);
  }
};

const sideForTurn = (turn: ChessTurn): ChessSide => (turn === "w" ? "white" : "black");
const otherSide = (side: ChessSide): ChessSide => (side === "white" ? "black" : "white");

const playerName = (ctx: GameContext, playerId: string): string =>
  ctx.players.find((player) => player.id === playerId)?.name ?? playerId;

const sideForPlayer = (state: ChessState, playerId: string): ChessSide | null => {
  if (state.teams.white.playerIds.includes(playerId)) return "white";
  if (state.teams.black.playerIds.includes(playerId)) return "black";
  return null;
};

const roleForPlayer = (state: ChessState, playerId: string): ChessRole => {
  if (state.teams.white.captainId === playerId) return "white-captain";
  if (state.teams.black.captainId === playerId) return "black-captain";
  if (state.teams.white.playerIds.includes(playerId)) return "white-team";
  if (state.teams.black.playerIds.includes(playerId)) return "black-team";
  return "spectator";
};

const requireCaptain = (state: ChessState, playerId: string, side: ChessSide): void => {
  const captainId = state.teams[side].captainId;
  if (captainId !== playerId) {
    throw new GameMoveError(`Only the ${side} captain can move`);
  }
};

const seatedTeams = (ctx: GameContext, mode: ChessMode) => {
  const shuffled = ctx.rng.shuffle(ctx.activePlayers);
  if (shuffled.length < 2) throw new GameMoveError("Chess needs at least 2 players");

  if (mode === "duel") {
    const [white, black] = shuffled;
    return {
      white: { captainId: white.id, playerIds: [white.id] },
      black: { captainId: black.id, playerIds: [black.id] },
    };
  }

  const whitePlayers: GamePlayer[] = [];
  const blackPlayers: GamePlayer[] = [];
  shuffled.forEach((player, index) => {
    if (index % 2 === 0) whitePlayers.push(player);
    else blackPlayers.push(player);
  });

  return {
    white: { captainId: whitePlayers[0]?.id ?? null, playerIds: whitePlayers.map((player) => player.id) },
    black: { captainId: blackPlayers[0]?.id ?? null, playerIds: blackPlayers.map((player) => player.id) },
  };
};

const legalMoves = (game: Chess): Record<string, string[]> => {
  const bySquare: Record<string, string[]> = {};
  for (const move of game.moves({ verbose: true }) as ChessJsMove[]) {
    bySquare[move.from] = [...(bySquare[move.from] ?? []), move.to];
  }
  return bySquare;
};

const resultForGame = (game: Chess): ChessResult | null => {
  if (!game.isGameOver()) return null;
  if (game.isCheckmate()) {
    const losingSide = sideForTurn(game.turn());
    return { winner: otherSide(losingSide), reason: "checkmate" };
  }
  if (game.isStalemate()) return { winner: "draw", reason: "stalemate" };
  if (game.isThreefoldRepetition()) return { winner: "draw", reason: "threefold" };
  if (game.isInsufficientMaterial()) return { winner: "draw", reason: "insufficient" };
  return { winner: "draw", reason: "draw" };
};

const teamView = (team: ChessTeam, ctx: GameContext) =>
  team.playerIds.map((id) => ({
    id,
    name: playerName(ctx, id),
    captain: id === team.captainId,
  }));

const resolveClocks = (state: ChessState, now: number): Record<ChessSide, number | null> => {
  if (state.timeControlMs == null || state.phase !== "playing" || state.turnStartedAt == null) {
    return { ...state.clocks };
  }
  const side = sideForTurn(state.turn);
  const elapsed = Math.max(0, now - state.turnStartedAt);
  return {
    ...state.clocks,
    [side]: Math.max(0, (state.clocks[side] ?? state.timeControlMs) - elapsed),
  };
};

const timeoutResult = (timedOutSide: ChessSide): ChessResult => ({
  winner: otherSide(timedOutSide),
  reason: "timeout",
});

const timeoutState = (state: ChessState, ctx: GameContext): ChessState | null => {
  if (state.phase !== "playing" || state.timeControlMs == null) return null;
  const side = sideForTurn(state.turn);
  const clocks = resolveClocks(state, ctx.now);
  if ((clocks[side] ?? 0) > 0) return null;
  return {
    ...state,
    phase: "results",
    clocks,
    result: timeoutResult(side),
    finishedAt: ctx.now,
  };
};

export const chessModule: GameModule<ChessState> = {
  id: "chess",
  name: "Chess",
  description: "Live chess for two players or two captain-led teams",
  minPlayers: 2,
  maxPlayers: 32,
  spectatable: true,
  tickMs: 500,
  options: [
    {
      id: "mode",
      type: "select",
      label: "Mode",
      default: "duel",
      choices: [
        { value: "duel", label: "Duel" },
        { value: "teams", label: "Team chess" },
      ],
    },
    {
      id: "timeControl",
      type: "select",
      label: "Timer",
      default: "infinite",
      choices: [
        { value: "120", label: "2 min" },
        { value: "300", label: "5 min" },
        { value: "600", label: "10 min" },
        { value: "infinite", label: "Infinite" },
      ],
    },
  ],

  setup(ctx): ChessState {
    const game = new Chess();
    const mode = selectOption(ctx.config, "mode", "duel") === "teams" ? "teams" : "duel";
    const timeControl = selectOption(ctx.config, "timeControl", "infinite") as TimeControl;
    const timeControlMs = TIME_CONTROLS[timeControl] ?? null;
    return {
      phase: "lobby",
      mode,
      timeControlMs,
      clocks: { white: timeControlMs, black: timeControlMs },
      fen: game.fen(),
      pgn: game.pgn(),
      turn: game.turn(),
      turnStartedAt: null,
      teams: {
        white: { captainId: null, playerIds: [] },
        black: { captainId: null, playerIds: [] },
      },
      moves: [],
      drawOffer: null,
      result: null,
      startedAt: null,
      finishedAt: null,
    };
  },

  onMove(state, move, ctx): ChessState {
    const m = decodeChessMove(move);
    switch (m.type) {
      case "start": {
        if (!ctx.isAdmin(move.playerId)) throw new GameMoveError("Only the host can start");
        if (state.phase !== "lobby") throw new GameMoveError("Already running");
        const teams = seatedTeams(ctx, state.mode);
        return { ...state, phase: "playing", teams, startedAt: ctx.now, turnStartedAt: ctx.now };
      }
      case "move": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        const side = sideForTurn(state.turn);
        requireCaptain(state, move.playerId, side);

        const game = new Chess(state.fen);
        let played: ChessJsMove | null = null;
        try {
          played = game.move({ from: m.from, to: m.to, promotion: m.promotion ?? "q" });
        } catch {
          played = null;
        }
        if (!played) throw new GameMoveError("Illegal move");

        const result = resultForGame(game);
        const clocks = resolveClocks(state, ctx.now);
        return {
          ...state,
          phase: result ? "results" : "playing",
          clocks,
          fen: game.fen(),
          pgn: game.pgn(),
          turn: game.turn(),
          turnStartedAt: result ? null : ctx.now,
          drawOffer: null,
          result,
          finishedAt: result ? ctx.now : null,
          moves: [
            ...state.moves,
            {
              san: played.san,
              from: played.from,
              to: played.to,
              color: played.color,
              promotion: (played.promotion as Promotion | undefined) ?? null,
              byPlayerId: move.playerId,
              byName: playerName(ctx, move.playerId),
              at: ctx.now,
            },
          ],
        };
      }
      case "resign": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        const side = sideForPlayer(state, move.playerId);
        if (!side) throw new GameMoveError("You are not on a side");
        requireCaptain(state, move.playerId, side);
        return {
          ...state,
          phase: "results",
          clocks: resolveClocks(state, ctx.now),
          drawOffer: null,
          result: {
            winner: otherSide(side),
            reason: "resignation",
            byPlayerId: move.playerId,
            byName: playerName(ctx, move.playerId),
          },
          finishedAt: ctx.now,
        };
      }
      case "offerDraw": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        const side = sideForPlayer(state, move.playerId);
        if (!side) throw new GameMoveError("You are not on a side");
        requireCaptain(state, move.playerId, side);
        return {
          ...state,
          drawOffer: { side, byPlayerId: move.playerId, byName: playerName(ctx, move.playerId) },
        };
      }
      case "acceptDraw": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        if (!state.drawOffer) throw new GameMoveError("No draw offer to accept");
        const side = sideForPlayer(state, move.playerId);
        if (!side || side === state.drawOffer.side) {
          throw new GameMoveError("Only the opposing captain can accept");
        }
        requireCaptain(state, move.playerId, side);
        return {
          ...state,
          phase: "results",
          clocks: resolveClocks(state, ctx.now),
          drawOffer: null,
          result: { winner: "draw", reason: "draw", byPlayerId: move.playerId, byName: playerName(ctx, move.playerId) },
          finishedAt: ctx.now,
        };
      }
      case "declineDraw": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        if (!state.drawOffer) return state;
        const side = sideForPlayer(state, move.playerId);
        if (!side || side === state.drawOffer.side) {
          throw new GameMoveError("Only the opposing captain can decline");
        }
        requireCaptain(state, move.playerId, side);
        return { ...state, drawOffer: null };
      }
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): ChessState {
    return timeoutState(state, ctx) ?? state;
  },

  getPhase: (state) => state.phase,

  publicView(state, ctx) {
    const game = new Chess(state.fen);
    const clocks = resolveClocks(state, ctx.now);
    return {
      phase: state.phase,
      mode: state.mode,
      serverNow: ctx.now,
      timeControlMs: state.timeControlMs,
      clocks,
      fen: state.fen,
      pgn: state.pgn,
      turn: state.turn,
      turnSide: sideForTurn(state.turn),
      inCheck: game.inCheck(),
      legalMoves: state.phase === "playing" ? legalMoves(game) : {},
      teams: {
        white: teamView(state.teams.white, ctx),
        black: teamView(state.teams.black, ctx),
      },
      captains: {
        white: state.teams.white.captainId,
        black: state.teams.black.captainId,
      },
      moves: state.moves,
      drawOffer: state.drawOffer,
      result: state.result,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
    };
  },

  playerView(state, playerId) {
    const side = sideForPlayer(state, playerId);
    const role = roleForPlayer(state, playerId);
    const turnSide = sideForTurn(state.turn);
    const canMove =
      state.phase === "playing" &&
      side === turnSide &&
      state.teams[turnSide].captainId === playerId;
    const canRespondToDraw =
      state.phase === "playing" &&
      state.drawOffer != null &&
      side != null &&
      side !== state.drawOffer.side &&
      state.teams[side].captainId === playerId;
    return {
      side,
      role,
      canMove,
      canResign: state.phase === "playing" && side != null && state.teams[side].captainId === playerId,
      canOfferDraw: state.phase === "playing" && side != null && state.teams[side].captainId === playerId,
      canRespondToDraw,
    };
  },

  isFinished: (state) => state.phase === "results",
};

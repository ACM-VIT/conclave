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
import { pickBotMove, type BotLevel } from "./chessBot.js";

type ChessPhase = "lobby" | "playing" | "results";
type ChessMode = "duel" | "teams" | "computer";
type ChessSide = "white" | "black";
type ChessTurn = "w" | "b";
type ChessRole = "white-captain" | "black-captain" | "white-team" | "black-team" | "spectator";
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
  /** True when the move was played by the server (rapid-fire expiry). */
  auto: boolean;
  at: number;
};

type ChessResultReason =
  | "checkmate"
  | "stalemate"
  | "threefold"
  | "insufficient"
  | "fifty-move"
  | "agreement"
  | "resignation"
  | "timeout";

type ChessResult = {
  winner: ChessSide | "draw";
  reason: ChessResultReason;
  byPlayerId?: string;
  byName?: string;
};

type SideOffer = {
  side: ChessSide;
  byPlayerId: string;
  byName: string;
};

type ChessState = {
  phase: ChessPhase;
  mode: ChessMode;
  timeControlMs: number | null;
  incrementMs: number;
  /** Rapid fire: hard per-move cap; expiry plays a random legal move. */
  moveTimeMs: number | null;
  allowTakebacks: boolean;
  botSide: ChessSide | null;
  botLevel: BotLevel;
  /** Server time after which the bot answers (small human-feeling delay). */
  botMoveDueAt: number | null;
  clocks: Record<ChessSide, number | null>;
  fen: string;
  /** Position after every ply, starting position first (for takebacks). */
  fens: string[];
  pgn: string;
  turn: ChessTurn;
  turnStartedAt: number | null;
  teams: {
    white: ChessTeam;
    black: ChessTeam;
  };
  moves: ChessMoveRecord[];
  drawOffer: SideOffer | null;
  takebackRequest: SideOffer | null;
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
  | { type: "declineDraw" }
  | { type: "requestTakeback" }
  | { type: "acceptTakeback" }
  | { type: "declineTakeback" };

export const CHESS_BOT_ID = "@chess-bot";

const PROMOTIONS = ["q", "r", "b", "n"] as const;
const SQUARE_RE = /^[a-h][1-8]$/;

/** "base+increment" in seconds, or "unlimited". */
const TIME_CONTROL_RE = /^(\d+)\+(\d+)$/;

const BOT_NAMES: Record<BotLevel, string> = {
  easy: "Computer (easy)",
  medium: "Computer (medium)",
  hard: "Computer (hard)",
};

const decodeChessMove = (move: GameMove): ChessMove => {
  switch (move.type) {
    case "start":
    case "resign":
    case "offerDraw":
    case "acceptDraw":
    case "declineDraw":
    case "requestTakeback":
    case "acceptTakeback":
    case "declineTakeback":
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
const turnForSide = (side: ChessSide): ChessTurn => (side === "white" ? "w" : "b");

const playerName = (ctx: GameContext, playerId: string): string => {
  if (playerId === CHESS_BOT_ID) return "Computer";
  return ctx.players.find((player) => player.id === playerId)?.name ?? playerId;
};

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
    throw new GameMoveError(`Only the ${side} captain can do that`);
  }
};

const seatedTeams = (
  ctx: GameContext,
  state: ChessState,
  starterId: string,
): { white: ChessTeam; black: ChessTeam; botSide: ChessSide | null } => {
  const shuffled = ctx.rng.shuffle(ctx.activePlayers);

  if (state.mode === "computer") {
    if (shuffled.length < 1) throw new GameMoveError("Chess needs at least 1 player");
    const humanSide = state.botSide ? otherSide(state.botSide) : "white";
    // The starter leads the human side; everyone else in the room joins their
    // team and can talk strategy while the captain moves the pieces.
    const starter = shuffled.find((player) => player.id === starterId);
    const humanIds = [
      ...(starter ? [starter.id] : []),
      ...shuffled.filter((player) => player.id !== starterId).map((player) => player.id),
    ];
    const humans: ChessTeam = { captainId: humanIds[0] ?? null, playerIds: humanIds };
    const bot: ChessTeam = { captainId: CHESS_BOT_ID, playerIds: [CHESS_BOT_ID] };
    return humanSide === "white"
      ? { white: humans, black: bot, botSide: "black" }
      : { white: bot, black: humans, botSide: "white" };
  }

  if (shuffled.length < 2) throw new GameMoveError("Chess needs at least 2 players");

  if (state.mode === "duel") {
    const [white, black] = shuffled;
    return {
      white: { captainId: white.id, playerIds: [white.id] },
      black: { captainId: black.id, playerIds: [black.id] },
      botSide: null,
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
    botSide: null,
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
  // chess.js's only remaining game-over condition is the fifty-move rule.
  return { winner: "draw", reason: "fifty-move" };
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

/**
 * Whether `side` can still deliver mate in some line. Lone king, or king with
 * a single minor piece, cannot - a flag fall against them scores a draw
 * instead of a loss (the standard online timeout rule).
 */
const hasMatingMaterial = (game: Chess, side: ChessTurn): boolean => {
  let minors = 0;
  for (const row of game.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== side) continue;
      if (piece.type === "p" || piece.type === "r" || piece.type === "q") return true;
      if (piece.type === "n" || piece.type === "b") minors += 1;
    }
  }
  return minors >= 2;
};

const timeoutState = (state: ChessState, ctx: GameContext): ChessState | null => {
  if (state.phase !== "playing" || state.timeControlMs == null) return null;
  const side = sideForTurn(state.turn);
  const clocks = resolveClocks(state, ctx.now);
  if ((clocks[side] ?? 0) > 0) return null;
  const game = new Chess(state.fen);
  const winner = hasMatingMaterial(game, turnForSide(otherSide(side))) ? otherSide(side) : "draw";
  return {
    ...state,
    phase: "results",
    clocks,
    drawOffer: null,
    takebackRequest: null,
    botMoveDueAt: null,
    result: { winner, reason: "timeout" },
    finishedAt: ctx.now,
  };
};

/** Small human-feeling pause before the bot answers. */
const botThinkDelayMs = (state: ChessState, ctx: GameContext): number => {
  let delay = 500 + Math.round(ctx.rng.next() * 700);
  if (state.moveTimeMs != null) delay = Math.min(delay, Math.round(state.moveTimeMs / 2));
  if (state.botSide) {
    const remaining = state.clocks[state.botSide];
    if (remaining != null && remaining < 15_000) delay = Math.min(delay, 200);
  }
  return delay;
};

/** Queue (or clear) the bot's reply after the position changed. */
const scheduleBot = (state: ChessState, ctx: GameContext): ChessState => {
  if (state.mode !== "computer" || state.phase !== "playing" || state.botSide == null) {
    return state;
  }
  if (sideForTurn(state.turn) !== state.botSide) {
    return state.botMoveDueAt == null ? state : { ...state, botMoveDueAt: null };
  }
  if (state.botMoveDueAt != null) return state;
  return { ...state, botMoveDueAt: ctx.now + botThinkDelayMs(state, ctx) };
};

type BoardMoveInput = {
  from: string;
  to: string;
  promotion?: Promotion;
};

type Mover = {
  id: string;
  name: string;
  auto: boolean;
};

/** Apply one board move (human, bot, or rapid-fire auto) to the position. */
const applyBoardMove = (
  state: ChessState,
  ctx: GameContext,
  input: BoardMoveInput,
  mover: Mover,
): ChessState => {
  const game = new Chess(state.fen);
  let played: ChessJsMove | null = null;
  try {
    played = game.move({ from: input.from, to: input.to, promotion: input.promotion ?? "q" });
  } catch {
    played = null;
  }
  if (!played) throw new GameMoveError("Illegal move");

  const result = resultForGame(game);
  const moverSide = sideForTurn(state.turn);
  const clocks = resolveClocks(state, ctx.now);
  if (state.timeControlMs != null && clocks[moverSide] != null && !result) {
    clocks[moverSide] = (clocks[moverSide] as number) + state.incrementMs;
  }
  const fen = game.fen();
  const next: ChessState = {
    ...state,
    phase: result ? "results" : "playing",
    clocks,
    fen,
    fens: [...state.fens, fen],
    pgn: game.pgn(),
    turn: game.turn(),
    turnStartedAt: result ? null : ctx.now,
    drawOffer: null,
    takebackRequest: null,
    botMoveDueAt: null,
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
        byPlayerId: mover.id,
        byName: mover.name,
        auto: mover.auto,
        at: ctx.now,
      },
    ],
  };
  return scheduleBot(next, ctx);
};

const rebuildPgn = (moves: ChessMoveRecord[]): string => {
  const game = new Chess();
  for (const move of moves) game.move(move.san);
  return game.pgn();
};

/**
 * Rewind so the requesting side is to move again, before their last move:
 * one ply when they just moved, two when the opponent already replied.
 */
const applyTakeback = (state: ChessState, ctx: GameContext, side: ChessSide): ChessState => {
  const plies = sideForTurn(state.turn) === side ? 2 : 1;
  if (state.moves.length < plies) throw new GameMoveError("Nothing to take back");
  const fens = state.fens.slice(0, state.fens.length - plies);
  const fen = fens[fens.length - 1];
  const moves = state.moves.slice(0, state.moves.length - plies);
  const game = new Chess(fen);
  return {
    ...state,
    fen,
    fens,
    moves,
    pgn: rebuildPgn(moves),
    turn: game.turn(),
    turnStartedAt: ctx.now,
    clocks: resolveClocks(state, ctx.now),
    drawOffer: null,
    takebackRequest: null,
    botMoveDueAt: null,
  };
};

const sideHasMoved = (state: ChessState, side: ChessSide): boolean =>
  state.moves.some((move) => move.color === turnForSide(side));

const canRequestTakeback = (state: ChessState, playerId: string): boolean => {
  if (state.phase !== "playing" || !state.allowTakebacks || state.takebackRequest) return false;
  const side = sideForPlayer(state, playerId);
  if (!side || state.teams[side].captainId !== playerId) return false;
  return sideHasMoved(state, side);
};

export const chessModule: GameModule<ChessState> = {
  id: "chess",
  name: "Chess",
  description: "Duel a friend, split into teams, or take on the computer",
  minPlayers: 1,
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
        { value: "teams", label: "Teams" },
        { value: "computer", label: "vs Computer" },
      ],
    },
    {
      id: "timeControl",
      type: "select",
      label: "Time control",
      default: "600+0",
      choices: [
        { value: "60+0", label: "1 min" },
        { value: "120+1", label: "2 | 1" },
        { value: "180+0", label: "3 min" },
        { value: "180+2", label: "3 | 2" },
        { value: "300+0", label: "5 min" },
        { value: "300+3", label: "5 | 3" },
        { value: "600+0", label: "10 min" },
        { value: "600+5", label: "10 | 5" },
        { value: "900+10", label: "15 | 10" },
        { value: "1800+0", label: "30 min" },
        { value: "unlimited", label: "No clock" },
      ],
    },
    {
      id: "rapidFire",
      type: "select",
      label: "Rapid fire (auto-move when the per-move timer runs out)",
      default: "off",
      choices: [
        { value: "off", label: "Off" },
        { value: "10", label: "10s / move" },
        { value: "20", label: "20s / move" },
        { value: "30", label: "30s / move" },
      ],
    },
    {
      id: "takebacks",
      type: "select",
      label: "Takebacks",
      default: "on",
      choices: [
        { value: "on", label: "Allowed" },
        { value: "off", label: "Off" },
      ],
    },
    {
      id: "side",
      type: "select",
      label: "Play as",
      default: "random",
      showWhen: { id: "mode", equals: ["computer"] },
      choices: [
        { value: "random", label: "Random" },
        { value: "white", label: "White" },
        { value: "black", label: "Black" },
      ],
    },
    {
      id: "difficulty",
      type: "select",
      label: "Computer level",
      default: "medium",
      showWhen: { id: "mode", equals: ["computer"] },
      choices: [
        { value: "easy", label: "Easy" },
        { value: "medium", label: "Medium" },
        { value: "hard", label: "Hard" },
      ],
    },
  ],

  setup(ctx): ChessState {
    const game = new Chess();
    const rawMode = selectOption(ctx.config, "mode", "duel");
    const mode: ChessMode = rawMode === "teams" || rawMode === "computer" ? rawMode : "duel";

    const timeControl = selectOption(ctx.config, "timeControl", "600+0");
    const parsed = TIME_CONTROL_RE.exec(timeControl);
    const timeControlMs = parsed ? Number(parsed[1]) * 1000 : null;
    const incrementMs = parsed ? Number(parsed[2]) * 1000 : 0;

    const rapidFire = selectOption(ctx.config, "rapidFire", "off");
    const moveTimeMs = rapidFire === "off" ? null : Number(rapidFire) * 1000;

    const rawLevel = selectOption(ctx.config, "difficulty", "medium");
    const botLevel: BotLevel = rawLevel === "easy" || rawLevel === "hard" ? rawLevel : "medium";

    let botSide: ChessSide | null = null;
    if (mode === "computer") {
      const sidePick = selectOption(ctx.config, "side", "random");
      const humanSide: ChessSide =
        sidePick === "white" || sidePick === "black"
          ? sidePick
          : ctx.rng.next() < 0.5
            ? "white"
            : "black";
      botSide = otherSide(humanSide);
    }

    const fen = game.fen();
    return {
      phase: "lobby",
      mode,
      timeControlMs,
      incrementMs,
      moveTimeMs,
      allowTakebacks: selectOption(ctx.config, "takebacks", "on") !== "off",
      botSide,
      botLevel,
      botMoveDueAt: null,
      clocks: { white: timeControlMs, black: timeControlMs },
      fen,
      fens: [fen],
      pgn: game.pgn(),
      turn: game.turn(),
      turnStartedAt: null,
      teams: {
        white: { captainId: null, playerIds: [] },
        black: { captainId: null, playerIds: [] },
      },
      moves: [],
      drawOffer: null,
      takebackRequest: null,
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
        const seats = seatedTeams(ctx, state, move.playerId);
        const started: ChessState = {
          ...state,
          phase: "playing",
          teams: { white: seats.white, black: seats.black },
          botSide: seats.botSide,
          startedAt: ctx.now,
          turnStartedAt: ctx.now,
        };
        return scheduleBot(started, ctx);
      }
      case "move": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        const side = sideForTurn(state.turn);
        requireCaptain(state, move.playerId, side);
        return applyBoardMove(state, ctx, m, {
          id: move.playerId,
          name: playerName(ctx, move.playerId),
          auto: false,
        });
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
          takebackRequest: null,
          botMoveDueAt: null,
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
        if (state.mode === "computer") throw new GameMoveError("The computer prefers to play on");
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
          takebackRequest: null,
          botMoveDueAt: null,
          result: { winner: "draw", reason: "agreement", byPlayerId: move.playerId, byName: playerName(ctx, move.playerId) },
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
      case "requestTakeback": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        if (!state.allowTakebacks) throw new GameMoveError("Takebacks are off for this game");
        const side = sideForPlayer(state, move.playerId);
        if (!side) throw new GameMoveError("You are not on a side");
        requireCaptain(state, move.playerId, side);
        if (!sideHasMoved(state, side)) throw new GameMoveError("You have not moved yet");
        if (state.takebackRequest) throw new GameMoveError("A takeback is already pending");
        // The computer is a good sport: takebacks against it apply instantly.
        if (state.mode === "computer") {
          return scheduleBot(applyTakeback(state, ctx, side), ctx);
        }
        return {
          ...state,
          takebackRequest: { side, byPlayerId: move.playerId, byName: playerName(ctx, move.playerId) },
        };
      }
      case "acceptTakeback": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        if (!state.takebackRequest) throw new GameMoveError("No takeback to accept");
        const side = sideForPlayer(state, move.playerId);
        if (!side || side === state.takebackRequest.side) {
          throw new GameMoveError("Only the opposing captain can accept");
        }
        requireCaptain(state, move.playerId, side);
        return applyTakeback(state, ctx, state.takebackRequest.side);
      }
      case "declineTakeback": {
        if (state.phase !== "playing") throw new GameMoveError("Game is not running");
        const timedOut = timeoutState(state, ctx);
        if (timedOut) return timedOut;
        if (!state.takebackRequest) return state;
        const side = sideForPlayer(state, move.playerId);
        if (!side || side === state.takebackRequest.side) {
          throw new GameMoveError("Only the opposing captain can decline");
        }
        requireCaptain(state, move.playerId, side);
        return { ...state, takebackRequest: null };
      }
      default: {
        const _exhaustive: never = m;
        throw new GameMoveError(`Unknown move: ${(_exhaustive as GameMove).type}`);
      }
    }
  },

  onTick(state, ctx): ChessState {
    if (state.phase !== "playing") return state;

    const timedOut = timeoutState(state, ctx);
    if (timedOut) return timedOut;

    const turnSide = sideForTurn(state.turn);

    // Bot reply, after its scheduled "thinking" delay.
    if (state.mode === "computer" && state.botSide === turnSide) {
      if (state.botMoveDueAt == null) return scheduleBot(state, ctx);
      if (ctx.now < state.botMoveDueAt) return state;
      const botMove = pickBotMove(state.fen, state.botLevel, ctx.rng, state.fens);
      if (!botMove) return state;
      return applyBoardMove(state, ctx, botMove, {
        id: CHESS_BOT_ID,
        name: playerName(ctx, CHESS_BOT_ID),
        auto: false,
      });
    }

    // Rapid fire: the per-move timer expired, play a random legal move.
    if (
      state.moveTimeMs != null &&
      state.turnStartedAt != null &&
      ctx.now >= state.turnStartedAt + state.moveTimeMs
    ) {
      const game = new Chess(state.fen);
      const legal = game.moves({ verbose: true }) as ChessJsMove[];
      if (legal.length === 0) return state;
      const chosen = ctx.rng.pick(legal);
      const captainId = state.teams[turnSide].captainId;
      return applyBoardMove(
        state,
        ctx,
        { from: chosen.from, to: chosen.to, promotion: chosen.promotion as Promotion | undefined },
        {
          id: captainId ?? "@auto",
          name: captainId ? playerName(ctx, captainId) : "Auto",
          auto: true,
        },
      );
    }

    return state;
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
      incrementMs: state.incrementMs,
      moveTimeMs: state.moveTimeMs,
      allowTakebacks: state.allowTakebacks,
      bot: state.botSide ? { side: state.botSide, level: state.botLevel, name: BOT_NAMES[state.botLevel] } : null,
      clocks,
      fen: state.fen,
      pgn: state.pgn,
      turn: state.turn,
      turnSide: sideForTurn(state.turn),
      turnStartedAt: state.turnStartedAt,
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
      takebackRequest: state.takebackRequest,
      result: state.result,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
    };
  },

  playerView(state, playerId) {
    const side = sideForPlayer(state, playerId);
    const role = roleForPlayer(state, playerId);
    const turnSide = sideForTurn(state.turn);
    const isCaptain = side != null && state.teams[side].captainId === playerId;
    const canMove = state.phase === "playing" && side === turnSide && isCaptain;
    const canRespondToDraw =
      state.phase === "playing" &&
      state.drawOffer != null &&
      side != null &&
      side !== state.drawOffer.side &&
      isCaptain;
    const canRespondToTakeback =
      state.phase === "playing" &&
      state.takebackRequest != null &&
      side != null &&
      side !== state.takebackRequest.side &&
      isCaptain;
    return {
      side,
      role,
      canMove,
      canResign: state.phase === "playing" && isCaptain,
      canOfferDraw: state.phase === "playing" && isCaptain && state.mode !== "computer",
      canRespondToDraw,
      canRequestTakeback: canRequestTakeback(state, playerId),
      canRespondToTakeback,
    };
  },

  isFinished: (state) => state.phase === "results",
};

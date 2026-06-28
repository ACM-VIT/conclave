/**
 * Server-authoritative game runtime types.
 *
 * Unlike the collaborative apps runtime (where the SFU is a dumb Yjs relay and
 * every client converges on identical, fully-visible state), the game runtime
 * keeps canonical state ONLY on the server. Each client receives a projection:
 *
 *   - `publicView`  -> broadcast to the whole room (what everyone may see)
 *   - `playerView`  -> emitted privately to a single player (hidden information)
 *
 * Moves are validated server-side. A module rejects an illegal move by throwing
 * `GameMoveError`. Randomness comes from a seeded server RNG so shuffles/deals
 * cannot be predicted or replayed by clients.
 */

export type GamePlayer = {
  id: string;
  name: string;
};

/** Deterministic, server-seeded RNG handed to game modules. */
export type GameRng = {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Returns a new shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[];
  /** Picks one element. Throws on empty input. */
  pick<T>(items: readonly T[]): T;
};

/** Host-configurable option specs, declared by a module and rendered by the UI. */
export type GameOptionSpec =
  | {
      id: string;
      type: "number";
      label: string;
      min: number;
      max: number;
      default: number;
      /** Quick presets surfaced as a segmented control. */
      presets?: number[];
      suffix?: string;
    }
  | {
      id: string;
      type: "select";
      label: string;
      default: string;
      choices: { value: string; label: string }[];
    }
  | {
      id: string;
      type: "text";
      label: string;
      default: string;
      placeholder?: string;
      maxLength?: number;
    };

/** Resolved, validated config values keyed by option id. */
export type GameConfig = Record<string, number | string>;

export type GameContext = {
  players: GamePlayer[];
  rng: GameRng;
  /** Host-chosen configuration (validated, with defaults filled in). */
  config: GameConfig;
  /** Optional generated content loaded before the session starts. */
  content: unknown | null;
  /** Server clock (ms epoch) captured at the start of the operation. */
  now: number;
  isAdmin(playerId: string): boolean;
};

export type GameContentContext = {
  players: GamePlayer[];
  /** Host-chosen configuration (validated, with defaults filled in). */
  config: GameConfig;
  /** Server clock (ms epoch) captured before content loading starts. */
  now: number;
};

export type GameMove = {
  playerId: string;
  type: string;
  payload: unknown;
};

/**
 * A game module is the authoritative definition of one game. It is pure with
 * respect to its own state: every method takes the current state and returns
 * the next one (or a projection). No socket or IO concerns leak in here.
 */
export type GameModule<S = unknown> = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  /** When set, the engine calls `onTick` on this cadence for timers/deadlines. */
  tickMs?: number;
  /** Host-configurable options shown before the game starts. */
  options?: GameOptionSpec[];
  /** When true, the dock shows a live leaderboard (the publicView must expose a
   *  `scoreboard` array of `{ id, name, score }`). */
  hasLeaderboard?: boolean;

  /** Optional async content loader, used before setup for AI-backed prompts. */
  generateContent?(ctx: GameContentContext): Promise<unknown | null>;
  setup(ctx: GameContext): S;
  /** Apply a validated move. Throw `GameMoveError` to reject it. */
  onMove(state: S, move: GameMove, ctx: GameContext): S;
  /** Optional time-driven progression (phase deadlines, countdowns). */
  onTick?(state: S, ctx: GameContext): S;

  /** Coarse lifecycle label surfaced to the host UI (e.g. "lobby", "question"). */
  getPhase(state: S): string;
  publicView(state: S, ctx: GameContext): unknown;
  playerView(state: S, playerId: string, ctx: GameContext): unknown;
  isFinished?(state: S): boolean;
};

/** Thrown by a module's `onMove` to reject an illegal move with a reason. */
export class GameMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameMoveError";
  }
}

export type GameCatalogEntry = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  options: GameOptionSpec[];
  hasLeaderboard: boolean;
};

/* ---- Wire payloads (socket contract) ---- */

export type GameStartData = {
  gameId?: unknown;
  options?: unknown;
};

export type GameStartResponse = {
  success: boolean;
  gameId?: string;
  error?: string;
};

export type GameMoveData = {
  gameId?: unknown;
  type?: unknown;
  payload?: unknown;
};

export type GameMoveResponse = {
  success: boolean;
  error?: string;
};

export type GameEndResponse = {
  success: boolean;
  error?: string;
};

/** Broadcast to the whole room on every state change. */
export type GamePublicState = {
  gameId: string;
  name: string;
  phase: string;
  players: GamePlayer[];
  hostId: string | null;
  view: unknown;
  finished: boolean;
  hasLeaderboard: boolean;
};

/** Emitted privately to a single player. */
export type GamePlayerView = {
  gameId: string;
  view: unknown;
};

export type GameStateResponse = {
  active: boolean;
  public?: GamePublicState;
  view?: unknown;
  vote?: GameVoteState | null;
};

/* ---- Game vote (host puts game choice to the room) ---- */

export type GameVoteState = {
  candidates: GameCatalogEntry[];
  tally: Record<string, number>;
  votes: Record<string, string>;
  totalPlayers: number;
};

export type GameVoteOpenData = { candidates?: unknown };
export type GameVoteCastData = { gameId?: unknown };
export type GameVoteResponse = { success: boolean; error?: string };

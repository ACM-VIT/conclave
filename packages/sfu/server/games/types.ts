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

/**
 * Show this option only while another select option holds one of the given
 * values (e.g. chess's "Computer level" only when mode is "computer").
 * Clients that predate the field simply always show the option.
 */
type GameOptionCondition = {
  id: string;
  equals: string[];
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
      showWhen?: GameOptionCondition;
    }
  | {
      id: string;
      type: "select";
      label: string;
      default: string;
      choices: { value: string; label: string }[];
      showWhen?: GameOptionCondition;
    }
  | {
      id: string;
      type: "text";
      label: string;
      default: string;
      placeholder?: string;
      maxLength?: number;
      showWhen?: GameOptionCondition;
    };

/** Resolved, validated config values keyed by option id. */
export type GameConfig = Record<string, number | string>;

export type GameContext = {
  /** Game seats captured when the session starts. */
  players: GamePlayer[];
  /** Currently connected non-observer players that still hold a game seat. */
  activePlayers: GamePlayer[];
  rng: GameRng;
  /** Host-chosen configuration (validated, with defaults filled in). */
  config: GameConfig;
  /** Optional generated content loaded before the session starts. */
  content: unknown | null;
  /** Server clock (ms epoch) captured at the start of the operation. */
  now: number;
  isAdmin(playerId: string): boolean;
};

type GameContentContext = {
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

type LateJoinPhasesResolver<S> = {
  bivarianceHack(state: S, ctx: GameContext): string[];
}["bivarianceHack"];

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
  /**
   * Phases whose ENTRY is a safe round boundary for seating queued late
   * joiners (e.g. trivia's "question"). Omit, leave empty, or return an empty
   * list when mid-game joining does not fit the current state/config.
   */
  lateJoinPhases?: string[] | LateJoinPhasesResolver<S>;
  /**
   * Whether non-players may receive this game's `playerView` as a read-only
   * spectator projection. Defaults to true; set false when the view for an
   * arbitrary id would leak a secret (imposter's crew view reveals the word).
   */
  spectatable?: boolean;

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

export type GameJoinResponse = {
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
  /** Room members queued to be seated at the next round boundary. */
  pendingJoiners: GamePlayer[];
  /** Whether a spectator can currently request a seat for the next round. */
  canJoinLate: boolean;
  /** Public-safe rematch settings. Text options are omitted. */
  config: GameConfig;
};

export type GameStateResponse = {
  active: boolean;
  public?: GamePublicState;
  view?: unknown;
  vote?: GameVoteState | null;
  /**
   * The caller's canonical player id, as the server knows it. Clients must use
   * this (never a locally rebuilt identity) to find themselves in `players`,
   * scoreboards, and tile state, since the server may normalize or reassign
   * parts of the identity (lowercased email, token session id).
   */
  selfId?: string;
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

/**
 * Client-side mirror of the SFU game wire contract. The server is authoritative;
 * the client only ever holds projections it was sent. View payloads are typed
 * per game in the renderer that consumes them — here they stay `unknown`.
 */

export type GamePlayer = {
  id: string;
  name: string;
};

/** Host-configurable option spec for a game (mirrors the SFU schema). */
export type GameOptionSpec =
  | {
      id: string;
      type: "number";
      label: string;
      min: number;
      max: number;
      default: number;
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

export type GameConfig = Record<string, number | string>;

export type GameCatalogEntry = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  options: GameOptionSpec[];
  hasLeaderboard: boolean;
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

export type GameMoveResult = {
  success: boolean;
  error?: string;
};

export type GameUser = {
  id: string;
  name?: string | null;
};

/** A host-initiated vote on which game to play next. */
export type GameVote = {
  candidates: GameCatalogEntry[];
  tally: Record<string, number>;
  votes: Record<string, string>;
  totalPlayers: number;
};

export type GameContextValue = {
  /** Available games to launch. */
  catalog: GameCatalogEntry[];
  /** Current room-wide public game state, or null when no game is active. */
  publicState: GamePublicState | null;
  /** This player's private projection of the active game, if any. */
  view: unknown;
  /** Active pre-game vote, or null. */
  vote: GameVote | null;
  isActive: boolean;
  isAdmin: boolean;
  userId: string | null;
  startGame: (gameId: string, options?: GameConfig) => Promise<GameMoveResult>;
  endGame: () => Promise<GameMoveResult>;
  move: (type: string, payload?: unknown) => Promise<GameMoveResult>;
  openVote: (candidateIds?: string[]) => Promise<GameMoveResult>;
  castVote: (gameId: string) => Promise<GameMoveResult>;
  cancelVote: () => Promise<GameMoveResult>;
  refresh: () => void;
};

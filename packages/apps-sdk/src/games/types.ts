export type GamePlayer = {
  id: string;
  name: string;
};

export type GameOptionCondition = {
  id: string;
  equals: string[];
};

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

export type GamePublicState = {
  gameId: string;
  name: string;
  phase: string;
  players: GamePlayer[];
  hostId: string | null;
  view: unknown;
  finished: boolean;
  hasLeaderboard: boolean;
  config: GameConfig;
  pendingJoiners: GamePlayer[];
  canJoinLate: boolean;
};

export type GameMoveResult = {
  success: boolean;
  error?: string;
};

export type GameUser = {
  id: string;
  name?: string | null;
};

export type GameVote = {
  candidates: GameCatalogEntry[];
  tally: Record<string, number>;
  votes: Record<string, string>;
  totalPlayers: number;
};

export type GameContextValue = {
  catalog: GameCatalogEntry[];
  publicState: GamePublicState | null;
  view: unknown;
  vote: GameVote | null;
  isActive: boolean;
  isAdmin: boolean;
  isReadOnly: boolean;
  userId: string | null;
  startGame: (gameId: string, options?: GameConfig) => Promise<GameMoveResult>;
  endGame: () => Promise<GameMoveResult>;
  joinGame: () => Promise<GameMoveResult>;
  move: (type: string, payload?: unknown) => Promise<GameMoveResult>;
  openVote: (candidateIds?: string[]) => Promise<GameMoveResult>;
  castVote: (gameId: string) => Promise<GameMoveResult>;
  cancelVote: () => Promise<GameMoveResult>;
  refresh: () => void;
};

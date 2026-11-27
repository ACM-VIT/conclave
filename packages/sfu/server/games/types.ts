import type { AiEnvironment } from "@conclave/ai/models";
import type { DecisionAnswer, DecisionQuestion } from "@conclave/ai/decisions";

export type GamePlayer = {
  id: string;
  name: string;
};

export type GameRng = {
  next(): number;
  int(maxExclusive: number): number;
  shuffle<T>(items: readonly T[]): T[];
  pick<T>(items: readonly T[]): T;
};

type GameOptionCondition = {
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

export type GameContext = {
  players: GamePlayer[];
  activePlayers: GamePlayer[];
  rng: GameRng;
  config: GameConfig;
  content: unknown | null;
  now: number;
  isAdmin(playerId: string): boolean;
};

type GameContentContext = {
  signal?: AbortSignal;
  aiEnvironment?: AiEnvironment;
  players: GamePlayer[];
  config: GameConfig;
  now: number;
};

export type GameMove = {
  playerId: string;
  type: string;
  payload: unknown;
  verified?: unknown;
  receivedAt?: number;
};

export type GameDecisionRequest = {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
};

export type GamePendingMove = { playerId: string; receivedAt: number };

export type GameDecider = (request: GameDecisionRequest) => Promise<Record<string, DecisionAnswer>>;

export type GamePrepareContext = {
  players: GamePlayer[];
  activePlayers: GamePlayer[];
  config: GameConfig;
  now: number;
  decide: GameDecider | null;
  signal: AbortSignal;
  cache: Map<string, unknown>;
  isAdmin(playerId: string): boolean;
};

type LateJoinPhasesResolver<S> = {
  bivarianceHack(state: S, ctx: GameContext): string[];
}["bivarianceHack"];

export type GameModule<S = unknown> = {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  tickMs?: number;
  options?: GameOptionSpec[];
  hasLeaderboard?: boolean;
  lateJoinPhases?: string[] | LateJoinPhasesResolver<S>;
  spectatable?: boolean;

  generateContent?(ctx: GameContentContext): Promise<unknown | null>;
  setup(ctx: GameContext): S;
  prepareMove?(state: S, move: GameMove, ctx: GamePrepareContext): Promise<unknown>;
  holdTick?(state: S, pending: GamePendingMove[], ctx: GameContext): boolean;
  onMove(state: S, move: GameMove, ctx: GameContext): S;
  onTick?(state: S, ctx: GameContext): S;

  getPhase(state: S): string;
  publicView(state: S, ctx: GameContext): unknown;
  playerView(state: S, playerId: string, ctx: GameContext): unknown;
  isFinished?(state: S): boolean;
};

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

export type GamePublicState = {
  gameId: string;
  name: string;
  phase: string;
  players: GamePlayer[];
  hostId: string | null;
  view: unknown;
  finished: boolean;
  hasLeaderboard: boolean;
  pendingJoiners: GamePlayer[];
  canJoinLate: boolean;
  config: GameConfig;
};

export type GameStateResponse = {
  active: boolean;
  public?: GamePublicState;
  view?: unknown;
  vote?: GameVoteState | null;
  selfId?: string;
};


export type GameVoteState = {
  candidates: GameCatalogEntry[];
  tally: Record<string, number>;
  votes: Record<string, string>;
  totalPlayers: number;
};

export type GameVoteOpenData = { candidates?: unknown };
export type GameVoteCastData = { gameId?: unknown };
export type GameVoteResponse = { success: boolean; error?: string };

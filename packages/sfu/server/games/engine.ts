import { createRng, createSeed } from "./rng.js";
import {
  GameMoveError,
  type GameConfig,
  type GameContext,
  type GameModule,
  type GameOptionSpec,
  type GamePlayer,
  type GamePublicState,
  type GameRng,
} from "./types.js";

/**
 * Owns the authoritative state for one running game in one room.
 *
 * The session is transport-agnostic: it never touches socket.io. It exposes
 * pure operations (`applyMove`, `tick`) and projection getters
 * (`getPublicState`, `getPlayerView`). The handler layer is responsible for
 * mapping projections onto sockets (room broadcast vs. per-player emit).
 */
export class GameSession {
  readonly module: GameModule;
  readonly hostId: string;
  private players: GamePlayer[];
  private activePlayers: GamePlayer[];
  private readonly playerIds: Set<string>;
  private readonly rng: GameRng;
  private adminIds: Set<string>;
  private readonly config: GameConfig;
  private readonly content: unknown | null;
  private state: unknown;
  private finished = false;

  constructor(options: {
    module: GameModule;
    players: GamePlayer[];
    adminIds: Iterable<string>;
    hostId: string;
    config?: GameConfig;
    content?: unknown | null;
    seed?: number;
  }) {
    this.module = options.module;
    this.players = dedupePlayers(options.players);
    this.playerIds = new Set(this.players.map((player) => player.id));
    this.activePlayers = this.players.slice();
    this.adminIds = new Set(options.adminIds);
    this.hostId = options.hostId;
    this.config = options.config ?? {};
    this.content = options.content ?? null;
    this.rng = createRng(options.seed ?? createSeed());
    this.state = this.module.setup(this.context());
    this.finished = this.module.isFinished?.(this.state) ?? false;
  }

  get gameId(): string {
    return this.module.id;
  }

  get tickMs(): number | null {
    return this.module.tickMs ?? null;
  }

  isFinished(): boolean {
    return this.finished;
  }

  hasPlayer(playerId: string): boolean {
    return this.playerIds.has(playerId);
  }

  getPlayers(): GamePlayer[] {
    return this.players.slice();
  }

  updateRoomMembership(options: {
    players: GamePlayer[];
    adminIds: Iterable<string>;
  }): void {
    this.activePlayers = dedupePlayers(options.players).filter((player) =>
      this.playerIds.has(player.id),
    );
    this.adminIds = new Set(options.adminIds);
  }

  private context(now: number = Date.now()): GameContext {
    return {
      players: this.players.slice(),
      activePlayers: this.activePlayers.slice(),
      rng: this.rng,
      config: this.config,
      content: this.content,
      now,
      isAdmin: (playerId: string) => this.adminIds.has(playerId),
    };
  }

  /**
   * Apply a player move. Returns `{ ok: true }` if the state advanced, or
   * `{ ok: false, error }` if the module rejected it (illegal move), in which
   * case state is unchanged. Unexpected errors are surfaced generically.
   */
  applyMove(
    playerId: string,
    type: string,
    payload: unknown,
  ): { ok: true } | { ok: false; error: string } {
    if (this.finished) {
      return { ok: false, error: "Game has ended" };
    }
    if (!this.hasPlayer(playerId)) {
      return { ok: false, error: "You are not a player in this game" };
    }
    try {
      const next = this.module.onMove(
        this.state,
        { playerId, type, payload },
        this.context(),
      );
      this.state = next;
      this.finished = this.module.isFinished?.(next) ?? false;
      return { ok: true };
    } catch (error) {
      if (error instanceof GameMoveError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  /** Advance time-driven state. Returns true if the projection changed. */
  tick(now: number = Date.now()): boolean {
    if (this.finished || !this.module.onTick) return false;
    const next = this.module.onTick(this.state, this.context(now));
    if (next === this.state) return false;
    this.state = next;
    this.finished = this.module.isFinished?.(next) ?? false;
    return true;
  }

  getPublicState(now: number = Date.now()): GamePublicState {
    const ctx = this.context(now);
    return {
      gameId: this.module.id,
      name: this.module.name,
      phase: this.module.getPhase(this.state),
      players: this.players.slice(),
      hostId: this.hostId,
      view: this.module.publicView(this.state, ctx),
      finished: this.finished,
      hasLeaderboard: Boolean(this.module.hasLeaderboard),
      config: publicRematchConfig(this.module.options, this.config),
    };
  }

  getPlayerView(playerId: string, now: number = Date.now()): unknown {
    return this.module.playerView(this.state, playerId, this.context(now));
  }
}

const dedupePlayers = (players: GamePlayer[]): GamePlayer[] => {
  const seen = new Set<string>();
  const out: GamePlayer[] = [];
  for (const player of players) {
    if (!player?.id || seen.has(player.id)) continue;
    seen.add(player.id);
    out.push({ id: player.id, name: player.name });
  }
  return out;
};

const publicRematchConfig = (
  options: GameOptionSpec[] | undefined,
  config: GameConfig,
): GameConfig => {
  const safe: GameConfig = {};
  for (const opt of options ?? []) {
    const value = config[opt.id];
    if (opt.type === "number") {
      if (typeof value === "number") safe[opt.id] = value;
    } else if (opt.type === "select") {
      if (typeof value === "string") safe[opt.id] = value;
    }
    // Text options can contain user-authored/private topic text. They are
    // intentionally omitted from public state; rematches fall back to defaults.
  }
  return safe;
};

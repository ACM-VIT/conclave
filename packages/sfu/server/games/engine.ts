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
  /** Room members waiting for a seat at the next round boundary. */
  private pendingJoiners: GamePlayer[] = [];

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
    const roomPlayers = dedupePlayers(options.players);
    const roomPlayerIds = new Set(roomPlayers.map((player) => player.id));
    this.pendingJoiners = this.pendingJoiners.filter((player) =>
      roomPlayerIds.has(player.id),
    );
    this.activePlayers = roomPlayers.filter((player) =>
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

  /** Whether non-players may receive a projected view of this game. */
  get spectatable(): boolean {
    return this.module.spectatable !== false;
  }

  hasPendingPlayer(playerId: string): boolean {
    return this.pendingJoiners.some((player) => player.id === playerId);
  }

  private getLateJoinPhases(now: number = Date.now()): string[] {
    const phases = this.module.lateJoinPhases;
    if (!phases) return [];
    if (typeof phases === "function") {
      return phases(this.state, this.context(now));
    }
    return phases;
  }

  /**
   * Seat a room member at once while the game is still in its lobby, or queue
   * them for a seat at the next round boundary. The seat is
   * granted when the game transitions into one of the module's declared
   * `lateJoinPhases`, so a joiner never lands mid-round with impossible state.
   */
  requestSeat(
    player: GamePlayer,
  ): { ok: true } | { ok: false; error: string } {
    if (this.finished) {
      return { ok: false, error: "Game has ended" };
    }
    if (this.hasPlayer(player.id)) {
      return { ok: false, error: "You are already in this game" };
    }
    if (this.hasPendingPlayer(player.id)) {
      return { ok: true };
    }
    if (this.module.getPhase(this.state) === "lobby") {
      if (this.players.length >= this.module.maxPlayers) {
        return { ok: false, error: "Game is full" };
      }
      this.playerIds.add(player.id);
      this.players.push({ id: player.id, name: player.name });
      this.activePlayers.push({ id: player.id, name: player.name });
      return { ok: true };
    }
    if (this.getLateJoinPhases().length === 0) {
      return { ok: false, error: "This game does not support joining mid-game" };
    }
    if (
      this.players.length + this.pendingJoiners.length >=
      this.module.maxPlayers
    ) {
      return { ok: false, error: "Game is full" };
    }
    this.pendingJoiners.push({ id: player.id, name: player.name });
    return { ok: true };
  }

  /**
   * Seat queued joiners when the phase just transitioned into a declared
   * late-join phase (a fresh round). Round state in the modules is keyed by
   * player id with absent-means-not-acted semantics, so a newly seated player
   * simply participates from this round on; scores default to zero.
   */
  private seatPendingIfBoundary(previousPhase: string): void {
    if (this.pendingJoiners.length === 0 || this.finished) return;
    const phases = this.getLateJoinPhases();
    if (phases.length === 0) return;
    const phase = this.module.getPhase(this.state);
    if (phase === previousPhase || !phases.includes(phase)) return;
    for (const joiner of this.pendingJoiners) {
      if (this.playerIds.has(joiner.id)) continue;
      this.playerIds.add(joiner.id);
      this.players.push({ id: joiner.id, name: joiner.name });
      this.activePlayers.push({ id: joiner.id, name: joiner.name });
    }
    this.pendingJoiners = [];
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
    const previousPhase = this.module.getPhase(this.state);
    try {
      const next = this.module.onMove(
        this.state,
        { playerId, type, payload },
        this.context(),
      );
      this.state = next;
      this.finished = this.module.isFinished?.(next) ?? false;
      this.seatPendingIfBoundary(previousPhase);
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
    const previousPhase = this.module.getPhase(this.state);
    const next = this.module.onTick(this.state, this.context(now));
    if (next === this.state) return false;
    this.state = next;
    this.finished = this.module.isFinished?.(next) ?? false;
    this.seatPendingIfBoundary(previousPhase);
    return true;
  }

  getPublicState(now: number = Date.now()): GamePublicState {
    const ctx = this.context(now);
    const lateJoinPhases = this.getLateJoinPhases(now);
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
      pendingJoiners: this.pendingJoiners.slice(),
      canJoinLate:
        !this.finished &&
        (this.module.getPhase(this.state) === "lobby" ||
          lateJoinPhases.length > 0) &&
        this.players.length + this.pendingJoiners.length <
          this.module.maxPlayers,
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

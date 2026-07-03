import { describe, expect, it } from "vitest";
import { CHESS_BOT_ID, chessModule } from "../server/games/modules/chess.js";
import { pickBotMove } from "../server/games/modules/chessBot.js";
import { GameMoveError } from "../server/games/types.js";
import type { GameConfig, GameContext, GamePlayer, GameRng } from "../server/games/types.js";
import { Chess } from "chess.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Pat" },
];

/** Identity shuffle: host seats as White, p2 as Black. */
const rng = (next = 0.99): GameRng => ({
  next: () => next,
  int: () => 0,
  shuffle: (items) => items.slice(),
  pick: (items) => items[0],
});

const context = (
  now: number,
  options?: {
    config?: GameConfig;
    activePlayers?: GamePlayer[];
    players?: GamePlayer[];
    rng?: GameRng;
  },
): GameContext => ({
  players: options?.players ?? players,
  activePlayers: options?.activePlayers ?? options?.players ?? players,
  rng: options?.rng ?? rng(),
  config: options?.config ?? {},
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

type ChessState = ReturnType<typeof chessModule.setup>;

const started = (config: GameConfig = {}, opts?: { players?: GamePlayer[] }) => {
  const ctxOpts = { config, players: opts?.players };
  const state = chessModule.setup(context(0, ctxOpts));
  return chessModule.onMove(
    state,
    { playerId: "host", type: "start", payload: undefined },
    context(1_000, ctxOpts),
  );
};

const play = (
  state: ChessState,
  playerId: string,
  from: string,
  to: string,
  now: number,
  config: GameConfig = {},
) =>
  chessModule.onMove(
    state,
    { playerId, type: "move", payload: { from, to } },
    context(now, { config }),
  );

type PublicView = {
  phase: string;
  mode: string;
  clocks: Record<"white" | "black", number | null>;
  timeControlMs: number | null;
  incrementMs: number;
  moveTimeMs: number | null;
  allowTakebacks: boolean;
  bot: { side: string; level: string; name: string } | null;
  turnSide: "white" | "black";
  fen: string;
  moves: { san: string; auto: boolean; byPlayerId: string }[];
  teams: Record<"white" | "black", { id: string; name: string; captain: boolean }[]>;
  takebackRequest: { side: string; byName: string } | null;
  result: { winner: string; reason: string } | null;
};

const view = (state: ChessState, now: number): PublicView =>
  chessModule.publicView(state, context(now)) as PublicView;

describe("chess config", () => {
  it("parses time control presets with increments", () => {
    const state = chessModule.setup(context(0, { config: { timeControl: "180+2" } }));
    const pub = view(state, 0);
    expect(pub.timeControlMs).toBe(180_000);
    expect(pub.incrementMs).toBe(2_000);
    expect(pub.clocks).toEqual({ white: 180_000, black: 180_000 });
  });

  it("supports unlimited time and rapid fire per-move caps", () => {
    const state = chessModule.setup(
      context(0, { config: { timeControl: "unlimited", rapidFire: "10" } }),
    );
    const pub = view(state, 0);
    expect(pub.timeControlMs).toBeNull();
    expect(pub.moveTimeMs).toBe(10_000);
  });

  it("defaults to a 10 minute game with takebacks allowed", () => {
    const state = chessModule.setup(context(0));
    const pub = view(state, 0);
    expect(pub.timeControlMs).toBe(600_000);
    expect(pub.incrementMs).toBe(0);
    expect(pub.moveTimeMs).toBeNull();
    expect(pub.allowTakebacks).toBe(true);
  });
});

describe("chess clocks", () => {
  it("charges thinking time to the side to move and adds the increment", () => {
    let state = started({ timeControl: "120+1" });
    // White thinks for 5s, then moves: 120 - 5 + 1 = 116s.
    state = play(state, "host", "e2", "e4", 6_000);
    const pub = view(state, 6_000);
    expect(pub.clocks.white).toBe(116_000);
    expect(pub.clocks.black).toBe(120_000);
    expect(pub.turnSide).toBe("black");
  });

  it("flags the side to move on timeout", () => {
    let state = started({ timeControl: "60+0" });
    state = chessModule.onTick!(state, context(62_000));
    const pub = view(state, 62_000);
    expect(pub.phase).toBe("results");
    expect(pub.result).toEqual({ winner: "black", reason: "timeout" });
  });

  it("scores a timeout against a lone king as a draw", () => {
    let state = started({ timeControl: "60+0" }) as {
      [key: string]: unknown;
      clocks: Record<string, number | null>;
    };
    // Black to move and out of time; white has only a king left.
    state = {
      ...state,
      fen: "k7/8/8/8/8/8/8/K7 b - - 0 1",
      turn: "b",
      turnStartedAt: 1_000,
      clocks: { white: 60_000, black: 100 },
    };
    const next = chessModule.onTick!(state as ChessState, context(5_000));
    const pub = view(next, 5_000);
    expect(pub.result).toEqual({ winner: "draw", reason: "timeout" });
  });
});

describe("chess rapid fire", () => {
  it("auto-plays a random legal move when the per-move timer expires", () => {
    let state = started({ timeControl: "unlimited", rapidFire: "10" });
    // Not yet expired.
    expect(chessModule.onTick!(state, context(10_500))).toBe(state);
    // Expired (turn started at 1s, cap 10s).
    state = chessModule.onTick!(state, context(11_200));
    const pub = view(state, 11_200);
    expect(pub.moves).toHaveLength(1);
    expect(pub.moves[0].auto).toBe(true);
    expect(pub.moves[0].byPlayerId).toBe("host");
    expect(pub.turnSide).toBe("black");
  });
});

describe("chess takebacks", () => {
  it("rewinds one ply when the mover asks before the reply", () => {
    let state = started();
    const startFen = view(state, 1_000).fen;
    state = play(state, "host", "e2", "e4", 2_000);
    state = chessModule.onMove(
      state,
      { playerId: "host", type: "requestTakeback", payload: undefined },
      context(3_000),
    );
    expect(view(state, 3_000).takebackRequest?.side).toBe("white");
    state = chessModule.onMove(
      state,
      { playerId: "p2", type: "acceptTakeback", payload: undefined },
      context(4_000),
    );
    const pub = view(state, 4_000);
    expect(pub.moves).toHaveLength(0);
    expect(pub.fen).toBe(startFen);
    expect(pub.turnSide).toBe("white");
  });

  it("rewinds two plies when the opponent already replied", () => {
    let state = started();
    state = play(state, "host", "e2", "e4", 2_000);
    state = play(state, "p2", "e7", "e5", 3_000);
    state = chessModule.onMove(
      state,
      { playerId: "host", type: "requestTakeback", payload: undefined },
      context(4_000),
    );
    state = chessModule.onMove(
      state,
      { playerId: "p2", type: "acceptTakeback", payload: undefined },
      context(5_000),
    );
    const pub = view(state, 5_000);
    expect(pub.moves).toHaveLength(0);
    expect(pub.turnSide).toBe("white");
  });

  it("rejects takebacks when disabled", () => {
    let state = started({ takebacks: "off" });
    state = play(state, "host", "e2", "e4", 2_000);
    expect(() =>
      chessModule.onMove(
        state,
        { playerId: "host", type: "requestTakeback", payload: undefined },
        context(3_000),
      ),
    ).toThrow(GameMoveError);
  });
});

describe("chess vs computer", () => {
  const soloConfig: GameConfig = {
    mode: "computer",
    side: "white",
    difficulty: "easy",
    timeControl: "unlimited",
  };
  const solo = () => started(soloConfig, { players: [players[0]] });

  it("seats the starter against the bot on the chosen side", () => {
    const state = solo();
    const pub = view(state, 1_000);
    expect(pub.mode).toBe("computer");
    expect(pub.bot?.side).toBe("black");
    expect(pub.teams.white).toEqual([{ id: "host", name: "Host", captain: true }]);
    expect(pub.teams.black).toEqual([{ id: CHESS_BOT_ID, name: "Computer", captain: true }]);
  });

  it("answers with a legal move after its thinking delay", () => {
    let state = solo();
    state = play(state, "host", "e2", "e4", 2_000, soloConfig);
    // Bot delay is at most 1.2s; well past it the bot must have replied.
    state = chessModule.onTick!(state, context(10_000, { config: soloConfig }));
    const pub = view(state, 10_000);
    expect(pub.moves).toHaveLength(2);
    expect(pub.moves[1].byPlayerId).toBe(CHESS_BOT_ID);
    expect(pub.turnSide).toBe("white");
    expect(new Chess(pub.fen).isGameOver()).toBe(false);
  });

  it("applies takebacks against the computer instantly", () => {
    let state = solo();
    state = play(state, "host", "e2", "e4", 2_000, soloConfig);
    state = chessModule.onTick!(state, context(10_000, { config: soloConfig }));
    state = chessModule.onMove(
      state,
      { playerId: "host", type: "requestTakeback", payload: undefined },
      context(11_000, { config: soloConfig }),
    );
    const pub = view(state, 11_000);
    expect(pub.moves).toHaveLength(0);
    expect(pub.turnSide).toBe("white");
    expect(pub.takebackRequest).toBeNull();
  });

  it("refuses draw offers", () => {
    let state = solo();
    state = play(state, "host", "e2", "e4", 2_000, soloConfig);
    expect(() =>
      chessModule.onMove(
        state,
        { playerId: "host", type: "offerDraw", payload: undefined },
        context(3_000, { config: soloConfig }),
      ),
    ).toThrow(/play on/);
  });

  it("requires at least one player, not two", () => {
    const state = chessModule.setup(
      context(0, { config: soloConfig, players: [players[0]] }),
    );
    const startedState = chessModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1_000, { config: soloConfig, players: [players[0]] }),
    );
    expect(chessModule.getPhase(startedState)).toBe("playing");
  });
});

describe("chess bot engine", () => {
  it("returns only legal moves at every level", () => {
    const fens = [
      new Chess().fen(),
      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
      "8/2k5/8/8/3q4/8/2K5/8 b - - 0 1",
    ];
    for (const fen of fens) {
      for (const level of ["easy", "medium", "hard"] as const) {
        const move = pickBotMove(fen, level, rng(0.5));
        expect(move).not.toBeNull();
        const game = new Chess(fen);
        expect(() => game.move({ from: move!.from, to: move!.to, promotion: move!.promotion ?? "q" })).not.toThrow();
      }
    }
  });

  it("finds mate in one on hard", () => {
    // White: Ra1, Rb7, Ke1 vs Black: Kh8. Ra8 is mate.
    const move = pickBotMove("7k/1R6/8/8/8/8/8/R3K3 w - - 0 1", "hard", rng(0.99));
    expect(move).toEqual({ from: "a1", to: "a8", promotion: undefined });
  });

  it("returns null when the game is over", () => {
    // Fool's mate final position: white is checkmated.
    const game = new Chess();
    for (const san of ["f3", "e5", "g4", "Qh4#"]) game.move(san);
    expect(pickBotMove(game.fen(), "medium", rng())).toBeNull();
  });
});

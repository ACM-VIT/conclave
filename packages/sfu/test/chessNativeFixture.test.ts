import { describe, expect, it } from "vitest";
import { chessModule } from "../server/games/modules/chess.js";
import { GameMoveError } from "../server/games/types.js";
import type { GameConfig, GameContext, GamePlayer, GameRng } from "../server/games/types.js";

/**
 * ACT-5 native fixture parity (HD request B8-T3 R8). The native chess fixtures in apps/conclave-skip
 * (ChessFixtures, end of GameStagePresenter.swift) hard-code the positions, legal moves and SAN records below; the
 * module must project exactly these for the same lines, and must accept every action type the native board sends
 * (offerDraw, acceptDraw, declineDraw, requestTakeback, acceptTakeback, declineTakeback, resign; S60 11 l, C6-17).
 */

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Pat" },
];

/** Identity shuffle: host seats as White, p2 as Black. */
const rng = (): GameRng => ({
  next: () => 0.99,
  int: () => 0,
  shuffle: (items) => items.slice(),
  pick: (items) => items[0],
});

const context = (now: number, config: GameConfig = {}): GameContext => ({
  players,
  activePlayers: players,
  rng: rng(),
  config,
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

type ChessState = ReturnType<typeof chessModule.setup>;

type View = {
  phase: string;
  fen: string;
  turnSide: string;
  inCheck: boolean;
  turnStartedAt: number | null;
  legalMoves: Record<string, string[]>;
  moves: { san: string; from: string; to: string; color: string; byName: string; auto: boolean }[];
  drawOffer: { side: string } | null;
  takebackRequest: { side: string } | null;
  result: { winner: string; reason: string } | null;
};

const view = (state: ChessState, now: number): View => chessModule.publicView(state, context(now)) as View;

const start = (config: GameConfig = {}): ChessState =>
  chessModule.onMove(chessModule.setup(context(0, config)), { playerId: "host", type: "start", payload: undefined }, context(1_000, config));

/** Plays [from, to] pairs, White (host) first, one second apart. */
const line = (moves: [string, string][], config: GameConfig = {}): { state: ChessState; now: number } => {
  let state = start(config);
  let now = 1_000;
  moves.forEach(([from, to], index) => {
    now += 1_000;
    state = chessModule.onMove(
      state,
      { playerId: index % 2 === 0 ? "host" : "p2", type: "move", payload: { from, to } },
      context(now, config),
    );
  });
  return { state, now };
};

const act = (state: ChessState, playerId: string, type: string, now: number): ChessState =>
  chessModule.onMove(state, { playerId, type, payload: undefined }, context(now));

const fixtures: { name: string; moves: [string, string][]; fen: string; san: string[]; legal: Record<string, string[]> }[] = [
  {
    name: "opening",
    moves: [["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["b8", "c6"]],
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    san: ["e4", "e5", "Nf3", "Nc6"],
    legal: {
      f3: ["d4", "e5", "g5", "h4", "g1"], a2: ["a3", "a4"], b2: ["b3", "b4"], c2: ["c3", "c4"], d2: ["d3", "d4"],
      g2: ["g3", "g4"], h2: ["h3", "h4"], b1: ["a3", "c3"], d1: ["e2"], e1: ["e2"], f1: ["e2", "d3", "c4", "b5", "a6"],
      h1: ["g1"],
    },
  },
  {
    name: "check",
    moves: [["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["d7", "d6"], ["f1", "b5"]],
    fen: "rnbqkbnr/ppp2ppp/3p4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3",
    san: ["e4", "e5", "Nf3", "d6", "Bb5+"],
    legal: { b8: ["d7", "c6"], c8: ["d7"], d8: ["d7"], e8: ["e7"], c7: ["c6"] },
  },
  {
    name: "promotion",
    moves: [["e2", "e4"], ["d7", "d5"], ["e4", "d5"], ["c7", "c6"], ["d5", "c6"], ["e7", "e5"], ["c6", "b7"], ["e8", "e7"]],
    fen: "rnbq1bnr/pP2kppp/8/4p3/8/8/PPPP1PPP/RNBQKBNR w KQ - 1 5",
    san: ["e4", "d5", "exd5", "c6", "dxc6", "e5", "cxb7", "Ke7"],
    legal: {
      b7: ["a8", "a8", "a8", "a8", "c8", "c8", "c8", "c8"], a2: ["a3", "a4"], b2: ["b3", "b4"], c2: ["c3", "c4"],
      d2: ["d3", "d4"], f2: ["f3", "f4"], g2: ["g3", "g4"], h2: ["h3", "h4"], b1: ["a3", "c3"], d1: ["e2", "f3", "g4", "h5"],
      e1: ["e2"], f1: ["e2", "d3", "c4", "b5", "a6"], g1: ["e2", "f3", "h3"],
    },
  },
  {
    name: "takeback",
    moves: [["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["b8", "c6"], ["f1", "c4"]],
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    san: ["e4", "e5", "Nf3", "Nc6", "Bc4"],
    legal: {
      a8: ["b8"], d8: ["e7", "f6", "g5", "h4"], e8: ["e7"], f8: ["e7", "d6", "c5", "b4", "a3"], g8: ["h6", "f6", "e7"],
      a7: ["a6", "a5"], b7: ["b6", "b5"], d7: ["d6", "d5"], f7: ["f6", "f5"], g7: ["g6", "g5"], h7: ["h6", "h5"],
      c6: ["b8", "e7", "d4", "b4", "a5"],
    },
  },
  {
    name: "special",
    moves: [["e2", "e4"], ["a7", "a6"], ["g1", "f3"], ["a6", "a5"], ["f1", "c4"], ["h7", "h6"], ["e4", "e5"], ["d7", "d5"]],
    fen: "rnbqkbnr/1pp1ppp1/7p/p2pP3/2B5/5N2/PPPP1PPP/RNBQK2R w KQkq d6 0 5",
    san: ["e4", "a6", "Nf3", "a5", "Bc4", "h6", "e5", "d5"],
    legal: {
      e5: ["e6", "d6"], c4: ["b5", "a6", "d5", "d3", "e2", "f1", "b3"], f3: ["d4", "g5", "h4", "g1"], a2: ["a3", "a4"],
      b2: ["b3", "b4"], c2: ["c3"], d2: ["d3", "d4"], g2: ["g3", "g4"], h2: ["h3", "h4"], b1: ["a3", "c3"], d1: ["e2"],
      e1: ["e2", "f1", "g1"], h1: ["g1", "f1"],
    },
  },
];

describe("chess native fixture parity", () => {
  for (const fixture of fixtures) {
    it(`projects the ${fixture.name} position, legal moves and move list the native fixture carries`, () => {
      const { state, now } = line(fixture.moves);
      const pub = view(state, now);
      expect(pub.phase).toBe("playing");
      expect(pub.fen).toBe(fixture.fen);
      expect(pub.moves.map((move) => move.san)).toEqual(fixture.san);
      expect(pub.moves.every((move) => move.auto === false)).toBe(true);
      expect(pub.legalMoves).toEqual(fixture.legal);
      expect(pub.turnStartedAt).toBe(now);
    });
  }

  it("ends the fool's mate line in checkmate for Black", () => {
    const { state, now } = line([["f2", "f3"], ["e7", "e5"], ["g2", "g4"], ["d8", "h4"]]);
    const pub = view(state, now);
    expect(pub.fen).toBe("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
    expect(pub.moves.map((move) => move.san)).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(pub.phase).toBe("results");
    expect(pub.inCheck).toBe(true);
    expect(pub.legalMoves).toEqual({});
    expect(pub.result).toEqual({ winner: "black", reason: "checkmate" });
  });

  it("promotes only to the chosen piece", () => {
    const expected: Record<string, [string, string]> = {
      q: ["bxa8=Q", "Qnbq1bnr/p3kppp/8/4p3/8/8/PPPP1PPP/RNBQKBNR b KQ - 0 5"],
      r: ["bxa8=R", "Rnbq1bnr/p3kppp/8/4p3/8/8/PPPP1PPP/RNBQKBNR b KQ - 0 5"],
      b: ["bxa8=B", "Bnbq1bnr/p3kppp/8/4p3/8/8/PPPP1PPP/RNBQKBNR b KQ - 0 5"],
      n: ["bxa8=N", "Nnbq1bnr/p3kppp/8/4p3/8/8/PPPP1PPP/RNBQKBNR b KQ - 0 5"],
    };
    for (const [piece, [san, fen]] of Object.entries(expected)) {
      const { state, now } = line(fixtures[2].moves);
      const next = chessModule.onMove(
        state,
        { playerId: "host", type: "move", payload: { from: "b7", to: "a8", promotion: piece } },
        context(now + 1_000),
      );
      const pub = view(next, now + 1_000);
      expect(pub.moves[pub.moves.length - 1].san).toBe(san);
      expect(pub.fen).toBe(fen);
    }
  });

  it("plays en passant and castling as the native fixture flags them", () => {
    const passant = line(fixtures[4].moves);
    const afterPassant = view(
      chessModule.onMove(passant.state, { playerId: "host", type: "move", payload: { from: "e5", to: "d6" } }, context(passant.now + 1_000)),
      passant.now + 1_000,
    );
    expect(afterPassant.moves[afterPassant.moves.length - 1].san).toBe("exd6");
    expect(afterPassant.fen).toBe("rnbqkbnr/1pp1ppp1/3P3p/p7/2B5/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 5");
    const castle = line(fixtures[4].moves);
    const afterCastle = view(
      chessModule.onMove(castle.state, { playerId: "host", type: "move", payload: { from: "e1", to: "g1" } }, context(castle.now + 1_000)),
      castle.now + 1_000,
    );
    expect(afterCastle.moves[afterCastle.moves.length - 1].san).toBe("O-O");
    expect(afterCastle.fen).toBe("rnbqkbnr/1pp1ppp1/7p/p2pP3/2B5/5N2/PPPP1PPP/RNBQ1RK1 b kq - 1 5");
  });
});

describe("chess native action types", () => {
  it("accepts requestTakeback, then declineTakeback, then acceptTakeback", () => {
    const { state, now } = line([["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["b8", "c6"], ["f1", "c4"]]);
    let next = act(state, "host", "requestTakeback", now + 1_000);
    expect(view(next, now + 1_000).takebackRequest?.side).toBe("white");
    next = act(next, "p2", "declineTakeback", now + 2_000);
    expect(view(next, now + 2_000).takebackRequest).toBeNull();
    expect(view(next, now + 2_000).fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3");
    next = act(next, "host", "requestTakeback", now + 3_000);
    next = act(next, "p2", "acceptTakeback", now + 4_000);
    const pub = view(next, now + 4_000);
    expect(pub.fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
    expect(pub.moves.map((move) => move.san)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });

  it("accepts offerDraw, declineDraw and acceptDraw", () => {
    const { state, now } = line([["e2", "e4"], ["e7", "e5"]]);
    let next = act(state, "p2", "offerDraw", now + 1_000);
    expect(view(next, now + 1_000).drawOffer?.side).toBe("black");
    next = act(next, "host", "declineDraw", now + 2_000);
    expect(view(next, now + 2_000).drawOffer).toBeNull();
    next = act(next, "p2", "offerDraw", now + 3_000);
    next = act(next, "host", "acceptDraw", now + 4_000);
    expect(view(next, now + 4_000).result).toMatchObject({ winner: "draw", reason: "agreement" });
  });

  it("accepts resign from a captain and rejects actions from someone without a side", () => {
    const { state, now } = line([["e2", "e4"]]);
    const resigned = view(act(state, "p2", "resign", now + 1_000), now + 1_000);
    expect(resigned.result).toMatchObject({ winner: "white", reason: "resignation" });
    expect(() => act(state, "guest", "offerDraw", now + 1_000)).toThrow(GameMoveError);
  });
});

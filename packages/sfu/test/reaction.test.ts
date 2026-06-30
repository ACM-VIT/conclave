import { describe, expect, it } from "vitest";
import { reactionModule } from "../server/games/modules/reaction.js";
import type { GameContext, GameRng } from "../server/games/types.js";

const players = [
  { id: "host", name: "Host" },
  { id: "player", name: "Player" },
];

const rng: GameRng = {
  next: () => 0,
  int: () => 0,
  shuffle: (items) => items.slice(),
  pick: (items) => items[0],
};

const context = (now: number): GameContext => ({
  players,
  activePlayers: players,
  rng,
  config: { rounds: 3 },
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

const startGoRound = () => {
  let state = reactionModule.setup(context(0));
  state = reactionModule.onMove(
    state,
    { playerId: "host", type: "start", payload: undefined },
    context(1_000),
  );
  return reactionModule.onTick!(state, context(2_500));
};

const playerView = (
  state: ReturnType<typeof startGoRound>,
): { tapped: boolean; early: boolean; reactionMs: number | null } =>
  reactionModule.playerView(state, "player", context(0)) as {
    tapped: boolean;
    early: boolean;
    reactionMs: number | null;
  };

describe("reaction game", () => {
  it("scores taps from server receive time with server-owned latency allowance", () => {
    const state = reactionModule.onMove(
      startGoRound(),
      { playerId: "player", type: "tap", payload: undefined },
      context(2_900),
    );

    expect(playerView(state)).toMatchObject({
      tapped: true,
      early: false,
      reactionMs: 325,
    });
  });

  it("ignores client supplied tap timestamps during scoring", () => {
    const state = reactionModule.onMove(
      startGoRound(),
      { playerId: "player", type: "tap", payload: { serverTapAt: 2_501 } },
      context(2_900),
    );

    expect(playerView(state)).toMatchObject({
      tapped: true,
      early: false,
      reactionMs: 325,
    });
  });

  it("marks taps received during arming as early", () => {
    let state = reactionModule.setup(context(0));
    state = reactionModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1_000),
    );
    state = reactionModule.onMove(
      state,
      { playerId: "player", type: "tap", payload: undefined },
      context(2_400),
    );

    expect(playerView(state)).toMatchObject({
      tapped: true,
      early: true,
      reactionMs: null,
    });
  });
});

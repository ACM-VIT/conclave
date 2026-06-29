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
  it("scores taps from the bounded client-side server timestamp", () => {
    const state = reactionModule.onMove(
      startGoRound(),
      { playerId: "player", type: "tap", payload: { serverTapAt: 2_637 } },
      context(2_900),
    );

    expect(playerView(state)).toMatchObject({
      tapped: true,
      early: false,
      reactionMs: 137,
    });
  });

  it("keeps a pre-green client tap early even when it arrives after go", () => {
    const state = reactionModule.onMove(
      startGoRound(),
      { playerId: "player", type: "tap", payload: { serverTapAt: 2_499 } },
      context(2_650),
    );

    expect(playerView(state)).toMatchObject({
      tapped: true,
      early: true,
      reactionMs: null,
    });
  });

  it("falls back to receive time for stale client timestamps", () => {
    const state = reactionModule.onMove(
      startGoRound(),
      { playerId: "player", type: "tap", payload: { serverTapAt: 1 } },
      context(2_900),
    );

    expect(playerView(state)).toMatchObject({
      tapped: true,
      early: false,
      reactionMs: 400,
    });
  });
});

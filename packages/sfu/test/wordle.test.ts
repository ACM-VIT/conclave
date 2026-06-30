import { describe, expect, it } from "vitest";
import { wordleModule } from "../server/games/modules/wordle.js";
import type { GameContext, GamePlayer, GameRng } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "setter", name: "Setter" },
  { id: "guesser", name: "Guesser" },
];

const rng = (pickIndex = 0): GameRng => ({
  next: () => 0,
  int: () => 0,
  shuffle: (items) => items.slice(),
  pick: (items) => items[pickIndex] ?? items[0],
});

const context = (
  now: number,
  options?: { currentPlayers?: GamePlayer[]; pickIndex?: number },
): GameContext => ({
  players: options?.currentPlayers ?? players,
  rng: rng(options?.pickIndex),
  config: { timeLimitMinutes: 3, wordSource: "setter", rounds: 1 },
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

const startWithSetter = () =>
  wordleModule.onMove(
    wordleModule.setup(context(0)),
    { playerId: "host", type: "start", payload: undefined },
    context(1_000, { pickIndex: 1 }),
  );

describe("wordle game", () => {
  it("reassigns a missing setter on tick during word selection", () => {
    const remainingPlayers = players.filter((player) => player.id !== "setter");
    const state = wordleModule.onTick!(
      startWithSetter(),
      context(1_500, { currentPlayers: remainingPlayers, pickIndex: 0 }),
    );

    expect(state.setterId).toBe("host");
    expect(
      wordleModule.playerView(state, "host", context(1_500, {
        currentPlayers: remainingPlayers,
      })),
    ).toMatchObject({
      canSetWord: true,
      isSetter: true,
    });
  });

  it("allows the first remaining player to replace the missing setter", () => {
    const remainingPlayers = players.filter((player) => player.id !== "setter");
    const state = wordleModule.onMove(
      startWithSetter(),
      { playerId: "guesser", type: "setWord", payload: { word: "AALII" } },
      context(2_000, { currentPlayers: remainingPlayers, pickIndex: 0 }),
    );

    const publicView = wordleModule.publicView(
      state,
      context(2_000, { currentPlayers: remainingPlayers }),
    ) as {
      phase: string;
      setterId: string | null;
      standings: Array<{ playerId: string }>;
      result: { targetWord: string | null } | null;
    };

    expect(publicView).toMatchObject({
      phase: "playing",
      setterId: "guesser",
    });
    expect(publicView.standings.map((entry) => entry.playerId)).toEqual(["host"]);
  });
});

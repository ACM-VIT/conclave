import { describe, expect, it } from "vitest";
import { mostLikelyToModule } from "../server/games/modules/mostLikelyTo.js";
import { GameMoveError } from "../server/games/types.js";
import type { GameContext, GamePlayer, GameRng } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Pat" },
  { id: "p3", name: "Robin" },
];

const rng: GameRng = {
  next: () => 0,
  int: () => 0,
  shuffle: (items) => items.slice(),
  pick: (items) => items[0],
};

const context = (
  now: number,
  options?: { activePlayers?: GamePlayer[] },
): GameContext => ({
  players,
  activePlayers: options?.activePlayers ?? players,
  rng,
  config: { rounds: 6 },
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

const started = (activePlayers?: GamePlayer[]) =>
  mostLikelyToModule.onMove(
    mostLikelyToModule.setup(context(0, { activePlayers })),
    { playerId: "host", type: "start", payload: undefined },
    context(1_000, { activePlayers }),
  );

describe("most likely to game", () => {
  it("starts in lobby with a sane initial public view", () => {
    const state = mostLikelyToModule.setup(context(0));
    expect(mostLikelyToModule.getPhase(state)).toBe("lobby");
    const view = mostLikelyToModule.publicView(state, context(0)) as {
      phase: string;
      prompt: string | null;
      answeredCount: number;
      totalPlayers: number;
      players: Array<{ id: string }>;
    };
    expect(view.phase).toBe("lobby");
    expect(view.prompt).toBeNull();
    expect(view.answeredCount).toBe(0);
    expect(view.totalPlayers).toBe(3);
    // The vote-target roster stays the full seat list.
    expect(view.players.map((entry) => entry.id)).toEqual(["host", "p2", "p3"]);
  });

  it("crowns whoever the room voted for on the reveal", () => {
    let state = started();
    state = mostLikelyToModule.onMove(
      state,
      { playerId: "host", type: "vote", payload: { target: "p3" } },
      context(2_000),
    );
    state = mostLikelyToModule.onMove(
      state,
      { playerId: "p2", type: "vote", payload: { target: "p3" } },
      context(2_000),
    );
    state = mostLikelyToModule.onMove(
      state,
      { playerId: "p3", type: "vote", payload: { target: "host" } },
      context(2_000),
    );
    // Every present player voted -> deadline collapses, tick reveals.
    state = mostLikelyToModule.onTick!(state, context(2_000));

    expect(mostLikelyToModule.getPhase(state)).toBe("reveal");
    const view = mostLikelyToModule.publicView(state, context(2_000)) as {
      counts: Record<string, number>;
      winnerId: string | null;
      winnerName: string | null;
    };
    expect(view.counts).toEqual({ p3: 2, host: 1 });
    expect(view.winnerId).toBe("p3");
    expect(view.winnerName).toBe("Robin");
  });

  it("rejects voting outside the vote phase", () => {
    const lobby = mostLikelyToModule.setup(context(0));
    expect(() =>
      mostLikelyToModule.onMove(
        lobby,
        { playerId: "host", type: "vote", payload: { target: "p2" } },
        context(500),
      ),
    ).toThrow(GameMoveError);
  });

  it("rejects an invalid vote target", () => {
    expect(() =>
      mostLikelyToModule.onMove(
        started(),
        { playerId: "host", type: "vote", payload: { target: "nobody" } },
        context(2_000),
      ),
    ).toThrow("Invalid vote");
  });

  it("advances early once every present player votes, ignoring an absent seat", () => {
    // p3 holds a seat but is disconnected: only host and p2 are active.
    const active = players.filter((player) => player.id !== "p3");

    let state = mostLikelyToModule.onMove(
      started(active),
      { playerId: "host", type: "vote", payload: { target: "p3" } },
      context(2_000, { activePlayers: active }),
    );
    // Still open: not every present player has voted.
    expect(state.deadline).toBe(1_000 + 15_000);

    state = mostLikelyToModule.onMove(
      state,
      { playerId: "p2", type: "vote", payload: { target: "p3" } },
      context(2_000, { activePlayers: active }),
    );
    // Both present players voted -> deadline collapses to now. Under the old
    // ctx.players logic (length 3) this would still sit at the full deadline.
    expect(state.deadline).toBe(2_000);

    const advanced = mostLikelyToModule.onTick!(
      state,
      context(2_000, { activePlayers: active }),
    );
    expect(mostLikelyToModule.getPhase(advanced)).toBe("reveal");

    const view = mostLikelyToModule.publicView(
      advanced,
      context(2_000, { activePlayers: active }),
    ) as { totalPlayers: number };
    expect(view.totalPlayers).toBe(2);
  });
});

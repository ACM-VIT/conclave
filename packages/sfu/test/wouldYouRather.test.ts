import { describe, expect, it } from "vitest";
import { wouldYouRatherModule } from "../server/games/modules/wouldYouRather.js";
import { GameMoveError } from "../server/games/types.js";
import type { GameContext, GamePlayer, GameRng } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Pat" },
  { id: "p3", name: "Robin" },
];

// Identity shuffle keeps the prompt bank order: the first prompt is
// { a: "Be able to fly", b: "Be invisible" }.
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
  wouldYouRatherModule.onMove(
    wouldYouRatherModule.setup(context(0, { activePlayers })),
    { playerId: "host", type: "start", payload: undefined },
    context(1_000, { activePlayers }),
  );

describe("would you rather game", () => {
  it("starts in lobby with a sane initial public view", () => {
    const state = wouldYouRatherModule.setup(context(0));
    expect(wouldYouRatherModule.getPhase(state)).toBe("lobby");
    const view = wouldYouRatherModule.publicView(state, context(0)) as {
      phase: string;
      optionA: string | null;
      counts: [number, number];
      answeredCount: number;
      totalPlayers: number;
    };
    expect(view.phase).toBe("lobby");
    expect(view.optionA).toBe("Be able to fly");
    expect(view.counts).toEqual([0, 0]);
    expect(view.answeredCount).toBe(0);
    expect(view.totalPlayers).toBe(3);
  });

  it("reveals the room split after everyone chooses", () => {
    let state = started();
    state = wouldYouRatherModule.onMove(
      state,
      { playerId: "host", type: "choose", payload: { option: 0 } },
      context(2_000),
    );
    state = wouldYouRatherModule.onMove(
      state,
      { playerId: "p2", type: "choose", payload: { option: 1 } },
      context(2_000),
    );
    state = wouldYouRatherModule.onMove(
      state,
      { playerId: "p3", type: "choose", payload: { option: 0 } },
      context(2_000),
    );
    // Every present player chose -> deadline collapses, tick reveals.
    state = wouldYouRatherModule.onTick!(state, context(2_000));

    expect(wouldYouRatherModule.getPhase(state)).toBe("reveal");
    const view = wouldYouRatherModule.publicView(state, context(2_000)) as {
      counts: [number, number];
      namesA: string[];
      namesB: string[];
    };
    expect(view.counts).toEqual([2, 1]);
    expect(view.namesA.sort()).toEqual(["Host", "Robin"]);
    expect(view.namesB).toEqual(["Pat"]);
  });

  it("rejects choosing outside the choose phase", () => {
    const lobby = wouldYouRatherModule.setup(context(0));
    expect(() =>
      wouldYouRatherModule.onMove(
        lobby,
        { playerId: "host", type: "choose", payload: { option: 0 } },
        context(500),
      ),
    ).toThrow(GameMoveError);
  });

  it("rejects an out-of-range pick", () => {
    expect(() =>
      wouldYouRatherModule.onMove(
        started(),
        { playerId: "host", type: "choose", payload: { option: 2 } },
        context(2_000),
      ),
    ).toThrow("Invalid pick");
  });

  it("advances early once every present player picks, ignoring an absent seat", () => {
    // p3 holds a seat but is disconnected: only host and p2 are active.
    const active = players.filter((player) => player.id !== "p3");

    let state = wouldYouRatherModule.onMove(
      started(active),
      { playerId: "host", type: "choose", payload: { option: 0 } },
      context(2_000, { activePlayers: active }),
    );
    // Still open: not every present player has chosen.
    expect(state.deadline).toBe(1_000 + 15_000);

    state = wouldYouRatherModule.onMove(
      state,
      { playerId: "p2", type: "choose", payload: { option: 1 } },
      context(2_000, { activePlayers: active }),
    );
    // Both present players chose -> deadline collapses to now. Under the old
    // ctx.players logic (length 3) this would still sit at the full deadline.
    expect(state.deadline).toBe(2_000);

    const advanced = wouldYouRatherModule.onTick!(
      state,
      context(2_000, { activePlayers: active }),
    );
    expect(wouldYouRatherModule.getPhase(advanced)).toBe("reveal");

    const view = wouldYouRatherModule.publicView(
      advanced,
      context(2_000, { activePlayers: active }),
    ) as { totalPlayers: number };
    expect(view.totalPlayers).toBe(2);
  });
});

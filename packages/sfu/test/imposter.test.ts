import { describe, expect, it } from "vitest";
import { imposterModule } from "../server/games/modules/imposter.js";
import { GameMoveError } from "../server/games/types.js";
import type { GameContext, GamePlayer, GameRng } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Pat" },
  { id: "p3", name: "Robin" },
];

// pick() always returns the first element, so setup is fully deterministic:
// word set = Places, secret word = "Airport", imposter = host, starter = host.
const rng: GameRng = {
  next: () => 0,
  int: () => 0,
  shuffle: (items) => items.slice(),
  pick: (items) => items[0],
};

const context = (
  now: number,
  options?: { activePlayers?: GamePlayer[]; roster?: GamePlayer[] },
): GameContext => {
  const roster = options?.roster ?? players;
  return {
    players: roster,
    activePlayers: options?.activePlayers ?? roster,
    rng,
    config: { category: "surprise" },
    content: null,
    now,
    isAdmin: (playerId) => playerId === "host",
  };
};

// Drive lobby -> reveal -> discuss -> vote.
const inVote = (options?: {
  activePlayers?: GamePlayer[];
  roster?: GamePlayer[];
}) => {
  let state = imposterModule.setup(context(0, options));
  state = imposterModule.onMove(
    state,
    { playerId: "host", type: "start", payload: undefined },
    context(1_000, options),
  );
  // Advance past the reveal deadline (start + 6_000ms).
  state = imposterModule.onTick!(state, context(7_100, options));
  expect(imposterModule.getPhase(state)).toBe("discuss");
  state = imposterModule.onMove(
    state,
    { playerId: "host", type: "callVote", payload: undefined },
    context(7_200, options),
  );
  expect(imposterModule.getPhase(state)).toBe("vote");
  return state;
};

describe("imposter game", () => {
  it("starts in lobby and hides the secret word from the public view", () => {
    const state = imposterModule.setup(context(0));
    expect(imposterModule.getPhase(state)).toBe("lobby");
    const view = imposterModule.publicView(state, context(0)) as {
      phase: string;
      category: string;
      totalPlayers: number;
      players: Array<{ id: string }>;
      result: unknown;
    };
    expect(view.phase).toBe("lobby");
    expect(view.category).toBe("Places");
    expect(view.totalPlayers).toBe(3);
    expect(view.players.map((entry) => entry.id)).toEqual(["host", "p2", "p3"]);
    expect(view.result).toBeNull();
    // The word never leaks into the public projection.
    expect(JSON.stringify(view)).not.toContain("Airport");
  });

  it("splits hidden information: crew see the word, the imposter does not", () => {
    const state = imposterModule.onMove(
      imposterModule.setup(context(0)),
      { playerId: "host", type: "start", payload: undefined },
      context(1_000),
    );

    const imposterView = imposterModule.playerView(state, "host", context(1_000)) as {
      role: string;
      word: string | null;
      hint: string | null;
    };
    expect(imposterView.role).toBe("imposter");
    expect(imposterView.word).toBeNull();
    expect(imposterView.hint).not.toBeNull();

    const crewView = imposterModule.playerView(state, "p2", context(1_000)) as {
      role: string;
      word: string | null;
      hint: string | null;
    };
    expect(crewView.role).toBe("crew");
    expect(crewView.word).toBe("Airport");
    expect(crewView.hint).toBeNull();
  });

  it("resolves a crew win when the room votes out the imposter", () => {
    let state = inVote();
    // host is the imposter and cannot vote for itself.
    state = imposterModule.onMove(
      state,
      { playerId: "host", type: "vote", payload: { target: "p2" } },
      context(8_000),
    );
    state = imposterModule.onMove(
      state,
      { playerId: "p2", type: "vote", payload: { target: "host" } },
      context(8_000),
    );
    state = imposterModule.onMove(
      state,
      { playerId: "p3", type: "vote", payload: { target: "host" } },
      context(8_000),
    );

    expect(imposterModule.getPhase(state)).toBe("result");
    const view = imposterModule.publicView(state, context(8_000)) as {
      result: {
        imposterId: string;
        votedOutId: string | null;
        crewWon: boolean;
        tie: boolean;
        word: string;
      } | null;
    };
    expect(view.result).toMatchObject({
      imposterId: "host",
      votedOutId: "host",
      crewWon: true,
      tie: false,
      word: "Airport",
    });
  });

  it("rejects voting for yourself", () => {
    const state = inVote();
    expect(() =>
      imposterModule.onMove(
        state,
        { playerId: "p2", type: "vote", payload: { target: "p2" } },
        context(8_000),
      ),
    ).toThrow("You cannot vote for yourself");
  });

  it("rejects a non-host calling a vote", () => {
    let state = imposterModule.setup(context(0));
    state = imposterModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1_000),
    );
    state = imposterModule.onTick!(state, context(7_100));
    expect(imposterModule.getPhase(state)).toBe("discuss");
    expect(() =>
      imposterModule.onMove(
        state,
        { playerId: "p2", type: "callVote", payload: undefined },
        context(7_200),
      ),
    ).toThrow("Only the host can call a vote");
  });

  it("resolves once every present player votes, ignoring an absent seat", () => {
    // Four seats, but p4 is disconnected: only host, p2, p3 are active.
    const roster: GamePlayer[] = [...players, { id: "p4", name: "Sam" }];
    const active = roster.filter((player) => player.id !== "p4");
    const options = { roster, activePlayers: active };

    let state = inVote(options);
    state = imposterModule.onMove(
      state,
      { playerId: "host", type: "vote", payload: { target: "p2" } },
      context(8_000, options),
    );
    state = imposterModule.onMove(
      state,
      { playerId: "p2", type: "vote", payload: { target: "host" } },
      context(8_000, options),
    );
    // Still voting: not every present player has voted yet.
    expect(imposterModule.getPhase(state)).toBe("vote");

    state = imposterModule.onMove(
      state,
      { playerId: "p3", type: "vote", payload: { target: "host" } },
      context(8_000, options),
    );
    // All three present players voted -> resolves without waiting on the
    // absent p4. Under the old ctx.players logic (length 4) this would stay
    // stuck in the vote phase.
    expect(imposterModule.getPhase(state)).toBe("result");

    const view = imposterModule.publicView(state, context(8_000, options)) as {
      totalPlayers: number;
      result: { crewWon: boolean } | null;
    };
    expect(view.totalPlayers).toBe(3);
    expect(view.result?.crewWon).toBe(true);
  });
});

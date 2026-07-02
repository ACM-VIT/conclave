import { describe, expect, it } from "vitest";
import { bluffModule } from "../server/games/modules/bluff.js";
import type { GameContext, GamePlayer, GameRng } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Pat" },
  { id: "p3", name: "Robin" },
];

// Identity shuffle keeps the prompt bank order: the first prompt is the owls
// prompt whose real answer is "parliament".
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
  config: { rounds: 4 },
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

const started = (activePlayers?: GamePlayer[]) =>
  bluffModule.onMove(
    bluffModule.setup(context(0, { activePlayers })),
    { playerId: "host", type: "start", payload: undefined },
    context(1_000, { activePlayers }),
  );

describe("bluff game", () => {
  it("starts in lobby with a sane initial public view", () => {
    const state = bluffModule.setup(context(0));
    expect(bluffModule.getPhase(state)).toBe("lobby");
    const view = bluffModule.publicView(state, context(0)) as {
      phase: string;
      question: string | null;
      submittedCount: number;
      totalPlayers: number;
      scoreboard: Array<{ id: string; score: number }>;
    };
    expect(view.phase).toBe("lobby");
    expect(view.question).toBeNull();
    expect(view.submittedCount).toBe(0);
    expect(view.totalPlayers).toBe(3);
    expect(view.scoreboard.every((entry) => entry.score === 0)).toBe(true);
  });

  it("scores finding the truth and fooling others deterministically", () => {
    // Only host and p2 are present for this round so the write/choose gates
    // resolve on those two.
    const active: GamePlayer[] = [players[0], players[1]];

    let state = bluffModule.onMove(
      started(active),
      { playerId: "host", type: "submit", payload: { text: "cabinet" } },
      context(2_000, { activePlayers: active }),
    );
    state = bluffModule.onMove(
      state,
      { playerId: "p2", type: "submit", payload: { text: "senate" } },
      context(2_000, { activePlayers: active }),
    );
    // Everyone present has written -> deadline collapses, tick builds options.
    state = bluffModule.onTick!(state, context(2_000, { activePlayers: active }));
    expect(bluffModule.getPhase(state)).toBe("choose");

    const chooseView = bluffModule.publicView(
      state,
      context(2_000, { activePlayers: active }),
    ) as { options: Array<{ id: string; text: string }> };
    const idOf = (text: string) =>
      chooseView.options.find((option) => option.text === text)!.id;
    const truthId = idOf("parliament");
    const hostFakeId = idOf("cabinet");

    // host finds the truth (+1000); p2 falls for host's bluff (host +500).
    state = bluffModule.onMove(
      state,
      { playerId: "host", type: "choose", payload: { optionId: truthId } },
      context(3_000, { activePlayers: active }),
    );
    state = bluffModule.onMove(
      state,
      { playerId: "p2", type: "choose", payload: { optionId: hostFakeId } },
      context(3_000, { activePlayers: active }),
    );
    state = bluffModule.onTick!(state, context(3_000, { activePlayers: active }));

    expect(bluffModule.getPhase(state)).toBe("reveal");
    const revealView = bluffModule.publicView(
      state,
      context(3_000, { activePlayers: active }),
    ) as { scoreboard: Array<{ id: string; score: number }> };
    const byId = Object.fromEntries(
      revealView.scoreboard.map((entry) => [entry.id, entry.score]),
    );
    expect(byId.host).toBe(1_500);
    expect(byId.p2).toBe(0);
  });

  it("rejects submitting the real answer as a bluff", () => {
    expect(() =>
      bluffModule.onMove(
        started(),
        { playerId: "p2", type: "submit", payload: { text: "Parliament" } },
        context(2_000),
      ),
    ).toThrow("That is the real answer. Write a bluff.");
  });

  it("rejects picking your own bluff during the choose phase", () => {
    const active: GamePlayer[] = [players[0], players[1]];
    let state = bluffModule.onMove(
      started(active),
      { playerId: "host", type: "submit", payload: { text: "cabinet" } },
      context(2_000, { activePlayers: active }),
    );
    state = bluffModule.onMove(
      state,
      { playerId: "p2", type: "submit", payload: { text: "senate" } },
      context(2_000, { activePlayers: active }),
    );
    state = bluffModule.onTick!(state, context(2_000, { activePlayers: active }));

    const chooseView = bluffModule.publicView(
      state,
      context(2_000, { activePlayers: active }),
    ) as { options: Array<{ id: string; text: string }> };
    const hostFakeId = chooseView.options.find(
      (option) => option.text === "cabinet",
    )!.id;

    expect(() =>
      bluffModule.onMove(
        state,
        { playerId: "host", type: "choose", payload: { optionId: hostFakeId } },
        context(3_000, { activePlayers: active }),
      ),
    ).toThrow("You cannot pick your own bluff");
  });

  it("collapses the write deadline once every present player submits", () => {
    // p3 holds a seat but is absent; only host and p2 are active.
    const active = players.filter((player) => player.id !== "p3");

    let state = bluffModule.onMove(
      started(active),
      { playerId: "host", type: "submit", payload: { text: "cabinet" } },
      context(2_000, { activePlayers: active }),
    );
    // Still open: one present player has not written yet.
    expect(state.deadline).toBe(1_000 + 40_000);

    state = bluffModule.onMove(
      state,
      { playerId: "p2", type: "submit", payload: { text: "senate" } },
      context(2_000, { activePlayers: active }),
    );
    // Both present players wrote -> deadline collapses to now. Under the old
    // ctx.players logic (length 3) this would still sit at the full deadline.
    expect(state.deadline).toBe(2_000);

    state = bluffModule.onTick!(state, context(2_000, { activePlayers: active }));
    expect(bluffModule.getPhase(state)).toBe("choose");

    const view = bluffModule.publicView(
      state,
      context(2_000, { activePlayers: active }),
    ) as { totalPlayers: number };
    expect(view.totalPlayers).toBe(2);
  });

  it("collapses the choose deadline once every present player picks", () => {
    const active = players.filter((player) => player.id !== "p3");
    let state = bluffModule.onMove(
      started(active),
      { playerId: "host", type: "submit", payload: { text: "cabinet" } },
      context(2_000, { activePlayers: active }),
    );
    state = bluffModule.onMove(
      state,
      { playerId: "p2", type: "submit", payload: { text: "senate" } },
      context(2_000, { activePlayers: active }),
    );
    state = bluffModule.onTick!(state, context(2_000, { activePlayers: active }));
    expect(bluffModule.getPhase(state)).toBe("choose");
    const chooseDeadline = state.deadline;

    const chooseView = bluffModule.publicView(
      state,
      context(2_000, { activePlayers: active }),
    ) as { options: Array<{ id: string; text: string }> };
    const truthId = chooseView.options.find(
      (option) => option.text === "parliament",
    )!.id;

    state = bluffModule.onMove(
      state,
      { playerId: "host", type: "choose", payload: { optionId: truthId } },
      context(3_000, { activePlayers: active }),
    );
    // Not everyone present has chosen yet.
    expect(state.deadline).toBe(chooseDeadline);

    state = bluffModule.onMove(
      state,
      { playerId: "p2", type: "choose", payload: { optionId: truthId } },
      context(3_000, { activePlayers: active }),
    );
    // Both present players chose -> collapse to now.
    expect(state.deadline).toBe(3_000);
  });
});

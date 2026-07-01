import { describe, expect, it } from "vitest";
import { triviaModule } from "../server/games/modules/trivia.js";
import { GameMoveError } from "../server/games/types.js";
import type { GameContext, GamePlayer, GameRng } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Pat" },
  { id: "p3", name: "Robin" },
];

// Identity shuffle keeps the question bank and option order deterministic, so
// the first question is Geography ("Canada" first, correctIndex 0).
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
  config: { questions: 3, pace: "normal" },
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

const started = (activePlayers?: GamePlayer[]) =>
  triviaModule.onMove(
    triviaModule.setup(context(0, { activePlayers })),
    { playerId: "host", type: "start", payload: undefined },
    context(1_000, { activePlayers }),
  );

describe("trivia game", () => {
  it("starts in lobby with a sane initial public view", () => {
    const state = triviaModule.setup(context(0));
    expect(triviaModule.getPhase(state)).toBe("lobby");
    const view = triviaModule.publicView(state, context(0)) as {
      phase: string;
      prompt: string | null;
      totalQuestions: number;
      answeredCount: number;
      totalPlayers: number;
      scoreboard: Array<{ id: string; score: number }>;
    };
    expect(view.phase).toBe("lobby");
    expect(view.prompt).toBeNull();
    expect(view.totalQuestions).toBe(3);
    expect(view.answeredCount).toBe(0);
    expect(view.totalPlayers).toBe(3);
    expect(view.scoreboard.every((entry) => entry.score === 0)).toBe(true);
  });

  it("scores correct answers with a deterministic speed bonus", () => {
    // questionStart is 1_000, question length 20_000ms. Answering the correct
    // option (index 0) at now=2_000 uses 1_000ms, ratio 0.95 -> 500 + 475.
    let state = triviaModule.onMove(
      started(),
      { playerId: "host", type: "answer", payload: { choice: 0 } },
      context(2_000),
    );
    // A wrong answer earns nothing.
    state = triviaModule.onMove(
      state,
      { playerId: "p2", type: "answer", payload: { choice: 1 } },
      context(2_000),
    );
    // Move into the reveal so scoring has been applied.
    state = triviaModule.onMove(
      state,
      { playerId: "host", type: "skip", payload: undefined },
      context(3_000),
    );
    state = triviaModule.onTick!(state, context(3_000));

    expect(triviaModule.getPhase(state)).toBe("reveal");
    const view = triviaModule.publicView(state, context(3_000)) as {
      correctIndex: number | null;
      scoreboard: Array<{ id: string; score: number }>;
    };
    expect(view.correctIndex).toBe(0);
    const byId = Object.fromEntries(
      view.scoreboard.map((entry) => [entry.id, entry.score]),
    );
    expect(byId.host).toBe(975);
    expect(byId.p2).toBe(0);
    expect(byId.p3).toBe(0);
  });

  it("rejects answering outside the question phase", () => {
    const lobby = triviaModule.setup(context(0));
    expect(() =>
      triviaModule.onMove(
        lobby,
        { playerId: "host", type: "answer", payload: { choice: 0 } },
        context(500),
      ),
    ).toThrow(GameMoveError);
  });

  it("rejects a duplicate answer from the same player", () => {
    const state = triviaModule.onMove(
      started(),
      { playerId: "p2", type: "answer", payload: { choice: 0 } },
      context(2_000),
    );
    expect(() =>
      triviaModule.onMove(
        state,
        { playerId: "p2", type: "answer", payload: { choice: 1 } },
        context(2_100),
      ),
    ).toThrow("You already answered");
  });

  it("advances early once every present player answers, ignoring an absent seat", () => {
    // p3 holds a seat but is disconnected: only host and p2 are active.
    const active = players.filter((player) => player.id !== "p3");

    let state = triviaModule.onMove(
      started(active),
      { playerId: "host", type: "answer", payload: { choice: 0 } },
      context(2_000, { activePlayers: active }),
    );
    // Still open: not everyone present has answered yet.
    expect(state.deadline).toBe(21_000);

    state = triviaModule.onMove(
      state,
      { playerId: "p2", type: "answer", payload: { choice: 0 } },
      context(2_000, { activePlayers: active }),
    );
    // Both present players answered -> deadline collapses to now without
    // waiting on the absent p3. Under the old ctx.players logic (length 3)
    // this would still sit at 21_000.
    expect(state.deadline).toBe(2_000);

    const advanced = triviaModule.onTick!(
      state,
      context(2_000, { activePlayers: active }),
    );
    expect(triviaModule.getPhase(advanced)).toBe("reveal");

    const view = triviaModule.publicView(
      advanced,
      context(2_000, { activePlayers: active }),
    ) as { totalPlayers: number };
    expect(view.totalPlayers).toBe(2);
  });

  it("does not count an absent player's old answer as a present player's answer", () => {
    let state = triviaModule.onMove(
      started(),
      { playerId: "p3", type: "answer", payload: { choice: 0 } },
      context(2_000),
    );
    expect(state.deadline).toBe(21_000);

    const active = players.filter((player) => player.id !== "p3");
    state = triviaModule.onMove(
      state,
      { playerId: "host", type: "answer", payload: { choice: 0 } },
      context(2_500, { activePlayers: active }),
    );

    // p3 answered before disconnecting, but p2 is still present and unanswered.
    // The deadline must stay open until every present player has answered.
    expect(state.deadline).toBe(21_000);

    state = triviaModule.onMove(
      state,
      { playerId: "p2", type: "answer", payload: { choice: 0 } },
      context(3_000, { activePlayers: active }),
    );
    expect(state.deadline).toBe(3_000);
  });
});

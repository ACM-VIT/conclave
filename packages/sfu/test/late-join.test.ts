import { describe, expect, it } from "vitest";
import { GameSession } from "../server/games/engine.js";
import { triviaModule } from "../server/games/modules/trivia.js";
import { imposterModule } from "../server/games/modules/imposter.js";
import { wordleModule } from "../server/games/modules/wordle.js";
import type { GamePlayer } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "p2", name: "Player Two" },
];

const startedTriviaSession = (): GameSession => {
  const session = new GameSession({
    module: triviaModule,
    players,
    adminIds: ["host"],
    hostId: "host",
    config: { questions: 3, pace: "normal" },
    seed: 7,
  });
  expect(session.applyMove("host", "start", undefined)).toEqual({ ok: true });
  return session;
};

/**
 * Drive every seated player through an answer, then tick through the reveal
 * into the next question. `applyMove` stamps deadlines with the real clock, so
 * the ticks ride real-time offsets rather than synthetic timestamps.
 */
const advanceToNextQuestion = (session: GameSession): void => {
  for (const player of session.getPublicState().players) {
    const result = session.applyMove(player.id, "answer", { choice: 0 });
    expect(result.ok).toBe(true);
  }
  // Everyone answered, so the question deadline collapsed to now; tick into
  // reveal, then tick far past the reveal deadline into the next question.
  session.tick(Date.now() + 1_000);
  session.tick(Date.now() + 60_000);
};

const lobbySession = (module: typeof triviaModule | typeof imposterModule, roster: GamePlayer[] = players): GameSession =>
  new GameSession({
    module,
    players: roster,
    adminIds: ["host"],
    hostId: "host",
    config: {},
    seed: 7,
  });

describe("lobby seats", () => {
  it("seats a lobby joiner at once instead of queueing them", () => {
    const session = lobbySession(triviaModule);
    expect(session.getPublicState(0).phase).toBe("lobby");

    expect(session.requestSeat({ id: "late", name: "Late Joiner" })).toEqual({ ok: true });
    expect(session.hasPlayer("late")).toBe(true);
    expect(session.hasPendingPlayer("late")).toBe(false);
    const state = session.getPublicState(0);
    expect(state.pendingJoiners).toEqual([]);
    expect(state.players.map((p) => p.id)).toEqual(["host", "p2", "late"]);

    expect(session.applyMove("host", "start", undefined)).toEqual({ ok: true });
    expect(session.applyMove("late", "answer", { choice: 0 }).ok).toBe(true);
  });

  it("lets a lobby joiner into games without mid-game join", () => {
    const session = lobbySession(imposterModule);
    expect(session.requestSeat({ id: "p3", name: "Player Three" })).toEqual({ ok: true });
    expect(session.getPublicState(0).players.map((p) => p.id)).toEqual(["host", "p2", "p3"]);
    expect(session.applyMove("host", "start", undefined).ok).toBe(true);
  });

  it("still refuses a lobby seat once the game is full", () => {
    const full: GamePlayer[] = Array.from({ length: imposterModule.maxPlayers }, (_, index) => ({
      id: index === 0 ? "host" : `p${index}`,
      name: `Player ${index}`,
    }));
    const session = lobbySession(imposterModule, full);
    expect(session.requestSeat({ id: "extra", name: "Extra" })).toEqual({ ok: false, error: "Game is full" });
  });
});

describe("late-join seats", () => {
  it("queues a joiner and seats them when the next question starts", () => {
    const session = startedTriviaSession();

    const result = session.requestSeat({ id: "late", name: "Late Joiner" });
    expect(result).toEqual({ ok: true });
    expect(session.hasPlayer("late")).toBe(false);
    expect(session.hasPendingPlayer("late")).toBe(true);

    const before = session.getPublicState(0);
    expect(before.pendingJoiners.map((p) => p.id)).toEqual(["late"]);
    expect(before.players.map((p) => p.id)).toEqual(["host", "p2"]);

    advanceToNextQuestion(session);

    const after = session.getPublicState(0);
    expect(after.phase).toBe("question");
    expect(after.pendingJoiners).toEqual([]);
    expect(after.players.map((p) => p.id)).toEqual(["host", "p2", "late"]);
    expect(session.hasPlayer("late")).toBe(true);

    // The new seat plays this round like anyone else.
    expect(session.applyMove("late", "answer", { choice: 1 }).ok).toBe(true);
  });

  it("does not seat a joiner mid-round", () => {
    const session = startedTriviaSession();
    session.requestSeat({ id: "late", name: "Late Joiner" });

    // A single answer does not end the round, so no boundary is crossed.
    expect(session.applyMove("host", "answer", { choice: 0 }).ok).toBe(true);
    expect(session.hasPlayer("late")).toBe(false);
    expect(session.getPublicState(0).pendingJoiners.length).toBe(1);
  });

  it("rejects seats beyond maxPlayers, counting pending joiners", () => {
    const bigRoster: GamePlayer[] = Array.from(
      { length: triviaModule.maxPlayers },
      (_, index) => ({ id: `p${index}`, name: `Player ${index}` }),
    );
    const session = new GameSession({
      module: triviaModule,
      players: bigRoster,
      adminIds: ["p0"],
      hostId: "p0",
      config: { questions: 3, pace: "normal" },
      seed: 7,
    });
    const result = session.requestSeat({ id: "overflow", name: "Overflow" });
    expect(result).toEqual({ ok: false, error: "Game is full" });
  });

  it("is idempotent for a joiner who asks twice", () => {
    const session = startedTriviaSession();
    expect(session.requestSeat({ id: "late", name: "Late" })).toEqual({ ok: true });
    expect(session.requestSeat({ id: "late", name: "Late" })).toEqual({ ok: true });
    expect(session.getPublicState(0).pendingJoiners.length).toBe(1);
  });

  it("drops pending joiners who leave before the next boundary", () => {
    const session = startedTriviaSession();

    expect(session.requestSeat({ id: "late", name: "Late Joiner" })).toEqual({
      ok: true,
    });
    session.updateRoomMembership({ players, adminIds: ["host"] });

    expect(session.hasPendingPlayer("late")).toBe(false);
    expect(session.getPublicState(0).pendingJoiners).toEqual([]);

    advanceToNextQuestion(session);

    expect(session.hasPlayer("late")).toBe(false);
    expect(session.getPublicState(0).players.map((p) => p.id)).toEqual([
      "host",
      "p2",
    ]);
  });

  it("rejects joining games without late-join support", () => {
    const session = new GameSession({
      module: imposterModule,
      players: [
        { id: "host", name: "Host" },
        { id: "p2", name: "P2" },
        { id: "p3", name: "P3" },
      ],
      adminIds: ["host"],
      hostId: "host",
      config: {},
      seed: 7,
    });
    expect(session.applyMove("host", "start", undefined).ok).toBe(true);
    const result = session.requestSeat({ id: "late", name: "Late" });
    expect(result).toEqual({ ok: false, error: "This game does not support joining mid-game" });
  });

  it("exposes canJoinLate on the public state", () => {
    const session = startedTriviaSession();
    expect(session.getPublicState(0).canJoinLate).toBe(true);
  });

  it("does not advertise late join for random Wordle rounds", () => {
    const session = new GameSession({
      module: wordleModule,
      players,
      adminIds: ["host"],
      hostId: "host",
      config: { wordSource: "random", rounds: 2, timeLimitMinutes: 1 },
      seed: 7,
    });

    expect(session.applyMove("host", "start", undefined)).toEqual({ ok: true });
    expect(session.getPublicState(0).canJoinLate).toBe(false);
    expect(session.requestSeat({ id: "late", name: "Late" })).toEqual({
      ok: false,
      error: "This game does not support joining mid-game",
    });
  });
});

describe("spectating", () => {
  it("gives spectators a neutral trivia view with no secrets", () => {
    const session = startedTriviaSession();
    expect(session.spectatable).toBe(true);
    const view = session.getPlayerView("stranger", 0) as {
      answered: boolean;
      choice: number | null;
      score: number;
    };
    expect(view.answered).toBe(false);
    expect(view.choice).toBeNull();
    expect(view.score).toBe(0);
  });

  it("marks imposter as not spectatable", () => {
    expect(imposterModule.spectatable).toBe(false);
  });
});

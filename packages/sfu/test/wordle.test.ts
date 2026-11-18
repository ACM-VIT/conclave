import { describe, expect, it } from "vitest";
import { GameSession } from "../server/games/engine.js";
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
  players,
  activePlayers: options?.currentPlayers ?? players,
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
  it("recovers a disconnected setter through live game session membership", () => {
    const session = new GameSession({
      module: wordleModule,
      players,
      adminIds: ["host"],
      hostId: "host",
      config: { timeLimitMinutes: 3, wordSource: "setter", rounds: 1 },
      seed: 1,
    });

    expect(session.applyMove("host", "start", undefined)).toEqual({ ok: true });
    expect(session.getPublicState(1_000).view).toMatchObject({
      phase: "set-word",
      setterId: "setter",
    });

    const remainingPlayers = players.filter((player) => player.id !== "setter");
    session.updateRoomMembership({
      players: remainingPlayers,
      adminIds: ["host"],
    });

    expect(session.tick(1_500)).toBe(true);
    expect(session.getPublicState(1_500).view).toMatchObject({
      phase: "set-word",
      setterId: "host",
    });
    expect(session.getPlayerView("host", 1_500)).toMatchObject({
      currentRound: 1,
      canSetWord: true,
      isSetter: true,
    });

    expect(session.applyMove("host", "setWord", { word: "AALII" })).toEqual({
      ok: true,
    });
    const publicView = session.getPublicState(2_000).view as {
      phase: string;
      standings: Array<{ playerId: string }>;
    };
    expect(publicView.phase).toBe("playing");
    expect(publicView.standings.map((entry) => entry.playerId)).toEqual([
      "guesser",
    ]);
  });

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
      currentRound: 1,
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
    expect(Object.keys(state.players)).toEqual(["host"]);
    expect(publicView.standings.map((entry) => entry.playerId)).toEqual(["host"]);
  });
});

describe("wordle team modes", () => {
  const team: GamePlayer[] = [
    { id: "host", name: "Host" },
    { id: "ana", name: "Ana" },
    { id: "ben", name: "Ben" },
  ];

  const session = (mode: "relay" | "huddle", extra: Record<string, number | string> = {}) =>
    new GameSession({
      module: wordleModule,
      players: team,
      adminIds: ["host"],
      hostId: "host",
      config: { mode, wordSource: "setter", rounds: 2, timeLimitMinutes: 3, turnSeconds: 20, ...extra },
      seed: 1,
    });

  type TeamPublic = {
    phase: string;
    mode: string;
    team: {
      guesses: Array<{ word: string; byId: string; byName: string }>;
      outcome: string | null;
      solvedByName: string | null;
      members: Array<{ playerId: string }>;
      currentTurnId: string | null;
      nextTurnId: string | null;
      turnDeadline: number | null;
    } | null;
    scores: Array<{ playerId: string; score: number }>;
    result: { winnerId: string | null } | null;
  };

  const pub = (s: GameSession, now = 0) => s.getPublicState(now).view as TeamPublic;

  /** Starts a setter round where the seeded setter picks AALII. */
  const startRound = (s: GameSession) => {
    expect(s.applyMove("host", "start", undefined)).toEqual({ ok: true });
    const setterId = (s.getPublicState(0).view as { setterId: string }).setterId;
    expect(s.applyMove(setterId, "setWord", { word: "AALII" })).toEqual({ ok: true });
    return setterId;
  };

  it("takes turns on one shared board and blocks out-of-turn guesses", () => {
    const s = session("relay");
    const setterId = startRound(s);
    const view = pub(s);
    expect(view.mode).toBe("relay");
    const order = view.team!.members.map((member) => member.playerId);
    expect(order).not.toContain(setterId);
    expect(order).toHaveLength(2);
    const [first, second] = order;
    expect(view.team!.currentTurnId).toBe(first);
    expect(view.team!.nextTurnId).toBe(second);

    expect(s.applyMove(second, "guess", { word: "ABACK" })).toMatchObject({ ok: false });
    expect(s.getPlayerView(second, 0)).toMatchObject({ canGuess: false, isMyTurn: false });
    expect(s.getPlayerView(first, 0)).toMatchObject({ canGuess: true, isMyTurn: true });

    expect(s.applyMove(first, "guess", { word: "ABACK" })).toEqual({ ok: true });
    expect(pub(s).team!.currentTurnId).toBe(second);
    // Both teammates see the same rows.
    expect(s.getPlayerView(second, 0)).toMatchObject({
      myGuesses: [{ word: "ABACK" }],
      canGuess: true,
    });
    expect(s.applyMove(second, "guess", { word: "ABACK" })).toEqual({
      ok: false,
      error: "Your team already guessed that word",
    });

    expect(s.applyMove(second, "guess", { word: "AALII" })).toEqual({ ok: true });
    const done = pub(s);
    expect(done.phase).toBe("results");
    expect(done.team!.outcome).toBe("win");
    expect(done.result!.winnerId).toBe(second);
    // Two rows used out of six: every teammate banks 5, the setter nothing.
    const scores = Object.fromEntries(done.scores.map((entry) => [entry.playerId, entry.score]));
    expect(scores[first]).toBe(5);
    expect(scores[second]).toBe(5);
    expect(scores[setterId]).toBeUndefined();
  });

  it("lets the current guesser pass, and passes the turn when the timer runs out", () => {
    const s = session("relay");
    startRound(s);
    const [first, second] = pub(s).team!.members.map((member) => member.playerId);

    expect(s.applyMove(second, "passTurn", undefined)).toMatchObject({ ok: false });
    expect(s.applyMove(first, "passTurn", undefined)).toEqual({ ok: true });
    expect(pub(s).team!.currentTurnId).toBe(second);

    const deadline = pub(s).team!.turnDeadline!;
    expect(s.tick(deadline + 1)).toBe(true);
    expect(pub(s, deadline + 1).team!.currentTurnId).toBe(first);
    expect(pub(s, deadline + 1).team!.guesses).toHaveLength(0);
  });

  it("skips a disconnected teammate's turn after a short grace window", () => {
    const s = session("relay");
    startRound(s);
    const [first, second] = pub(s).team!.members.map((member) => member.playerId);
    s.updateRoomMembership({
      players: team.filter((player) => player.id !== first),
      adminIds: ["host"],
    });
    // First tick only notes the absence; a quick reconnect keeps the turn.
    expect(s.tick(1_000)).toBe(true);
    expect(pub(s, 1_000).team!.currentTurnId).toBe(first);
    expect(s.tick(3_000)).toBe(false);
    expect(s.tick(6_500)).toBe(true);
    expect(pub(s, 6_500).team!.currentTurnId).toBe(second);
  });

  it("keeps the turn when the guesser reconnects within the grace window", () => {
    const s = session("relay");
    startRound(s);
    const [first] = pub(s).team!.members.map((member) => member.playerId);
    s.updateRoomMembership({
      players: team.filter((player) => player.id !== first),
      adminIds: ["host"],
    });
    expect(s.tick(1_000)).toBe(true);
    s.updateRoomMembership({ players: team, adminIds: ["host"] });
    expect(s.tick(2_000)).toBe(true);
    expect(s.tick(7_000)).toBe(false);
    expect(pub(s, 7_000).team!.currentTurnId).toBe(first);
    expect(s.applyMove(first, "guess", { word: "ABACK" })).toEqual({ ok: true });
  });

  it("stays quiet instead of rotating when no teammate is connected", () => {
    const s = session("relay");
    const setterId = startRound(s);
    const before = pub(s).team!.currentTurnId;
    s.updateRoomMembership({
      players: team.filter((player) => player.id === setterId),
      adminIds: ["host"],
    });
    for (const now of [500, 1_000, 30_000, 60_000, 100_000]) {
      expect(s.tick(now)).toBe(false);
    }
    expect(pub(s, 100_000).team!.currentTurnId).toBe(before);
  });

  it("refuses a pass when nobody else is around to take the turn", () => {
    const s = session("relay");
    const setterId = startRound(s);
    const [first, second] = pub(s).team!.members.map((member) => member.playerId);
    s.updateRoomMembership({
      players: team.filter((player) => player.id !== second),
      adminIds: ["host"],
    });
    expect(s.applyMove(first, "passTurn", undefined)).toEqual({
      ok: false,
      error: "No teammate is around to take the turn",
    });
    expect(pub(s).team!.nextTurnId).toBeNull();
    expect(setterId).not.toBe(first);
  });

  it("mirrors the shared board into the setter's boards for older clients", () => {
    const s = session("relay");
    const setterId = startRound(s);
    const [first] = pub(s).team!.members.map((member) => member.playerId);
    expect(s.applyMove(first, "guess", { word: "ABACK" })).toEqual({ ok: true });
    const view = s.getPlayerView(setterId, 0) as {
      boards: Array<{ playerId: string; guesses: Array<{ word: string }> }>;
    };
    expect(view.boards).toHaveLength(1);
    expect(view.boards[0].guesses.map((guess) => guess.word)).toEqual(["ABACK"]);
    expect(view.boards[0].playerId).toBe(pub(s).team!.currentTurnId);
  });

  it("lets anyone on the team guess at any time in huddle mode", () => {
    const s = session("huddle");
    startRound(s);
    const [first, second] = pub(s).team!.members.map((member) => member.playerId);
    expect(pub(s).team!.currentTurnId).toBeNull();
    expect(s.applyMove(first, "guess", { word: "ABACK" })).toEqual({ ok: true });
    expect(s.applyMove(first, "guess", { word: "ABASE" })).toEqual({ ok: true });
    expect(s.applyMove(second, "guess", { word: "ABATE" })).toEqual({ ok: true });
    expect(pub(s).team!.guesses.map((guess) => guess.byId)).toEqual([first, first, second]);
    expect(s.applyMove(first, "passTurn", undefined)).toMatchObject({ ok: false });
  });

  it("ends a team round as a loss after six misses", () => {
    const s = session("huddle");
    startRound(s);
    const [first] = pub(s).team!.members.map((member) => member.playerId);
    for (const word of ["ABACK", "ABASE", "ABATE", "ABBEY", "ABBOT", "ABHOR"]) {
      expect(s.applyMove(first, "guess", { word })).toEqual({ ok: true });
    }
    expect(pub(s)).toMatchObject({ phase: "results", team: { outcome: "lose" }, result: { winnerId: null } });
  });

  it("keeps rotating the opening turn into the next round", () => {
    const s = session("relay", { wordSource: "random" });
    expect(s.applyMove("host", "start", undefined)).toEqual({ ok: true });
    const order = pub(s).team!.members.map((member) => member.playerId);
    expect(order).toEqual(["host", "ana", "ben"]);
    expect(s.applyMove("host", "guess", { word: "ABACK" })).toEqual({ ok: true });
    const deadline = (s.getPublicState(0).view as { deadline: number }).deadline;
    expect(s.tick(deadline + 1)).toBe(true);
    expect(pub(s, deadline + 1).team!.outcome).toBe("timeout");
    expect(s.applyMove("host", "nextRound", undefined)).toEqual({ ok: true });
    expect(pub(s).team!.currentTurnId).toBe("ana");
  });
});

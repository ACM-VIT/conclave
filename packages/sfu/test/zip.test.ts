import { describe, expect, it } from "vitest";
import { zipModule } from "../server/games/modules/zip.js";
import type { GameContext, GamePlayer, GameRng } from "../server/games/types.js";

const players: GamePlayer[] = [
  { id: "host", name: "Host" },
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
];

const rng = (pickIndex = 0): GameRng => ({
  next: () => 0.5,
  int: (max) => pickIndex % max,
  shuffle: (items) => items.slice(),
  pick: (items) => items[pickIndex % items.length] ?? items[0],
});

const context = (
  now: number,
  options?: { currentPlayers?: GamePlayer[]; pickIndex?: number },
): GameContext => ({
  players,
  activePlayers: options?.currentPlayers ?? players,
  rng: rng(options?.pickIndex),
  config: { gridSize: "6", rounds: 1 },
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

const completeRound = (
  state: ReturnType<typeof zipModule.setup>,
  now: number,
  getContext: (currentNow: number) => GameContext = context,
) => {
  let completed = state;
  for (const [index, playerId] of ["host", "alice", "bob"].entries()) {
    completed = zipModule.onMove(
      completed,
      { playerId, type: "move", payload: { cells: completed.solutionPath } },
      getContext(now + index),
    );
  }
  return completed;
};

describe("zip game module", () => {
  it("starts in lobby phase", () => {
    const state = zipModule.setup(context(0));
    expect(state.phase).toBe("lobby");
    expect(zipModule.getPhase(state)).toBe("lobby");
  });

  it("does not expose a configurable time limit", () => {
    expect(zipModule.options?.some((option) => option.id === "timeLimitMinutes")).toBe(false);
  });

  it("rejects start from non-admin", () => {
    const state = zipModule.setup(context(0));
    expect(() =>
      zipModule.onMove(
        state,
        { playerId: "alice", type: "start", payload: undefined },
        context(1000),
      ),
    ).toThrow("Only the host can start");
  });

  it("transitions to playing on start", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    expect(playing.phase).toBe("playing");
    expect(playing.gridSize).toBe(6);
    expect(Object.keys(playing.anchors).length).toBeGreaterThanOrEqual(2);
    expect(playing.solutionPath.length).toBeGreaterThan(0);
    expect(playing.currentRound).toBe(1);
    expect(playing.roundStartedAt).toBe(1000);
  });

  it("creates player boards for all active players", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    expect(Object.keys(playing.players)).toEqual(["host", "alice", "bob"]);
    for (const board of Object.values(playing.players)) {
      expect(board.path.length).toBe(1);
      expect(board.outcome).toBeNull();
      expect(board.hintsUsed).toBe(0);
    }
  });

  it("accepts valid move with full path update", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    const solution = playing.solutionPath;

    // Send first two cells of the solution.
    const cells = [solution[0], solution[1]];
    const afterMove = zipModule.onMove(
      playing,
      { playerId: "alice", type: "move", payload: { cells } },
      context(2000),
    );
    expect(afterMove.players["alice"].path.length).toBe(2);
  });

  it("rejects move when path doesn't start at anchor 1", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    const solution = playing.solutionPath;
    expect(() =>
      zipModule.onMove(
        playing,
        {
          playerId: "alice",
          type: "move",
          payload: { cells: [solution[1]] },
        },
        context(2000),
      ),
    ).toThrow("anchor 1");
  });

  it("rejects non-numeric cell payloads", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );

    expect(() =>
      zipModule.onMove(
        playing,
        {
          playerId: "alice",
          type: "move",
          payload: { cells: [{ row: 0, col: 0 }] },
        },
        context(2000),
      ),
    ).toThrow("valid cell IDs");
  });

  it("detects a win when the solution path is submitted", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    const solution = playing.solutionPath;

    // Submit the full solution for alice.
    const afterWin = zipModule.onMove(
      playing,
      { playerId: "alice", type: "move", payload: { cells: solution } },
      context(2000),
    );
    expect(afterWin.players["alice"].outcome).toBe("win");
    expect(afterWin.players["alice"].solvedAt).toBe(2000);
  });

  it("resets a player's path to anchor 1", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    const solution = playing.solutionPath;
    const partial = zipModule.onMove(
      playing,
      { playerId: "alice", type: "move", payload: { cells: [solution[0], solution[1]] } },
      context(2000),
    );
    const reset = zipModule.onMove(
      partial,
      { playerId: "alice", type: "reset", payload: undefined },
      context(3000),
    );
    expect(reset.players["alice"].path.length).toBe(1);
    expect(reset.players["alice"].path[0]).toEqual(solution[0]);
  });

  it("increments hintsUsed on hint move", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    const afterHint = zipModule.onMove(
      playing,
      { playerId: "alice", type: "hint", payload: undefined },
      context(2000),
    );
    expect(afterHint.players["alice"].hintsUsed).toBe(1);
    expect(afterHint.players["alice"].path.length).toBeGreaterThan(1);
    expect(afterHint.players["alice"].hintAvailableAt).toBe(5000);
  });

  it("enforces a three-second cooldown between hints", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    const firstHint = zipModule.onMove(
      playing,
      { playerId: "alice", type: "hint", payload: undefined },
      context(2000),
    );

    expect(() =>
      zipModule.onMove(
        firstHint,
        { playerId: "alice", type: "hint", payload: undefined },
        context(4999),
      ),
    ).toThrow("Hint available in 1s");

    const secondHint = zipModule.onMove(
      firstHint,
      { playerId: "alice", type: "hint", payload: undefined },
      context(5000),
    );
    expect(secondHint.players["alice"].hintsUsed).toBe(2);
  });

  it("moves straight to results when a hint completes the final player path", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    const solution = playing.solutionPath;
    const withAliceFinished = zipModule.onMove(
      playing,
      { playerId: "alice", type: "move", payload: { cells: solution } },
      context(2000),
    );
    const withBobFinished = zipModule.onMove(
      withAliceFinished,
      { playerId: "bob", type: "move", payload: { cells: solution } },
      context(3000),
    );
    const almostDone = {
      ...withBobFinished,
      players: {
        ...withBobFinished.players,
        host: {
          ...withBobFinished.players.host,
          path: solution.slice(0, -1),
        },
      },
    };

    const completed = zipModule.onMove(
      almostDone,
      { playerId: "host", type: "hint", payload: undefined },
      context(4000),
    );

    expect(completed.players.host.outcome).toBe("win");
    expect(completed.phase).toBe("results");
  });

  it("does not end the round after arbitrary elapsed time", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );

    const stillPlaying = zipModule.onTick!(playing, context(playing.roundStartedAt + 3_600_000));
    expect(stillPlaying.phase).toBe("playing");
    for (const board of Object.values(stillPlaying.players)) {
      expect(board.outcome).toBeNull();
    }
  });

  it("supports nextRound for multi-round games", () => {
    const ctx = (now: number): GameContext => ({
      players,
      activePlayers: players,
      rng: rng(),
      config: { gridSize: "6", rounds: 3 },
      content: null,
      now,
      isAdmin: (playerId) => playerId === "host",
    });

    const state = zipModule.setup(ctx(0));
    const r1 = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      ctx(1000),
    );
    expect(r1.currentRound).toBe(1);
    expect(r1.totalRounds).toBe(3);

    const r1Done = completeRound(r1, 2000, ctx);
    expect(r1Done.phase).toBe("results");

    // Advance to round 2.
    const r2 = zipModule.onMove(
      r1Done,
      { playerId: "host", type: "nextRound", payload: undefined },
      ctx(5000),
    );
    expect(r2.phase).toBe("playing");
    expect(r2.currentRound).toBe(2);
  });

  it("rejects nextRound when all rounds are complete", () => {
    const ctx = (now: number): GameContext => ({
      players,
      activePlayers: players,
      rng: rng(),
      config: { gridSize: "6", rounds: 1 },
      content: null,
      now,
      isAdmin: (playerId) => playerId === "host",
    });

    const state = zipModule.setup(ctx(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      ctx(1000),
    );
    const done = completeRound(playing, 2000, ctx);

    expect(() =>
      zipModule.onMove(
        done,
        { playerId: "host", type: "nextRound", payload: undefined },
        ctx(5000),
      ),
    ).toThrow("All rounds are complete");
  });

  it("isFinished returns true only when final round results are reached", () => {
    const state = zipModule.setup(context(0));
    expect(zipModule.isFinished!(state)).toBe(false);

    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );
    expect(zipModule.isFinished!(playing)).toBe(false);

    const done = completeRound(playing, 2000);
    expect(done.phase).toBe("results");
    expect(zipModule.isFinished!(done)).toBe(true); // 1 round, final
  });

  it("publicView exposes the client puzzle contract without the solution during play", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );

    const pub = zipModule.publicView(playing, context(2000)) as {
      phase: string;
      anchors: Record<string, number>;
      barriers: Array<{ from: number; to: number }>;
      deadCells: number[];
      roundStartedAt: number;
      standings: Array<{ playerId: string; cellsFilled: number }>;
      result: unknown;
    };
    expect(pub.phase).toBe("playing");
    expect(Object.values(pub.anchors)).toContain(1);
    expect(Array.isArray(pub.barriers)).toBe(true);
    expect(Array.isArray(pub.deadCells)).toBe(true);
    expect(pub.roundStartedAt).toBe(1000);
    expect(pub.standings.length).toBe(3);
    expect(pub.result).toBeNull(); // Solution not revealed during play.
  });

  it("playerView reveals only the player's own path", () => {
    const state = zipModule.setup(context(0));
    const playing = zipModule.onMove(
      state,
      { playerId: "host", type: "start", payload: undefined },
      context(1000),
    );

    const view = zipModule.playerView(playing, "alice", context(2000)) as {
      path: Array<number>;
      outcome: string | null;
      hintsUsed: number;
      hintAvailableAt: number;
    };
    expect(view.path.length).toBe(1);
    expect(view.outcome).toBeNull();
    expect(view.hintsUsed).toBe(0);
    expect(view.hintAvailableAt).toBe(0);
  });
});

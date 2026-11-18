import { describe, expect, it } from "vitest";
import {
  longShotModule,
  parseLongShotPrompts,
} from "../server/games/modules/longShot.js";
import {
  LONG_SHOT_BANK,
  compilePrompt,
  matchAnswer,
  normalizeAnswer,
} from "../server/games/longShotBank.js";
import { GameMoveError } from "../server/games/types.js";
import type { GameConfig, GameContext, GamePlayer, GameRng } from "../server/games/types.js";

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
  options: { config?: GameConfig; activePlayers?: GamePlayer[]; roster?: GamePlayer[] } = {},
): GameContext => ({
  players: options.roster ?? players,
  activePlayers: options.activePlayers ?? options.roster ?? players,
  rng,
  config: options.config ?? { mode: "classic", prompts: 3, lives: 2, pace: "normal" },
  content: null,
  now,
  isAdmin: (playerId) => playerId === "host",
});

type PublicView = Record<string, unknown> & {
  phase: string;
  prompt: string | null;
  turnPlayerId: string | null;
  scoreboard: { id: string; score: number }[];
  results: { id: string; answer: string | null; points: number }[];
  seats: { id: string; lives: number; meter: number; out: boolean }[];
  tiles: Record<string, Record<string, unknown>>;
};
type PlayerView = Record<string, unknown> & {
  answer: { text: string; tier: string; points: number } | null;
  locked: boolean;
  yourTurn: boolean;
};

const pub = (state: ReturnType<typeof longShotModule.setup>, now = 0, opts = {}) =>
  longShotModule.publicView(state, context(now, opts)) as PublicView;
const me = (state: ReturnType<typeof longShotModule.setup>, id: string, now = 0) =>
  longShotModule.playerView(state, id, context(now)) as PlayerView;

const answer = (
  state: ReturnType<typeof longShotModule.setup>,
  playerId: string,
  text: string,
  now: number,
  opts = {},
) =>
  longShotModule.onMove(state, { playerId, type: "answer", payload: { text } }, context(now, opts));

describe("long shot matcher", () => {
  const fruit = compilePrompt(LONG_SHOT_BANK[0]);

  it("normalizes case, articles, plurals and accents", () => {
    expect(normalizeAnswer("  The Bananas! ")).toBe("banana");
    expect(normalizeAnswer("Crème")).toBe("creme");
    expect(normalizeAnswer("C++")).not.toBe(normalizeAnswer("C"));
  });

  it("matches aliases and small typos, and rejects unknown answers", () => {
    expect(matchAnswer(fruit, "litchi")?.display).toBe("Lychee");
    expect(matchAnswer(fruit, "pomegranit")?.display).toBe("Pomegranate");
    expect(matchAnswer(fruit, "durian")?.tier).toBe("longShot");
    expect(matchAnswer(fruit, "apple")?.tier).toBe("obvious");
    expect(matchAnswer(fruit, "carrot")).toBeNull();
    expect(matchAnswer(fruit, "fog")).toBeNull();
  });

  it("only accepts sports that are actually played with a ball", () => {
    const sports = compilePrompt(LONG_SHOT_BANK.find((p) => p.prompt === "Name a sport played with a ball")!);
    for (const notBall of ["Kabaddi", "Roller derby", "Badminton"]) {
      expect(matchAnswer(sports, notBall)).toBeNull();
    }
    expect(matchAnswer(sports, "Hurling")?.tier).toBe("longShot");
  });

  it("ships a bank where every prompt has a deep list in every tier", () => {
    for (const raw of LONG_SHOT_BANK) {
      const compiled = compilePrompt(raw);
      expect(compiled.answers.length).toBeGreaterThanOrEqual(30);
      for (const tier of ["obvious", "solid", "rare", "longShot"] as const) {
        expect(compiled.answers.some((a) => a.tier === tier)).toBe(true);
      }
    }
  });
});

describe("long shot classic", () => {
  const started = () =>
    longShotModule.onTick!(
      longShotModule.onMove(
        longShotModule.setup(context(0)),
        { playerId: "host", type: "start", payload: undefined },
        context(1_000),
      ),
      context(4_000),
    );

  it("starts in the lobby and only the host can start", () => {
    const state = longShotModule.setup(context(0));
    expect(pub(state).phase).toBe("lobby");
    expect(pub(state).prompt).toBeNull();
    expect(() =>
      longShotModule.onMove(state, { playerId: "p2", type: "start", payload: undefined }, context(0)),
    ).toThrow(GameMoveError);
  });

  it("shows each prompt for a three-second countdown before the clock starts", () => {
    const ready = longShotModule.onMove(
      longShotModule.setup(context(0)),
      { playerId: "host", type: "start", payload: undefined },
      context(1_000),
    );
    expect(pub(ready, 1_000).phase).toBe("ready");
    expect(pub(ready, 1_000).prompt).toBe("Name a fruit");
    expect(() => answer(ready, "host", "Durian", 2_000)).toThrow("Get ready");
    expect(longShotModule.onTick!(ready, context(3_999)).phase).toBe("ready");
    const live = longShotModule.onTick!(ready, context(4_000));
    expect(live.phase).toBe("prompt");
    expect(pub(live, 4_000).deadline).toBe(29_000);
  });

  it("keeps a player's answer private until the reveal", () => {
    const state = answer(started(), "host", "Durian", 5_000);
    expect(me(state, "host").answer).toEqual({ text: "Durian", tier: "longShot", points: 1000 });
    const view = JSON.stringify(pub(state));
    expect(view).not.toContain("Durian");
    expect(pub(state).tiles.host).toEqual({ acted: true });
  });

  it("clears a wrong answer and lets the player keep trying until the clock runs out", () => {
    let state = started();
    for (let i = 0; i < 6; i++) state = answer(state, "p2", `nope ${i}`, 5_000);
    expect(me(state, "p2").locked).toBe(false);
    expect(me(state, "p2").lastMiss).toMatchObject({ reason: "unknown" });
    state = answer(state, "p2", "Apple", 6_000);
    expect(me(state, "p2").answer).toMatchObject({ text: "Apple", points: 100 });
    expect(() => answer(state, "p2", "Durian", 7_000)).toThrow("You already locked in");
  });

  it("scores each answer by its tier alone", () => {
    let state = started();
    state = answer(state, "host", "Durian", 5_000);
    state = answer(state, "p2", "Apple", 5_000);
    state = answer(state, "p3", "apples", 5_000);
    state = longShotModule.onTick!(state, context(5_000));
    const view = pub(state, 5_000);
    expect(view.phase).toBe("reveal");
    const byId = Object.fromEntries(view.results.map((r) => [r.id, r]));
    expect(byId.host).toMatchObject({ answer: "Durian", points: 1000 });
    expect(byId.p2).toMatchObject({ answer: "Apple", points: 100 });
    expect(byId.p3).toMatchObject({ answer: "Apple", points: 100 });
    expect(view.scoreboard[0]).toEqual({ id: "host", name: "Host", score: 1000 });
    expect(view.tiles.host).toEqual({ outcome: "correct", note: "1000m" });
    expect((view.missedGems as string[]).includes("Durian")).toBe(false);
  });

  it("rejects answers that arrive after the clock runs out", () => {
    expect(() => answer(started(), "host", "Durian", 29_000)).toThrow("Time's up");
  });

  it("walks every prompt to the results", () => {
    let state = started();
    let now = 4_000;
    for (let i = 0; i < 3; i++) {
      now += 30_000;
      state = longShotModule.onTick!(state, context(now));
      expect(state.phase).toBe("reveal");
      now += 10_000;
      state = longShotModule.onTick!(state, context(now));
      if (state.phase === "ready") {
        now += 3_000;
        state = longShotModule.onTick!(state, context(now));
      }
    }
    expect(state.phase).toBe("results");
    expect(longShotModule.isFinished!(state)).toBe(true);
  });
});

describe("long shot fuse", () => {
  const fuseConfig: GameConfig = { mode: "fuse", prompts: 7, lives: 1, pace: "normal" };
  const started = (opts: { activePlayers?: GamePlayer[] } = {}) =>
    longShotModule.onMove(
      longShotModule.setup(context(0, { config: fuseConfig })),
      { playerId: "host", type: "start", payload: undefined },
      context(1_000, { config: fuseConfig, ...opts }),
    );

  it("passes the fuse on a valid answer and rejects repeats without passing", () => {
    let state = started();
    expect(pub(state).turnPlayerId).toBe("host");
    expect(() => answer(state, "p2", "Apple", 1_500)).toThrow("Not your turn");
    state = answer(state, "host", "Apple", 2_000);
    expect(pub(state).turnPlayerId).toBe("p2");
    expect(me(state, "p2").yourTurn).toBe(true);
    state = answer(state, "p2", "apple", 2_500);
    expect(pub(state).turnPlayerId).toBe("p2");
    expect(pub(state).lastMiss).toMatchObject({ reason: "used", name: "Pat" });
    state = answer(state, "p2", "kumquat", 3_000);
    expect(pub(state).turnPlayerId).toBe("p3");
    expect(pub(state).scoreboard.find((r) => r.id === "p2")?.score).toBe(1000);
  });

  it("pops the holder when the fuse runs out and ends with the last one standing", () => {
    let state = started();
    state = longShotModule.onTick!(state, context(20_000, { config: fuseConfig }));
    expect(state.phase).toBe("popped");
    expect(pub(state).seats.find((s) => s.id === "host")?.out).toBe(true);
    state = longShotModule.onTick!(state, context(30_000, { config: fuseConfig }));
    expect(state.phase).toBe("fuse");
    expect(pub(state).turnPlayerId).toBe("p2");
    state = longShotModule.onTick!(state, context(60_000, { config: fuseConfig }));
    state = longShotModule.onTick!(state, context(70_000, { config: fuseConfig }));
    expect(state.phase).toBe("results");
    const view = pub(state);
    expect(view.winnerId).toBe("p3");
    expect(view.scoreboard[0]).toMatchObject({ id: "p3", score: 2000 });
    expect(view.tiles.p3).toMatchObject({ winner: true });
  });

  it("passes over a disconnected holder without costing them a life", () => {
    const connected = players.filter((p) => p.id !== "p2");
    let state = answer(started(), "host", "Apple", 2_000);
    expect(pub(state).turnPlayerId).toBe("p2");
    state = longShotModule.onTick!(state, context(2_500, { config: fuseConfig, activePlayers: connected }));
    expect(pub(state).turnPlayerId).toBe("p3");
    expect(pub(state).seats.find((s) => s.id === "p2")?.lives).toBe(1);
  });

  it("rejects a fuse answer that arrives after the fuse burned out", () => {
    const state = started();
    expect(() => answer(state, "host", "Apple", 11_000)).toThrow("Time's up");
  });

  it("lets a departed player forfeit so the connected survivor wins", () => {
    const twoPlayers = players.slice(0, 2);
    const cfg = { config: fuseConfig, roster: twoPlayers };
    let state = longShotModule.onMove(
      longShotModule.setup(context(0, cfg)),
      { playerId: "host", type: "start", payload: undefined },
      context(1_000, cfg),
    );
    state = answer(state, "host", "Apple", 2_000, cfg);
    const hostOnly = { ...cfg, activePlayers: [players[0]] };
    state = longShotModule.onTick!(state, context(2_500, hostOnly));
    expect(pub(state, 2_500, hostOnly).paused).toBe(true);
    state = longShotModule.onTick!(state, context(20_000, hostOnly));
    expect(state.phase).toBe("fuse");
    state = longShotModule.onTick!(state, context(33_000, hostOnly));
    expect(state.phase).toBe("results");
    expect(pub(state, 33_000, hostOnly).winnerId).toBe("host");
  });

  it("ends with no winner once every survivor has left", () => {
    let state = started();
    const nobody = { config: fuseConfig, activePlayers: [] as GamePlayer[] };
    state = longShotModule.onTick!(state, context(2_000, nobody));
    state = longShotModule.onTick!(state, context(40_000, nobody));
    expect(state.phase).toBe("results");
    expect(pub(state, 40_000, nobody).winnerId).toBeNull();
  });

  it("pauses the fuse while the only connected survivor is away and resumes it on return", () => {
    const twoPlayers = players.slice(0, 2);
    const cfg = { config: fuseConfig, roster: twoPlayers };
    let state = longShotModule.onMove(
      longShotModule.setup(context(0, cfg)),
      { playerId: "host", type: "start", payload: undefined },
      context(1_000, cfg),
    );
    const away = { ...cfg, activePlayers: [] as GamePlayer[] };
    state = longShotModule.onTick!(state, context(9_000, away));
    expect(pub(state, 9_000, away).paused).toBe(true);
    state = longShotModule.onTick!(state, context(20_000, cfg));
    expect(state.phase).toBe("fuse");
    expect(pub(state, 20_000, cfg).deadline).toBeNull();
    expect(state.deadline).toBe(23_000);
    state = longShotModule.onTick!(state, context(21_000, cfg));
    expect(state.phase).toBe("fuse");
    expect(pub(state, 21_000, cfg).seats.find((s) => s.id === "host")?.lives).toBe(1);
  });

  it("shares one hidden fuse across passes in a round", () => {
    let state = started();
    const fuseEnds = state.deadline;
    expect(pub(state).deadline).toBeNull();
    state = answer(state, "host", "Apple", 2_000);
    state = answer(state, "p2", "Kumquat", 3_000);
    expect(state.deadline).toBe(fuseEnds);
    expect(pub(state).turnPlayerId).toBe("p3");
  });

  it("draws the fuse length at random within the pace range", () => {
    const longRng: GameRng = { ...rng, int: (max) => max - 1 };
    const state = longShotModule.onMove(
      longShotModule.setup({ ...context(0, { config: fuseConfig }), rng: longRng }),
      { playerId: "host", type: "start", payload: undefined },
      { ...context(1_000, { config: fuseConfig }), rng: longRng },
    );
    expect(state.deadline).toBe(1_000 + 30_000);
    expect(started().deadline).toBe(1_000 + 10_000);
  });

  it("earns an extra heart for every 600 points of rare answers, up to five", () => {
    const solo = [players[0]];
    const cfg = { config: { ...fuseConfig, lives: 1 }, roster: solo };
    let state = longShotModule.onMove(
      longShotModule.setup(context(0, cfg)),
      { playerId: "host", type: "start", payload: undefined },
      context(1_000, cfg),
    );
    for (const [i, fruit] of ["Durian", "Rambutan", "Mangosteen", "Jackfruit", "Quince", "Kumquat"].entries()) {
      state = answer(state, "host", fruit, 1_100 + i, cfg);
    }
    const seat = pub(state, 2_000, cfg).seats.find((s) => s.id === "host");
    expect(seat).toMatchObject({ lives: 2, meter: 0 });
    expect(pub(state, 2_000, cfg).lastHeart).toMatchObject({ playerId: "host" });
  });

  it("does not allow joining mid-game in fuse mode", () => {
    const resolver = longShotModule.lateJoinPhases as (s: unknown, c: GameContext) => string[];
    expect(resolver(started(), context(0, { config: fuseConfig }))).toEqual([]);
  });
});

describe("long shot generated prompts", () => {
  const tier = (name: string, size: number) => Array.from({ length: size }, (_, i) => `${name} ${i}`);
  const prompt = (sizes: [number, number, number, number]) => ({
    category: "Custom",
    prompt: "Name a thing",
    obvious: tier("obvious", sizes[0]),
    solid: tier("solid", sizes[1]),
    rare: tier("rare", sizes[2]),
    longShot: tier("long shot", sizes[3]),
  });

  it("accepts a prompt that meets every tier minimum exactly", () => {
    expect(parseLongShotPrompts({ prompts: [prompt([3, 4, 5, 6])] })).toHaveLength(1);
  });

  it("rejects a prompt below any tier minimum", () => {
    expect(parseLongShotPrompts({ prompts: [prompt([3, 4, 5, 5])] })).toBeNull();
    expect(parseLongShotPrompts({ prompts: [prompt([2, 4, 5, 6])] })).toBeNull();
  });
});

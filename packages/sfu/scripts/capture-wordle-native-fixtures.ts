import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameSession } from "../server/games/engine.js";
import { wordleModule } from "../server/games/modules/wordle.js";
import { GameMoveError, type GameConfig, type GameContext, type GamePlayer } from "../server/games/types.js";
import { WORDLE_WORDS } from "../server/games/wordleWordList.js";

// Records what the real Wordle engine sends native clients, so the native projection tests parse server output
// instead of hand-typed payloads. Run from the repo root:
//   npx tsx packages/sfu/scripts/capture-wordle-native-fixtures.ts          (rewrite the fixture)
//   npx tsx packages/sfu/scripts/capture-wordle-native-fixtures.ts --check  (exit 1 when the engine drifted)

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/conclave-skip/Tests/ConclaveTests/Resources/WordleServerViews.json",
);

let clock = 1_800_000_000_000;
Date.now = () => clock;

const ava: GamePlayer = { id: "ava", name: "Ava" };
const ben: GamePlayer = { id: "ben", name: "Ben" };
const cam: GamePlayer = { id: "cam", name: "Cam" };
const dee: GamePlayer = { id: "dee", name: "Dee" };
const SEATED = [ava, ben, cam];
const ROOM = [...SEATED, dee];
const HOST = ava.id;

const WORD_SET = new Set(WORDLE_WORDS);
const COMMON = ["CRANE", "SLATE", "PIANO", "GHOST", "MOUNT", "FLAIR", "TRICK", "WORLD", "PLANT", "STORM", "QUEEN", "BLUSH"]
  .filter((word) => WORD_SET.has(word));

type Probe = { ok: boolean; error: string | null };
type Step = {
  label: string;
  now: number;
  move: { playerId: string; type: string; payload: unknown; ok: boolean; error: string | null } | null;
  state: unknown;
  views: Record<string, unknown>;
  accepts: Record<string, { guess: Probe; passTurn: Probe }>;
};

type Internals = {
  state: { targetWord: string | null; setterId: string | null; team: { guesses: { word: string }[] } | null;
    players: Record<string, { guesses: { word: string }[] }> };
  context(now: number): GameContext;
};

class Run {
  readonly steps: Step[] = [];
  private readonly session: GameSession;
  private readonly internals: Internals;

  constructor(readonly name: string, readonly config: GameConfig) {
    clock = 1_800_000_000_000;
    this.session = new GameSession({ module: wordleModule, players: SEATED, adminIds: [HOST], hostId: HOST, config, seed: 7 });
    this.internals = this.session as unknown as Internals;
  }

  get target(): string {
    const word = this.internals.state.targetWord;
    if (!word) throw new Error(`${this.name}: no target word yet`);
    return word;
  }

  get setterId(): string {
    const id = this.internals.state.setterId;
    if (!id) throw new Error(`${this.name}: no setter`);
    return id;
  }

  wrong(index: number): string {
    const used = new Set(this.guessedWords());
    const candidates = COMMON.filter((word) => word !== this.internals.state.targetWord && !used.has(word));
    const word = candidates[index % candidates.length];
    if (!word) throw new Error(`${this.name}: ran out of wrong words`);
    return word;
  }

  record(label: string, move: Step["move"] = null): this {
    const views: Step["views"] = {};
    const accepts: Step["accepts"] = {};
    for (const viewer of ROOM) {
      views[viewer.id] = this.session.getPlayerView(viewer.id, clock);
      accepts[viewer.id] = {
        guess: this.probe(viewer.id, "guess", { word: this.probeWord(viewer.id) }),
        passTurn: this.probe(viewer.id, "passTurn", undefined),
      };
    }
    this.steps.push({ label, now: clock, move, state: this.session.getPublicState(clock), views, accepts });
    return this;
  }

  play(label: string | null, playerId: string, type: string, payload: unknown = undefined, expectOk = true): this {
    clock += 1_000;
    const result = this.session.applyMove(playerId, type, payload);
    const error = result.ok ? null : result.error;
    if (result.ok !== expectOk) {
      throw new Error(`${this.name}: ${playerId} ${type} expected ${expectOk ? "success" : "rejection"}, got ${error ?? "success"}`);
    }
    if (label) this.record(label, { playerId, type, payload: payload ?? null, ok: result.ok, error });
    return this;
  }

  wait(label: string | null, millis: number): this {
    clock += millis;
    this.session.tick(clock);
    if (label) this.record(label);
    return this;
  }

  present(label: string | null, players: GamePlayer[]): this {
    this.session.updateRoomMembership({ players, adminIds: [HOST] });
    clock += 500;
    this.session.tick(clock);
    if (label) this.record(label);
    return this;
  }

  private guessedWords(): string[] {
    const state = this.internals.state;
    if (state.team) return state.team.guesses.map((guess) => guess.word);
    return Object.values(state.players).flatMap((board) => board.guesses.map((guess) => guess.word));
  }

  private probeWord(playerId: string): string {
    const state = this.internals.state;
    const mine = state.team ? state.team.guesses : state.players[playerId]?.guesses ?? [];
    const used = new Set(mine.map((guess) => guess.word));
    return WORDLE_WORDS.find((word) => word !== state.targetWord && !used.has(word)) ?? WORDLE_WORDS[0];
  }

  private probe(playerId: string, type: string, payload: unknown): Probe {
    if (!this.session.hasPlayer(playerId)) return { ok: false, error: "You are not a player in this game" };
    try {
      wordleModule.onMove(this.internals.state as never, { playerId, type, payload }, this.internals.context(clock));
      return { ok: true, error: null };
    } catch (error) {
      if (error instanceof GameMoveError) return { ok: false, error: error.message };
      throw error;
    }
  }
}

const soloRandom = (): Run => {
  const run = new Run("solo-random", { mode: "solo", wordSource: "random", rounds: 1, timeLimitMinutes: 3 });
  run.record("lobby").play("started", HOST, "start");
  run.play("ava-guessed", ava.id, "guess", { word: run.wrong(0) });
  run.play("ben-guessed", ben.id, "guess", { word: run.wrong(1) });
  run.play("ava-solved", ava.id, "guess", { word: run.target });
  for (let index = 2; index < 7; index += 1) run.play(null, ben.id, "guess", { word: run.wrong(index) });
  run.record("ben-out-of-tries");
  return run.wait("cam-timed-out", 3 * 60_000);
};

const soloSetter = (): Run => {
  const run = new Run("solo-setter", { mode: "solo", wordSource: "setter", rounds: 2, timeLimitMinutes: 3 });
  run.record("lobby").play("choosing-word", HOST, "start");
  const setter = run.setterId;
  const guessers = SEATED.filter((player) => player.id !== setter);
  run.play("word-set", setter, "setWord", { word: "LEMON" });
  run.play("first-guess", guessers[0].id, "guess", { word: run.wrong(0) });
  run.play(null, guessers[1].id, "guess", { word: run.target });
  run.play("round-one-results", guessers[0].id, "guess", { word: run.target });
  run.play("round-two-choosing", HOST, "nextRound");
  return run.play("round-two-word-set", run.setterId, "setWord", { word: "CRANE" }).wait("final-results", 3 * 60_000);
};

const relayRandom = (): Run => {
  const run = new Run("relay-random", { mode: "relay", turnSeconds: 30, wordSource: "random", rounds: 2, timeLimitMinutes: 5 });
  run.record("lobby").play("ava-turn", HOST, "start");
  run.play("ben-out-of-turn", ben.id, "guess", { word: run.wrong(0) }, false);
  run.play("ben-turn", ava.id, "guess", { word: run.wrong(0) });
  run.play("ben-passed", ben.id, "passTurn");
  run.wait("cam-turn-expired", 30_000);
  run.present("ava-away", [ben, cam, dee]);
  run.wait("ava-skipped", 5_000);
  run.present("ava-back", ROOM);
  run.play("team-solved", ben.id, "guess", { word: run.target });
  run.play("round-two-cam-starts", HOST, "nextRound");
  run.present("cam-alone", [cam, dee]);
  run.present(null, ROOM);
  const rotation = [cam, ava, ben, cam, ava, ben];
  rotation.slice(0, 5).forEach((player, index) => run.play(null, player.id, "guess", { word: run.wrong(index) }));
  run.record("one-try-left");
  return run.play("team-out-of-tries", ben.id, "guess", { word: run.wrong(5) });
};

const relaySetter = (): Run => {
  const run = new Run("relay-setter", { mode: "relay", turnSeconds: 45, wordSource: "setter", rounds: 1, timeLimitMinutes: 3 });
  run.record("lobby").play("choosing-word", HOST, "start");
  run.play("word-set", run.setterId, "setWord", { word: "LEMON" });
  const first = SEATED.filter((player) => player.id !== run.setterId)[0];
  return run.play("first-guess", first.id, "guess", { word: run.wrong(0) });
};

const huddleSetter = (): Run => {
  const run = new Run("huddle-setter", { mode: "huddle", wordSource: "setter", rounds: 1, timeLimitMinutes: 3 });
  run.record("lobby").play("choosing-word", HOST, "start");
  const setter = run.setterId;
  const guessers = SEATED.filter((player) => player.id !== setter);
  run.play("word-set", setter, "setWord", { word: "LEMON" });
  const first = run.wrong(0);
  run.play("first-guess", guessers[0].id, "guess", { word: first });
  run.play("duplicate-guess", guessers[1].id, "guess", { word: first }, false);
  return run.play("team-solved", guessers[1].id, "guess", { word: run.target });
};

const huddleTimeout = (): Run => {
  const run = new Run("huddle-timeout", { mode: "huddle", wordSource: "random", rounds: 1, timeLimitMinutes: 1 });
  run.record("lobby").play("playing", HOST, "start");
  run.play("cam-guessed", cam.id, "guess", { word: run.wrong(0) });
  return run.wait("time-ran-out", 60_000);
};

const catalogEntry = {
  id: wordleModule.id,
  name: wordleModule.name,
  description: wordleModule.description,
  minPlayers: wordleModule.minPlayers,
  maxPlayers: wordleModule.maxPlayers,
  options: wordleModule.options ?? [],
  hasLeaderboard: Boolean(wordleModule.hasLeaderboard),
};

const runs = [soloRandom(), soloSetter(), relayRandom(), relaySetter(), huddleSetter(), huddleTimeout()];

const lines: string[] = [];
lines.push("{");
lines.push(`  "generatedBy": "packages/sfu/scripts/capture-wordle-native-fixtures.ts",`);
lines.push(`  "hostId": ${JSON.stringify(HOST)},`);
lines.push(`  "room": ${JSON.stringify(ROOM)},`);
lines.push(`  "catalog": ${JSON.stringify(catalogEntry)},`);
lines.push(`  "scenarios": [`);
runs.forEach((run, runIndex) => {
  lines.push(`    {"name": ${JSON.stringify(run.name)}, "config": ${JSON.stringify(run.config)}, "steps": [`);
  run.steps.forEach((step, stepIndex) => {
    lines.push(`      ${JSON.stringify(step)}${stepIndex < run.steps.length - 1 ? "," : ""}`);
  });
  lines.push(`    ]}${runIndex < runs.length - 1 ? "," : ""}`);
});
lines.push("  ]");
lines.push("}");
const output = `${lines.join("\n")}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUTPUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== output) {
    console.error(`${OUTPUT} is stale. Rerun without --check to refresh it.`);
    process.exit(1);
  }
  console.log(`${OUTPUT} matches the engine.`);
} else {
  writeFileSync(OUTPUT, output);
  const steps = runs.reduce((total, run) => total + run.steps.length, 0);
  console.log(`Wrote ${runs.length} scenarios, ${steps} steps to ${OUTPUT}`);
}
